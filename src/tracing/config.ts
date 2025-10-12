/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracing configuration gated by environment variables.
 * Defaults: enabled in dev, disabled in prod.
 */
export const TRACING_ENABLED: boolean = (() => {
  const env = process.env['MCP_TRACING_ENABLED'];
  if (env != null) {
    return env === '1' || env?.toLowerCase() === 'true';
  }
  const nodeEnv = process.env['NODE_ENV']?.toLowerCase();
  return nodeEnv !== 'production';
})();

export const TRACE_DIR: string =
  process.env['MCP_TRACE_DIR'] ?? '.mcp-traces';

export const TRACE_SCREENSHOTS: boolean = (() => {
  const env = process.env['MCP_TRACE_SCREENSHOTS'];
  return env === '1' || env?.toLowerCase() === 'true';
})();

export const TRACE_HEADERS_ALLOWLIST: string[] = (() => {
  const raw = process.env['MCP_TRACE_HEADERS_ALLOWLIST'];
  if (!raw) return ['content-type', 'x-request-id'];
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
})();

export const TRACE_BODY_STRIP: boolean = (() => {
  const env = process.env['MCP_TRACE_BODY_STRIP'];
  if (env == null) return true;
  return env === '1' || env?.toLowerCase() === 'true';
})();

export const MAX_TRACE_SIZE_MB: number = (() => {
  const env = process.env['MCP_MAX_TRACE_SIZE_MB'];
  const parsed = env ? Number(env) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
})();


