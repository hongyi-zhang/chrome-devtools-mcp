/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

interface ReplayStep {
  kind: 'click' | 'fill' | 'select' | 'press' | 'waitFor';
  selectors: {
    css?: string;
    cssFallbacks?: string[];
    xpath?: string;
    aria?: {role?: string; name?: string};
    shadowPiercePath?: string[];
  };
  value?: string;
  framePath?: string[];
  doneWhen?: {
    selectorVisible?: string;
    urlMatches?: string;
    textPresent?: {selector: string; includes: string};
  };
  notes?: string;
  confidence?: number;
}

interface ReplayPlan {
  version: 'v1';
  userAgent?: string;
  viewport?: {width: number; height: number; deviceScaleFactor?: number};
  startUrl?: string;
  steps: ReplayStep[];
}

interface Args {
  plan?: string;
  url?: string;
  stepTimeoutMs?: number;
  headless?: boolean;
  slowMo?: number;
  devtools?: boolean;
  screenshot?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {headless: true};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') out.plan = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--timeout' || a === '--stepTimeoutMs') out.stepTimeoutMs = Number(argv[++i]);
    else if (a === '--headful') out.headless = false;
    else if (a === '--headless') out.headless = true;
    else if (a === '--slowMo') out.slowMo = Number(argv[++i]);
    else if (a === '--devtools') out.devtools = true;
    else if (a === '--screenshot') out.screenshot = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.plan) {
    console.error('Usage: node --experimental-strip-types scripts/replay-webview.ts --plan <replay.json> [--url <start>] [--timeout 8000] [--headful] [--slowMo 50] [--devtools] [--screenshot <path>]');
    process.exit(1);
  }
  const planPath = path.resolve(args.plan);
  const plan: ReplayPlan = JSON.parse(await fs.readFile(planPath, 'utf-8'));
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    console.error('Invalid plan: steps missing or empty');
    process.exit(1);
  }
  const startUrl = args.url || plan.startUrl;
  if (!startUrl) {
    console.error('No start URL provided. Pass --url or include startUrl in plan.');
    process.exit(1);
  }
  const browser = await puppeteer.launch({
    headless: args.headless,
    devtools: args.devtools,
    slowMo: args.slowMo,
  });
  const page = await browser.newPage();
  if (plan.userAgent) await page.setUserAgent(plan.userAgent);
  if (plan.viewport) await page.setViewport({
    width: plan.viewport.width,
    height: plan.viewport.height,
    deviceScaleFactor: plan.viewport.deviceScaleFactor ?? 1,
  });
  const replayJsPath = path.resolve('webview/replay.js');
  const runtime = await fs.readFile(replayJsPath, 'utf-8');
  // Ensure the runtime is injected on every new document (Puppeteer API)
  await page.evaluateOnNewDocument((src: string) => {
    try { (0, eval)(src); } catch {}
  }, runtime);
  // Navigate to start URL, then inject for the current document
  try {
    await page.goto(startUrl, {waitUntil: 'networkidle2'});
  } catch {
    await page.goto(startUrl, {waitUntil: 'load'});
  }
  await page.addScriptTag({content: runtime});

  const stepTimeoutMs = args.stepTimeoutMs ?? 8000;

  async function ensureRuntime(): Promise<void> {
    try {
      const ok = await page.evaluate(() => {
        // @ts-ignore
        return typeof window !== 'undefined' && typeof (window as any).MCPReplay === 'object';
      });
      if (!ok) {
        await page.addScriptTag({content: runtime}).catch(() => {});
      }
    } catch {
      // New document context; add runtime for current doc
      await page.addScriptTag({content: runtime}).catch(() => {});
    }
  }

  const results: Array<{ok: boolean; error?: string; via?: string; alternativeReason?: string | null}> = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    await ensureRuntime();
    let navHappened = false;
    const waitNav = page
      .waitForNavigation({waitUntil: 'load', timeout: stepTimeoutMs})
      .then(() => {
        navHappened = true;
      })
      .catch(() => {});
    try {
      const stepRes = await page.evaluate(
        (s, timeout) => {
          // @ts-ignore
          return window.MCPReplay.replay([s], {stepTimeoutMs: timeout});
        },
        step,
        stepTimeoutMs,
      );
      const r = Array.isArray(stepRes) ? stepRes[0] : stepRes;
      results.push(r && typeof r === 'object' ? r : {ok: true, via: 'single'});
    } catch (err) {
      // Likely navigation destroyed the execution context
      await waitNav;
      await ensureRuntime();
      let ok = false;
      if (step && step.doneWhen && step.doneWhen.urlMatches) {
        try {
          ok = await page.evaluate((pattern: string) => {
            try { return new RegExp(pattern).test(location.href); } catch { return false; }
          }, step.doneWhen.urlMatches);
        } catch {
          ok = false;
        }
      }
      if (!ok && navHappened) {
        // If we navigated but no explicit doneWhen, consider it a soft success
        ok = true;
      }
      results.push(ok ? {ok: true, via: 'nav-recovered'} : {ok: false, error: String((err as Error)?.message || err)});
    }
    // Ensure any pending navigation promise is settled before next step
    await waitNav;
  }
  let okCount = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.ok) okCount++;
    // eslint-disable-next-line no-console
    console.log(`#${i} ${r && r.ok ? 'OK' : 'ERR'}${r && r.via ? ' via='+r.via : ''}${r && r.alternativeReason ? ' '+r.alternativeReason : ''}${r && r.error ? ' - '+r.error : ''}`);
  }
  // eslint-disable-next-line no-console
  console.log(`Summary: ${okCount}/${results.length} steps succeeded.`);
  // Attempt to settle the page before taking the final screenshot
  try {
    // 1) Ensure load complete (SPA may already be loaded; this is best-effort)
    try {
      await page.waitForFunction(() => document.readyState === 'complete', {timeout: 3000});
    } catch {}
    // 2) Wait for network to be idle briefly
    try {
      await page.waitForNetworkIdle({idleTime: 800, timeout: 5000} as any);
    } catch {}
    // 3) Wait for fonts to be ready (if supported)
    try {
      await page.evaluate(async () => {
        try {
          // @ts-ignore
          if (document.fonts && document.fonts.ready) { await (document.fonts as any).ready; }
        } catch {}
      });
    } catch {}
    // 4) Observe DOM for a quiet window (few hundred ms without mutations)
    try {
      await page.evaluate((quietMs: number, timeoutMs: number) => {
        return new Promise<void>(resolve => {
          let done = false;
          let quietTimer: any;
          const timeout = setTimeout(() => { if (!done) { done = true; obs.disconnect(); resolve(); } }, timeoutMs);
          const finish = () => { if (!done) { done = true; clearTimeout(timeout); obs.disconnect(); resolve(); } };
          const obs = new MutationObserver(() => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, quietMs);
          });
          try { obs.observe(document, {subtree: true, childList: true, attributes: true, characterData: true}); } catch {}
          quietTimer = setTimeout(finish, quietMs);
        });
      }, 600, 4000);
    } catch {}
    // 5) Progressive scroll to trigger lazy content, then return to top
    try {
      await page.evaluate(() => {
        return new Promise<void>(resolve => {
          const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
          (async () => {
            const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
            const max = Math.max(
              document.documentElement ? document.documentElement.scrollHeight : 0,
              document.body ? document.body.scrollHeight : 0,
            );
            let y = 0;
            while (y < max) {
              window.scrollTo(0, y);
              // Give intersection observers time to load
              // @ts-ignore
              await delay(80);
              y += step;
            }
            window.scrollTo(0, 0);
            // Small delay to settle layout at top
            // @ts-ignore
            await delay(80);
            resolve();
          })();
        });
      });
    } catch {}
  } catch {}
  // Take a final screenshot for inspection before closing
  try {
    const targetPath = args.screenshot ? path.resolve(args.screenshot) : path.resolve('examples/replay-final.png');
    try { await fs.mkdir(path.dirname(targetPath), {recursive: true}); } catch {}
    const outPath = /\.(png|jpe?g|webp)$/i.test(targetPath) ? targetPath : targetPath + '.png';
    await page.screenshot({path: outPath as `${string}.png`, fullPage: true});
    // eslint-disable-next-line no-console
    console.log(`Saved screenshot: ${targetPath}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('Failed to save screenshot:', (e as Error)?.message || e);
  }
  await browser.close();
  if (okCount !== results.length) process.exit(2);
}

void main();


