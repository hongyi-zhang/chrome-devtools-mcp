/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';

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
  // Hints to help replay engines diagnose instability and try fallbacks.
  stabilityHints?: {
    idLooksDynamic?: boolean;
    hasXPath?: boolean;
    usesAria?: boolean;
    shadowPiercing?: boolean;
  };
  // Optional alternative selector bundles to try on failure (in order)
  alternatives?: Array<{
    selectors: ReplayStep['selectors'];
    reason?: string;
  }>;
}

interface ReplayPlan {
  version: 'v1';
  userAgent?: string;
  viewport?: {width: number; height: number; deviceScaleFactor?: number};
  startUrl?: string;
  steps: ReplayStep[];
}

interface Args {
  in?: string;
  out?: string;
  limit?: number;
  domain?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--in') out.in = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--domain') out.domain = argv[++i];
  }
  return out;
}

async function readNdjson(file: string): Promise<any[]> {
  const raw = await fs.readFile(file, 'utf-8');
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

function scoreSelectorBundle(sel: any): {primary: ReplayStep['selectors']; confidence: number} {
  let confidence = 0.5;
  const primary: ReplayStep['selectors'] = {};
  if (sel?.css) {
    primary.css = sel.css;
    confidence = 0.7;
    if (/data-(test|qa|e2e)/i.test(sel.css)) confidence = 0.95;
    else if (/^#[-a-zA-Z0-9_]+$/.test(sel.css)) confidence = 0.9;
  }
  if (sel?.cssFallbacks?.length) {
    const fallbacks = Array.from(new Set(sel.cssFallbacks as string[])).filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    primary.cssFallbacks = fallbacks;
    // If we didn't have a primary css, try the first fallback as primary.
    if (!primary.css && fallbacks.length) {
      primary.css = fallbacks[0];
      confidence = Math.max(confidence, 0.6);
    }
  }
  if (!primary.css && sel?.xpath) {
    primary.xpath = sel.xpath;
    confidence = Math.max(confidence, 0.4);
  }
  if (sel?.aria) {
    primary.aria = sel.aria;
    confidence = Math.max(confidence, 0.6);
  }
  if (sel?.shadowPiercePath) {
    primary.shadowPiercePath = sel.shadowPiercePath;
  }
  return {primary, confidence};
}

function groupBySession(records: any[]): Record<string, any[]> {
  const map: Record<string, any[]> = {};
  for (const r of records) {
    const sid = r.sessionId || 'default';
    if (!map[sid]) map[sid] = [];
    map[sid].push(r);
  }
  for (const sid of Object.keys(map)) {
    map[sid].sort((a, b) => (a.timeStart ?? 0) - (b.timeStart ?? 0));
  }
  return map;
}

function toReplay(records: any[], limit?: number): ReplayPlan {
  const groups = groupBySession(records);
  // Pick the latest session by last timeEnd
  let chosen: any[] = [];
  let bestEnd = -1;
  for (const sid of Object.keys(groups)) {
    const arr = groups[sid];
    const end = arr[arr.length - 1]?.timeEnd ?? 0;
    if (end > bestEnd) {
      bestEnd = end;
      chosen = arr;
    }
  }
  const stepsIn = chosen.slice(0, limit ?? chosen.length);
  const out: ReplayPlan = {version: 'v1', steps: []};
  // Compute a best-effort starting URL from the earliest page URL in this session.
  for (const r of stepsIn) {
    if (r?.page?.url && !out.startUrl) {
      out.startUrl = r.page.url;
      break;
    }
  }
  // Attempt to carry through user agent and viewport if present on any record (best-effort; optional)
  for (const r of stepsIn) {
    if (!out.userAgent && r?.env?.userAgent) out.userAgent = r.env.userAgent;
    if (!out.viewport && r?.env?.viewport?.width && r?.env?.viewport?.height) {
      out.viewport = {
        width: Number(r.env.viewport.width) || 0,
        height: Number(r.env.viewport.height) || 0,
        deviceScaleFactor: r.env.viewport.deviceScaleFactor,
      };
    }
  }
  for (const rec of stepsIn) {
    const kind = rec.action?.name;
    if (!kind) continue;
    const {primary, confidence} = scoreSelectorBundle(rec.selector);
    const step: ReplayStep = {
      kind,
      selectors: primary,
      value: rec.action?.params?.value,
      framePath: rec.framePath ?? [],
      confidence,
    };
    // Stability hints
    step.stabilityHints = {
      idLooksDynamic: Boolean(primary.css && /[#.][a-zA-Z]+-\d{3,}/.test(primary.css)),
      hasXPath: Boolean(primary.xpath),
      usesAria: Boolean(primary.aria),
      shadowPiercing: Boolean(primary.shadowPiercePath && primary.shadowPiercePath.length),
    };
    // Alternatives: keep xpath/aria as potential fallbacks when not used as primary
    const alternatives: ReplayStep['alternatives'] = [];
    if (rec.selector?.xpath) alternatives.push({selectors: {xpath: rec.selector.xpath}, reason: 'xpath fallback'});
    if (rec.selector?.aria) alternatives.push({selectors: {aria: rec.selector.aria}, reason: 'aria fallback'});
    if (rec.selector?.cssFallbacks?.length) {
      for (const css of rec.selector.cssFallbacks) {
        if (css && css !== primary.css) alternatives.push({selectors: {css}, reason: 'css fallback'});
      }
    }
    if (alternatives.length) step.alternatives = alternatives;
    // doneWhen heuristics based on network signals and page URL
    const doneWhen: ReplayStep['doneWhen'] = {};
    const net: any[] = Array.isArray(rec.network) ? rec.network : [];
    const urls = net.map(n => String(n?.url || '')).filter(Boolean);
    const checkoutUrl = urls.find(u => /\/checkout\b/i.test(u) || /stripe|payment|upe|express-checkout/i.test(u));
    const cartUrl = urls.find(u => /\/cart\b/i.test(u));
    if (checkoutUrl) {
      // prefer matching on path fragment so it works across environments
      doneWhen.urlMatches = 'checkout';
      step.notes = step.notes ? step.notes + '; checkout' : 'checkout';
    } else if (cartUrl) {
      doneWhen.urlMatches = 'cart';
      step.notes = step.notes ? step.notes + '; cart' : 'cart';
    } else if (rec.page?.url) {
      // Fallback: use origin of the current page to detect any navigation
      try {
        const origin = new URL(rec.page.url).origin;
        doneWhen.urlMatches = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      } catch {}
    }
    if (Object.keys(doneWhen).length) step.doneWhen = doneWhen;
    out.steps.push(step);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.in || !args.out) {
    console.error('Usage: node dist/scripts/postprocess-trace.js --in <trace.ndjson> --out <replay.json> [--domain <host>] [--limit N]');
    process.exit(1);
  }
  const records = await readNdjson(path.resolve(args.in));
  const plan = toReplay(records, args.limit);
  await fs.writeFile(path.resolve(args.out), JSON.stringify(plan, null, 2));
}

void main();


