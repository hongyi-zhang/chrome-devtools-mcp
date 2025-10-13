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
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.plan) {
    console.error('Usage: node --experimental-strip-types scripts/replay-webview.ts --plan <replay.json> [--url <start>] [--timeout 8000] [--headful] [--slowMo 50] [--devtools]');
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
  await page.goto(startUrl, {waitUntil: 'domcontentloaded'});
  const replayJsPath = path.resolve('webview/replay.js');
  const runtime = await fs.readFile(replayJsPath, 'utf-8');
  await page.addScriptTag({content: runtime});
  const stepTimeoutMs = args.stepTimeoutMs ?? 8000;
  const results = await page.evaluate(
    (steps, timeout) => {
      // @ts-ignore
      return window.MCPReplay.replay(steps, {stepTimeoutMs: timeout});
    },
    plan.steps,
    stepTimeoutMs,
  );
  let okCount = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.ok) okCount++;
    // eslint-disable-next-line no-console
    console.log(`#${i} ${r && r.ok ? 'OK' : 'ERR'}${r && r.via ? ' via='+r.via : ''}${r && r.alternativeReason ? ' '+r.alternativeReason : ''}${r && r.error ? ' - '+r.error : ''}`);
  }
  // eslint-disable-next-line no-console
  console.log(`Summary: ${okCount}/${results.length} steps succeeded.`);
  await browser.close();
  if (okCount !== results.length) process.exit(2);
}

void main();


