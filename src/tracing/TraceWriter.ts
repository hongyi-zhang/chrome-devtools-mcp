/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {logger} from '../logger.js';
import {Mutex} from '../Mutex.js';
import {MAX_TRACE_SIZE_MB, TRACE_DIR, TRACING_ENABLED} from './config.js';
import type {TraceContractV1} from './TraceTypes.js';

const MB = 1024 * 1024;

export class TraceWriter {
  #sessionId: string;
  #filePath: string | null = null;
  #bytesWritten = 0;
  #mutex = new Mutex();

  constructor(sessionId?: string) {
    this.#sessionId = sessionId ?? TraceWriter.#generateSessionId();
  }

  static #generateSessionId(): string {
    const rnd = Math.random().toString(36).slice(2, 10);
    const ts = Date.now();
    return `${ts}-${rnd}`;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async #ensureDir(): Promise<void> {
    await fsp.mkdir(TRACE_DIR, {recursive: true});
  }

  async #ensureFile(): Promise<void> {
    if (this.#filePath && fs.existsSync(this.#filePath)) return;
    await this.#ensureDir();
    const base = path.join(
      TRACE_DIR,
      `trace-${this.#sessionId}-${Date.now()}.ndjson`,
    );
    this.#filePath = base;
    this.#bytesWritten = 0;
    logger(`TraceWriter: opened ${base}`);
  }

  async #rotateIfNeeded(): Promise<void> {
    if (!this.#filePath) return;
    const maxBytes = MAX_TRACE_SIZE_MB * MB;
    if (this.#bytesWritten < maxBytes) return;
    // Rotate: create a new file with a new suffix.
    const old = this.#filePath;
    const next = path.join(
      TRACE_DIR,
      `trace-${this.#sessionId}-${Date.now()}.ndjson`,
    );
    this.#filePath = next;
    this.#bytesWritten = 0;
    logger(`TraceWriter: rotated ${old} -> ${next}`);
  }

  async write(line: TraceContractV1): Promise<void> {
    if (!TRACING_ENABLED) return;
    const guard = await this.#mutex.acquire();
    try {
      await this.#ensureFile();
      const payload = JSON.stringify(line) + '\n';
      await fsp.appendFile(this.#filePath as string, payload, 'utf-8');
      this.#bytesWritten += Buffer.byteLength(payload);
      await this.#rotateIfNeeded();
    } catch (err) {
      logger(`TraceWriter error: ${(err as Error).message}`);
    } finally {
      guard.dispose();
    }
  }
}


