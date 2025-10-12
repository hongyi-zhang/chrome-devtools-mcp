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
  const transport = new StdioClientTransport({command: 'node', args: [MCP_SERVER_PATH]});
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
      parameters: t.input_schema ?? {type: 'object', properties: {}}
    }
  }));
}

function buildShoppingSystemPrompt(): string {
  return [
    'You are a precise web automation agent. You can only act by calling the provided tools.',
    'Goal: Add one 5 lb bag of Cosmic Shift Seasonal Espresso to the cart on Ritual Coffee.'
  ].join('\n');
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

    // Use Chat Completions for broad compatibility (OpenAI & Azure OpenAI)
    const completion = await client.chat.completions.create({
      model,
      messages: [
        {role: 'system', content: system},
        {role: 'user', content: user},
      ],
      tools,
      tool_choice: 'auto',
      max_tokens: 1000,
    });

  const content = completion.choices[0]?.message?.content ?? '';
  // Print JSON result to stdout for CI harness to consume
  // eslint-disable-next-line no-console
  console.log(content);
}

void main();


