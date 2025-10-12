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

async function listMcpTools(): Promise<Tool[]> {
  const transport = new StdioClientTransport({command: 'node', args: [MCP_SERVER_PATH, '--isolated']});
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

function formatMcpToolResult(result: any): string {
  if (!result) {
    return '';
  }
  const content = result.content ?? [];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        if (item.type === 'text' && typeof item.text === 'string') {
          parts.push(item.text);
        } else {
          // Fallback for non-text content
          parts.push(JSON.stringify(item));
        }
      } else if (typeof item === 'string') {
        parts.push(item);
      }
    }
    return parts.join('\n');
  }
  // Fallback for unexpected shapes
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function buildShoppingSystemPrompt(): string {
  return [
    'You are a helpful web automation agent. Your goal is to help the user complete a web browsing task. Think before taking actions. Act by calling the provided tools.',
  ].join('\n');
}

function ensureTracingEnvAndDir(): string {
  if (process.env['MCP_TRACING_ENABLED'] == null) {
    process.env['MCP_TRACING_ENABLED'] = 'true';
  }
  let dir = process.env['MCP_TRACE_DIR'];
  if (!dir) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dir = path.join(process.cwd(), `.mcp-traces-${suffix}`);
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

  const client = new OpenAI({
    apiKey,
    baseURL,
    // Azure compatibility: pass api-version
    defaultQuery: {'api-version': apiVersion},
  } as any);

  const mcpTools = await listMcpTools();
  const tools = convertMcpToolsToOpenAiTools(mcpTools);
  const system = buildShoppingSystemPrompt();
  const user = 'Go to https://ritualcoffee.com/shop/coffee/cosmic-shift-seasonal-espresso/ and add one bag of 5lb coffee to the cart.';

  // Create a persistent MCP client for the agent loop
  const traceDir = ensureTracingEnvAndDir();
  const stopTracePrinter = await startTracePrinter(traceDir);
  const transport = new StdioClientTransport({command: 'node', args: [MCP_SERVER_PATH, '--isolated']});
  const mcpClient = new McpClient({name: 'e2e-llm', version: '1.0.0'}, {capabilities: {}});
  await mcpClient.connect(transport);

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
          } as any);
          const toolContent = formatMcpToolResult(result);
          messages.push({
            role: 'tool',
            tool_call_id: callId,
            content: toolContent,
            name,
          });
        }
        // Continue loop for next assistant turn after providing tool results
        continue;
      }

      // If the model indicates stop, end the loop
      if (finish === 'stop') {
        break;
      }
    }
  } finally {
    await mcpClient.close();
    stopTracePrinter();
  }
}

void main();


