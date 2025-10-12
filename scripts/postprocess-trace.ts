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
}

interface ReplayPlan {
  version: 'v1';
  userAgent?: string;
  viewport?: {width: number; height: number; deviceScaleFactor?: number};
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
  if (!primary.css && sel?.cssFallbacks?.length) {
    primary.css = sel.cssFallbacks[0];
    confidence = 0.6;
  }
  if (!primary.css && sel?.xpath) {
    primary.xpath = sel.xpath;
    confidence = 0.4;
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
    // Simple doneWhen: if click leads to navigation, use urlMatches
    if (kind === 'click' && rec.page?.url) {
      step.doneWhen = {urlMatches: String(new URL(rec.page.url).origin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};
    }
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


