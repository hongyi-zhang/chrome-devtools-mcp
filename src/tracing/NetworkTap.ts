/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {HTTPResponse, Page} from 'puppeteer-core';

import {TRACE_BODY_STRIP, TRACE_HEADERS_ALLOWLIST} from './config.js';
import type {NetworkEntry} from './TraceTypes.js';

const DENYLIST_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-csrf-token',
]);

function filterHeaders(headers: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (DENYLIST_HEADERS.has(key)) continue;
    if (TRACE_HEADERS_ALLOWLIST.length && !TRACE_HEADERS_ALLOWLIST.includes(key)) {
      continue;
    }
    if (Array.isArray(v)) out[key] = v.join(',');
    else if (typeof v === 'string') out[key] = v;
  }
  return out;
}

function classify(url: string, method: string, status?: number): NetworkEntry['matchedHint'] | undefined {
  const u = url.toLowerCase();
  if (/\/cart(\/|\?|$)/.test(u) && status && status >= 200 && status < 300) {
    return 'add_to_cart';
  }
  if (/checkout|payment|pay|purchase/.test(u)) {
    return 'checkout';
  }
  return undefined;
}

export class NetworkTap {
  #page: Page;
  #active = false;
  #events: NetworkEntry[] = [];

  constructor(page: Page) {
    this.#page = page;
  }

  start() {
    if (this.#active) return;
    this.#active = true;
    const onResponse = async (response: HTTPResponse) => {
      if (!this.#active) return;
      try {
        const req = response.request();
        const url = req.url();
        const method = req.method();
        const status = response.status();
        const requestHeaders = filterHeaders(req.headers());
        const responseHeaders = filterHeaders(response.headers());

        // Bodies are redacted by default
        if (!TRACE_BODY_STRIP) {
          // noop placeholder; we intentionally do not fetch bodies unless configured
        }

        this.#events.push({
          url,
          method,
          status,
          requestHeaders,
          responseHeaders,
          matchedHint: classify(url, method, status),
        });
      } catch {
        // best-effort
      }
    };

    // Attach listener
    this.#page.on('response', onResponse);

    // Store detacher
    (this as any)._detach = () => {
      this.#page.off('response', onResponse);
    };
  }

  stop(): NetworkEntry[] {
    if (!this.#active) return [];
    this.#active = false;
    (this as any)._detach?.();
    const out = this.#events;
    this.#events = [];
    return out;
  }
}


