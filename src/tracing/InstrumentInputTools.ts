/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ElementHandle} from 'puppeteer-core';
import fs from 'node:fs/promises';

import type {Context, Request, Response, ToolDefinition} from '../tools/ToolDefinition.js';
import {logger} from '../logger.js';
import {TRACE_DIR, TRACE_SCREENSHOTS, TRACING_ENABLED} from './config.js';
import {buildSelectorBundle} from './SelectorUtils.js';
import type {TraceContractV1} from './TraceTypes.js';
import {NetworkTap} from './NetworkTap.js';
import {TraceWriter} from './TraceWriter.js';
import {ToolCategories} from '../tools/categories.js';
import z from 'zod';

const sessionWriter = new TraceWriter();

export function withActionTracing<Schema extends z.ZodRawShape>(
  tool: ToolDefinition<Schema>,
): ToolDefinition<Schema> {
  // Only wrap input automation category tools.
  if (!TRACING_ENABLED || tool.annotations.readOnlyHint || tool.annotations.category !== ToolCategories.INPUT_AUTOMATION) {
    return tool;
  }

  const wrapped: ToolDefinition<Schema> = {
    ...tool,
    handler: async (request: Request<Schema>, response: Response, context: Context) => {
      const page = context.getSelectedPage();
      const actionName = tool.name;
      const timeStart = Date.now();
      let element: ElementHandle<Element> | null = null;
      let selectorBundle = undefined;
      let bbox = undefined;
      let screenshots: {path: string}[] | undefined;
      let network: TraceContractV1['network'] | undefined;
      const tap = new NetworkTap(page);
      tap.start();
      let outcome: TraceContractV1['outcome'] = {ok: true};

      try {
        // Best-effort match: derive element from uid if present
        const uid = (request as any).params?.uid ?? (request as any).params?.from_uid ?? (request as any).params?.to_uid;
        if (uid) {
          try {
            element = await context.getElementByUid(uid);
          } catch {}
        }

        if (element) {
          try {
            selectorBundle = await buildSelectorBundle(element, page);
            bbox = selectorBundle.bbox;
          } catch {}
        }

        await tool.handler(request, response, context);

        if (TRACE_SCREENSHOTS) {
          try {
            await fs.mkdir(TRACE_DIR, {recursive: true});
            const buf = (await page.screenshot({type: 'png', fullPage: false})) as unknown as Uint8Array;
            const out = await context.saveFile(buf, `${TRACE_DIR}/shot-${Date.now()}.png`);
            screenshots = [{path: out.filename}];
          } catch (e) {
            logger(`screenshot failed: ${(e as Error).message}`);
          }
        }
      } catch (error) {
        outcome = {ok: false, error: {message: (error as Error).message, stack: (error as Error).stack}};
        throw error;
      } finally {
        network = tap.stop();
        const timeEnd = Date.now();
        try {
          const title = await page.title().catch(() => undefined);
          const record: TraceContractV1 = {
            version: 'v1',
            sessionId: sessionWriter.sessionId,
            stepId: `${timeStart}`,
            timeStart,
            timeEnd,
            action: {name: actionName, params: (request as any).params},
            page: {url: page.url(), title},
            framePath: selectorBundle?.framePath ?? [],
            selector: selectorBundle ?? {
              outerHTMLHash: '',
              framePath: [],
            },
            outcome,
            dom: {
              outerHTMLHash: selectorBundle?.outerHTMLHash ?? '',
              textSample: selectorBundle?.textSample,
            },
            bbox,
            screenshots,
            network,
          };
          await sessionWriter.write(record);
        } catch (err) {
          logger(`trace write failed: ${(err as Error).message}`);
        }
        if (element) void element.dispose();
      }
    },
  };
  return wrapped;
}


