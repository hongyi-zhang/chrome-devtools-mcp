/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AriaDescriptor {
  role?: string;
  name?: string;
}

export interface SelectorBundle {
  css?: string;
  cssFallbacks?: string[];
  xpath?: string;
  xpathAbs?: string;
  aria?: AriaDescriptor;
  tag?: string;
  type?: string;
  nameAttr?: string | null;
  idAttr?: string | null;
  classList?: string[];
  textSample?: string;
  bbox?: BBox;
  shadowPiercePath?: string[];
  outerHTMLHash: string;
  framePath: string[];
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  requestId?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  matchedHint?: 'add_to_cart' | 'checkout' | string;
}

export interface TraceActionDescriptor {
  name:
    | 'click'
    | 'fill'
    | 'select'
    | 'hover'
    | 'drag'
    | 'press'
    | string;
  params: unknown;
}

export interface TraceOutcome {
  ok: boolean;
  error?: {message: string; stack?: string};
}

export interface TraceDom {
  outerHTMLHash: string;
  textSample?: string;
}

export interface TraceScreenshotRef {
  path: string;
}

export interface TraceContractV1 {
  version: 'v1';
  sessionId: string;
  stepId: string;
  timeStart: number;
  timeEnd: number;
  action: TraceActionDescriptor;
  page: {url: string; title?: string};
  framePath: string[];
  selector: SelectorBundle;
  outcome: TraceOutcome;
  dom: TraceDom;
  bbox?: BBox;
  screenshots?: TraceScreenshotRef[];
  network?: NetworkEntry[];
}


