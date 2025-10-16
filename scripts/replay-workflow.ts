/*
 * Simplified replay workflow script
 * Runs a list of prompts through e2e-llm to produce traces, post-processes them,
 * and writes a URL->trace mapping usable by the browser extension.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

interface PromptItem { prompt: string }
interface Args { prompts?: string; outDir?: string; mapping?: string; limit?: number }

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompts') out.prompts = argv[++i];
    else if (a === '--outDir') out.outDir = argv[++i];
    else if (a === '--mapping') out.mapping = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
  }
  return out;
}

function ensure(val: string | undefined, name: string, def?: string): string {
  if (val && val.length) return val;
  if (def) return def;
  throw new Error(`Missing required argument: ${name}`);
}

async function readPrompts(file: string): Promise<PromptItem[]> {
  const raw = await fs.readFile(file, 'utf-8');
  const data = JSON.parse(raw);
  if (Array.isArray(data)) {
    return data.map((x: any) => typeof x === 'string' ? {prompt: x} : {prompt: String(x.prompt)});
  }
  if (Array.isArray(data.prompts)) {
    return data.prompts.map((x: any) => typeof x === 'string' ? {prompt: x} : {prompt: String(x.prompt)});
  }
  throw new Error('Prompts file must be an array of strings or objects with {prompt}');
}

async function listNdjson(dir: string): Promise<{file: string, mtimeMs: number}[]> {
  try {
    const ents = await fs.readdir(dir, {withFileTypes: true});
    const files = ents.filter(e => e.isFile() && e.name.endsWith('.ndjson'));
    const stats = await Promise.all(files.map(async f => {
      const full = path.join(dir, f.name);
      const st = await fs.stat(full);
      return {file: full, mtimeMs: st.mtimeMs};
    }));
    stats.sort((a,b) => a.mtimeMs - b.mtimeMs);
    return stats;
  } catch {
    return [];
  }
}

async function latestNdjsonSince(dir: string, sinceMs: number): Promise<string | undefined> {
  const list = await listNdjson(dir);
  const filtered = list.filter(x => x.mtimeMs >= sinceMs);
  return filtered.at(-1)?.file ?? list.at(-1)?.file;
}

function runNodeScript(scriptRelPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-strip-types', scriptRelPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(); else reject(new Error(`${scriptRelPath} exited with code ${code}`));
    });
  });
}

async function main(){
  const args = parseArgs(process.argv);
  const promptsPath = ensure(args.prompts, '--prompts');
  const outDir = ensure(args.outDir, '--outDir', path.resolve('./extension/data'));
  const mappingPath = ensure(args.mapping, '--mapping', path.resolve('./extension/data/url-trace-mapping.json'));
  const limit = args.limit;

  await fs.mkdir(outDir, {recursive: true});

  const prompts = await readPrompts(promptsPath);

  const traceDir = process.env['MCP_TRACE_DIR'] ?? path.resolve('.mcp-traces');
  await fs.mkdir(traceDir, {recursive: true});

  const mapping: Array<{url: string, trace: string}> = [];

  for (const item of prompts){
    const prompt = String(item.prompt);
    const startMs = Date.now();
    // 1) Run e2e-llm to produce trace
    await runNodeScript('scripts/e2e-llm.ts', [prompt]);
    // 2) Find latest trace file and post-process
    const ndjson = await latestNdjsonSince(traceDir, startMs);
    if (!ndjson) {
      console.warn('No trace file found after running prompt:', prompt);
      continue;
    }
    const outName = `replay-${Date.now()}.json`;
    const outPath = path.join(outDir, outName);
    await runNodeScript('scripts/postprocess-trace.ts', ['--in', ndjson, '--out', outPath, ...(typeof limit === 'number' ? ['--limit', String(limit)] : [])]);

    // 3) Read replay plan to get URL
    try {
      const raw = await fs.readFile(outPath, 'utf-8');
      const plan = JSON.parse(raw);
      const url: string = String(plan.startUrl || '');
      if (!url) {
        console.warn('Replay plan missing startUrl for prompt:', prompt);
      } else {
        const rel = `data/${outName}`; // relative to extension root for web_accessible_resources
        mapping.push({url, trace: rel});
        console.log(`Mapped ${url} -> ${rel}`);
      }
    } catch (e) {
      console.warn('Failed to read replay plan:', (e as Error).message);
    }
  }

  // 4) Write URL->trace mapping
  await fs.writeFile(mappingPath, JSON.stringify(mapping, null, 2));
  console.log(`Wrote mapping to ${mappingPath}`);
}

void main();