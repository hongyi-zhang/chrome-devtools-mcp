/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import type {ElementHandle, Page} from 'puppeteer-core';

import type {BBox, SelectorBundle} from './TraceTypes.js';

async function computeBBox(el: ElementHandle<Element>): Promise<BBox | undefined> {
  try {
    const box = await el.boundingBox();
    if (!box) return undefined;
    return {x: box.x, y: box.y, width: box.width, height: box.height};
  } catch {
    return undefined;
  }
}

function hashString(input: string): string {
  const h = crypto.createHash('sha256');
  h.update(input);
  return h.digest('hex').slice(0, 16);
}

async function getOuterHTMLHash(el: ElementHandle<Element>): Promise<string> {
  const html = await el.evaluate(e => e.outerHTML.slice(0, 10_000));
  return hashString(html);
}

async function getFramePath(el: ElementHandle<Element>, page: Page): Promise<string[]> {
  try {
    // Puppeteer: ElementHandle.frame is a getter in some versions
    const frame = (el as any).frame ?? (await (el as any).frame?.());
    const chain: string[] = [];
    let f = frame;
    while (f) {
      const name = f.name();
      const url = f.url();
      const hint = name || hashString(url);
      chain.unshift(hint);
      f = f.parentFrame();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!f) break;
    }
    // Ensure at least top-level frame marker
    if (!chain.length) chain.push(hashString(page.url()));
    return chain;
  } catch {
    return [];
  }
}

async function getTagName(el: ElementHandle<Element>): Promise<string | undefined> {
  try {
    return await el.evaluate(e => e.tagName.toLowerCase());
  } catch {
    return undefined;
  }
}

async function getBasicAttrs(el: ElementHandle<Element>): Promise<{
  idAttr: string | null;
  nameAttr: string | null;
  type: string | undefined;
  classList: string[] | undefined;
}> {
  try {
    return await el.evaluate(e => {
      const anyEl = e as any;
      return {
        idAttr: e.getAttribute('id'),
        nameAttr: e.getAttribute('name'),
        type: e.getAttribute('type') ?? undefined,
        classList: Array.from(e.classList ?? []),
      };
    });
  } catch {
    return {idAttr: null, nameAttr: null, type: undefined, classList: undefined};
  }
}

function looksDynamicId(id: string | null): boolean {
  if (!id) return false;
  // UUID-like or mostly digits
  return /[0-9a-fA-F-]{6,}/.test(id) || /\d{4,}/.test(id);
}

async function computeAria(el: ElementHandle<Element>): Promise<{role?: string; name?: string} | undefined> {
  try {
    const role = await el.evaluate(e => e.getAttribute('role') || undefined);
    const name = await el.evaluate(e => e.getAttribute('aria-label') || undefined);
    if (!role && !name) return undefined;
    return {role, name};
  } catch {
    return undefined;
  }
}

async function computeTextSample(el: ElementHandle<Element>): Promise<string | undefined> {
  try {
    const text = await el.evaluate(e => (e as HTMLElement).innerText || '');
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.slice(0, 60);
  } catch {
    return undefined;
  }
}

async function computeCss(el: ElementHandle<Element>): Promise<{css?: string; fallbacks?: string[]}> {
  // Heuristics: data-testid/qa, stable id, attribute chains, nth-of-type short
  const attrs = await el.evaluate(e => {
    const attrNames = Array.from(e.getAttributeNames());
    const attrs: Record<string, string> = {};
    for (const n of attrNames) {
      const v = e.getAttribute(n);
      if (v != null) attrs[n] = v;
    }
    const parent = e.parentElement;
    const indexAmongType = parent
      ? Array.from(parent.children).filter(c => c.tagName === e.tagName).indexOf(e)
      : -1;
    return {attrs, tag: e.tagName.toLowerCase(), indexAmongType};
  });

  const candidates: string[] = [];
  // data-* test ids
  for (const key of Object.keys(attrs.attrs)) {
    if (key.startsWith('data-') && /(test|qa|qatest|e2e)/i.test(key)) {
      candidates.push(`${attrs.tag}[${key}="${cssEscape(attrs.attrs[key])}"]`);
    }
  }
  // stable id
  const id = attrs.attrs['id'];
  if (id && !looksDynamicId(id)) candidates.push(`#${cssEscape(id)}`);

  // attribute chain
  const chain: string[] = [];
  for (const k of ['name', 'type', 'aria-label', 'role']) {
    const v = attrs.attrs[k];
    if (v) chain.push(`[${k}="${cssEscape(v)}"]`);
  }
  if (chain.length) candidates.push(`${attrs.tag}${chain.join('')}`);

  // nth-of-type short
  if (attrs.indexAmongType >= 0 && candidates.length === 0) {
    candidates.push(`${attrs.tag}:nth-of-type(${attrs.indexAmongType + 1})`);
  }

  // Build anchored candidates from stable ancestors and rank by uniqueness
  const ancestorAnchors: string[] = await el.evaluate(e => {
    function esc(v: string): string { return v.replace(/"/g, '\\"'); }
    const anchors: string[] = [];
    let cur: Element | null = e.parentElement;
    let depth = 0;
    while (cur && depth < 5) {
      const tag = cur.tagName.toLowerCase();
      const id = cur.getAttribute('id');
      if (id && id.length < 80) anchors.push(`#${esc(id)}`);
      const names = Array.from(cur.getAttributeNames());
      for (const n of names) {
        if (n.startsWith('data-') && /(test|qa|qatest|e2e)/i.test(n)) {
          const v = cur.getAttribute(n) || '';
          anchors.push(`${tag}[${n}="${esc(v)}"]`);
          break;
        }
      }
      cur = cur.parentElement;
      depth++;
    }
    return anchors;
  });

  const nodeDesc = chain.length ? `${attrs.tag}${chain.join('')}` : `${attrs.tag}`;
  const anchored = ancestorAnchors.map(a => `${a} ${nodeDesc}`);
  const allCandidates = Array.from(new Set([...candidates, ...anchored].filter(Boolean)));

  type CountPair = {sel: string; count: number; len: number};
  const counts: CountPair[] = await el.evaluate((e, sels: string[]) => {
    const doc = (e.ownerDocument || document) as Document;
    const out: {sel: string; count: number; len: number}[] = [];
    for (var i = 0; i < sels.length; i++) {
      var s = sels[i];
      var n = 0;
      try { n = doc.querySelectorAll(s).length; } catch (_) { n = 0; }
      out.push({sel: s, count: n, len: s.length});
    }
    return out;
  }, allCandidates);

  counts.sort((a, b) => {
    if ((a.count === 1) !== (b.count === 1)) return a.count === 1 ? -1 : 1;
    if (a.count !== b.count) return a.count - b.count;
    return a.len - b.len;
  });
  const chosen = counts.find(c => c.count >= 1)?.sel;
  const fallbacks = counts.filter(c => c.sel !== chosen).slice(0, 4).map(c => c.sel);
  return {css: chosen, fallbacks};
}

function cssEscape(value: string): string {
  // Basic escape; not full CSSOM escape to avoid dependency
  return value.replace(/"/g, '\\"');
}

async function computeXPath(el: ElementHandle<Element>): Promise<{xpath?: string; xpathAbs?: string}> {
  // Basic short XPath up to a few levels
  const segments: {segments: string[]; abs: string} = await el.evaluate(e => {
    function shortName(n: Element): string {
      const id = n.getAttribute('id');
      if (id) return `//*[@id='${id.replace(/'/g, "\\'")}']`;
      const name = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (!parent) return `/${name}`;
      const siblings = Array.from(parent.children).filter((s: Element) => s.tagName === n.tagName);
      const index = siblings.indexOf(n) + 1;
      return `/${name}[${index}]`;
    }
    const segs: string[] = [];
    let cur: Element | null = e;
    let steps = 0;
    while (cur && steps < 5) {
      segs.unshift(shortName(cur));
      cur = cur.parentElement;
      steps++;
    }
    const abs = (() => {
      const a: string[] = [];
      let c: Element | null = e;
      while (c) {
        const name = c.tagName.toLowerCase();
        const parentEl: Element | null = c.parentElement;
        if (!parentEl) {
          a.unshift(`/${name}`);
          break;
        }
        const siblings = parentEl ? (Array.from(parentEl.children) as Element[]) : [];
        const sameTagSiblings = siblings.filter((s: Element) => s.tagName === c!.tagName);
        const index = sameTagSiblings.indexOf(c) + 1;
        a.unshift(`/${name}[${index}]`);
        c = parentEl;
      }
      return a.join('');
    })();
    return {segments: segs, abs};
  });

  const xpath = segments.segments.join('');
  const xpathAbs = segments.abs;
  return {xpath, xpathAbs};
}

async function computeShadowPath(el: ElementHandle<Element>): Promise<string[] | undefined> {
  try {
    return await el.evaluate(e => {
      const path: string[] = [];
      function label(node: Element): string {
        const id = node.getAttribute('id');
        const cls = node.getAttribute('class');
        const tag = node.tagName.toLowerCase();
        return `${tag}${id ? `#${id}` : ''}${cls ? `.${cls.split(/\s+/).join('.')}` : ''}`;
      }
      // Walk up to root, recording boundaries at shadow hosts
      let cur: Element | null = e;
      while (cur) {
        const root = cur.getRootNode();
        if ((root as ShadowRoot).host) {
          path.unshift(label((root as ShadowRoot).host as Element));
        }
        cur = (root as ShadowRoot).host ? ((root as ShadowRoot).host as Element) : (cur.parentElement);
        if (!cur) break;
        if (cur === document.documentElement) break;
      }
      return path;
    });
  } catch {
    return undefined;
  }
}

export async function buildSelectorBundle(
  el: ElementHandle<Element>,
  page: Page,
): Promise<SelectorBundle> {
  const [bbox, outerHTMLHash, framePath, tag, attrs, aria, text, css, xp, shadow] =
    await Promise.all([
      computeBBox(el),
      getOuterHTMLHash(el),
      getFramePath(el, page),
      getTagName(el),
      getBasicAttrs(el),
      computeAria(el),
      computeTextSample(el),
      computeCss(el),
      computeXPath(el),
      computeShadowPath(el),
    ]);

  return {
    css: css.css,
    cssFallbacks: css.fallbacks,
    xpath: xp.xpath,
    xpathAbs: xp.xpathAbs,
    aria: aria ?? undefined,
    tag,
    type: attrs.type,
    nameAttr: attrs.nameAttr,
    idAttr: attrs.idAttr,
    classList: attrs.classList,
    textSample: text,
    bbox,
    shadowPiercePath: shadow,
    outerHTMLHash,
    framePath,
  } as SelectorBundle;
}


