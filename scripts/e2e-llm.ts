/* eslint-disable @typescript-eslint/no-explicit-any */
import 'dotenv/config';
declare const process: any;
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Node process is available globally; avoid importing type to satisfy linter.

import OpenAI from 'openai';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {Client as McpClient} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';

const MCP_SERVER_PATH = 'build/src/index.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

// Default mobile viewport for e2e runs; override with E2E_VIEWPORT env like "414x896"
const DEFAULT_E2E_VIEWPORT: string = optionalEnv('E2E_VIEWPORT') ?? '390x844';

async function listMcpTools(): Promise<Tool[]> {
  const transport = new StdioClientTransport({command: 'node', args: [MCP_SERVER_PATH, '--isolated', '--viewport', DEFAULT_E2E_VIEWPORT]});
  const client = new McpClient({name: 'e2e-llm', version: '1.0.0'}, {capabilities: {}});
  await client.connect(transport);
  const {tools} = await client.listTools();
  await client.close();
  return tools;
}

function convertMcpToolsToOpenAiTools(mcpTools: Tool[]): any[] {
  // Convert MCP tool definitions to OpenAI Chat Completions tools format
  return mcpTools.map((t: any) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.inputSchema ?? {type: 'object', properties: {}}
    }
  }));
}

function processMcpToolResult(result: any): {text: string; images: any[]} {
  const textParts: string[] = [];
  const imageParts: any[] = [];

  if (result?.content) {
    for (const item of result.content) {
      if (item.type === 'text') {
        textParts.push(item.text);
      } else if (item.type === 'image' && item.data) {
        imageParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${item.mimeType};base64,${item.data}`,
          },
        });
      } else {
        textParts.push(JSON.stringify(item));
      }
    }
  }

  return {
    text: textParts.join('\n'),
    images: imageParts,
  };
}

function buildShoppingSystemPrompt(): string {
  return [
    'You are a helpful web automation agent. Your goal is to help the user complete a web browsing task. Think before taking actions. Act by calling the provided tools. Only use the input tools (click/fill/hover/drage) to interact with the Web UI, NOT the evaluate_script tool. Wait a few seconds after each action to allow the page to update.',
  ].join('\n');
}

function ensureTracingEnvAndDir(): string {
  if (process.env['MCP_TRACING_ENABLED'] == null) {
    process.env['MCP_TRACING_ENABLED'] = 'true';
  }
  let dir = process.env['MCP_TRACE_DIR'];
  if (!dir) {
    dir = path.join(process.cwd(), `.mcp-traces`);
    process.env['MCP_TRACE_DIR'] = dir;
  }
  return dir;
}

async function startTracePrinter(traceDir: string): Promise<() => void> {
  try {
    await fsp.mkdir(traceDir, {recursive: true});
  } catch {}
  const filePositions = new Map<string, number>();

  async function readNew(fullPath: string): Promise<void> {
    try {
      const stats = await fsp.stat(fullPath);
      const prev = filePositions.get(fullPath) ?? 0;
      if (stats.size <= prev) return;
      const fh = await fsp.open(fullPath, 'r');
      const toRead = stats.size - prev;
      const buffer = Buffer.alloc(toRead);
      await fh.read(buffer, 0, toRead, prev);
      await fh.close();
      filePositions.set(fullPath, stats.size);
      const text = buffer.toString('utf-8');
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          // eslint-disable-next-line no-console
          console.log('TRACE', obj);
        } catch {
          // eslint-disable-next-line no-console
          console.log('TRACE', trimmed);
        }
      }
    } catch {}
  }

  try {
    const existing = await fsp.readdir(traceDir);
    for (const name of existing) {
      if (!name.endsWith('.ndjson')) continue;
      const full = path.join(traceDir, name);
      try {
        const stats = await fsp.stat(full);
        filePositions.set(full, stats.size);
      } catch {}
    }
  } catch {}

  const watcher = fs.watch(traceDir, {persistent: false}, (event, filename) => {
    if (!filename || !filename.endsWith('.ndjson')) return;
    const full = path.join(traceDir, filename);
    if (event === 'rename' && !filePositions.has(full)) {
      filePositions.set(full, 0);
    }
    void readNew(full);
  });

  return () => {
    try {
      watcher.close();
    } catch {}
  };
}

async function main() {
  // Require user config
  const apiKey = requireEnv('OPENAI_API_KEY');
  const baseURL = requireEnv('OPENAI_BASE_URL');
  const apiVersion = requireEnv('OPENAI_API_VERSION');
  const model = requireEnv('OPENAI_MODEL');
  const user = process.argv[2];
  if (!user) {
    throw new Error('Usage: e2e-llm.ts <user_prompt>');
  }

  const client = new OpenAI({
    apiKey,
    baseURL,
    // Azure compatibility: pass api-version
    defaultQuery: {'api-version': apiVersion},
  } as any);

  const mcpTools = await listMcpTools();
  const tools = convertMcpToolsToOpenAiTools(mcpTools);
  const system = buildShoppingSystemPrompt();

  // Create a persistent MCP client for the agent loop
  const traceDir = ensureTracingEnvAndDir();
  const stopTracePrinter = await startTracePrinter(traceDir);
  const transport = new StdioClientTransport({command: 'node', args: [MCP_SERVER_PATH, '--isolated', '--viewport', DEFAULT_E2E_VIEWPORT]});
  const mcpClient = new McpClient({name: 'e2e-llm', version: '1.0.0'}, {capabilities: {}});
  await mcpClient.connect(transport);

  let exitCode = 0;
  let shouldExit = false;
  try {
    const messages: any[] = [
      {role: 'system', content: system},
      {role: 'user', content: user},
    ];

    // Safety cap to avoid infinite loops
    for (let step = 0; step < 30; step++) {
      const completion = await client.chat.completions.create({
        model,
        messages,
        tools,
        tool_choice: 'auto',
        max_tokens: 8192,
      } as any);

      const choice = completion.choices[0];
      const msg: any = choice?.message ?? {};
      const finish = choice?.finish_reason;
      // Log finish reason
      console.log('Finish reason:', finish);

      // If assistant produced text, print it and add to history
      if (msg?.content && typeof msg.content === 'string' && msg.content.length) {
        // eslint-disable-next-line no-console
        console.log(msg.content);
      }

      const assistantForHistory: any = {
        role: 'assistant',
        content: msg?.content ?? '',
      };
      if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
        assistantForHistory.tool_calls = msg.tool_calls;
        // Log the tool calls
        console.log('Tool calls:', msg.tool_calls);
      }
      messages.push(assistantForHistory);

      // Handle tool calls, if any
      const toolCalls: any[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          const callId = toolCall?.id;
          const name = toolCall?.function?.name as string;
          const argsRaw = toolCall?.function?.arguments ?? '{}';
          let args: any = {};
          try {
            args = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : (argsRaw ?? {});
          } catch {
            args = {};
          }

          const result = await mcpClient.callTool({
            name,
            arguments: args,
          });

          const {text, images} = processMcpToolResult(result);
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            content: text,
          } as any);

          if (images.length > 0) {
            const lastUserMessage = messages
              .slice()
              .reverse()
              .find(m => m.role === 'user');
            if (lastUserMessage) {
              if (!Array.isArray(lastUserMessage.content)) {
                lastUserMessage.content = [{type: 'text', text: lastUserMessage.content ?? ''}];
              }
              lastUserMessage.content.push(...images);
            }
          }
        }
      }

      if (finish === 'stop' || finish === 'length') {
        shouldExit = true;
        break;
      }
    }
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    try {
      await mcpClient.close();
    } catch {}
    try {
      stopTracePrinter();
    } catch {}
    process.exit(exitCode);
  }
}

void main();


