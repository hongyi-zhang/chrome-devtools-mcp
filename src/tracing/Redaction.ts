/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Redaction utilities for sensitive values. Apply to string fields
 * in trace records before writing to disk.
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?<!\d)(?:\+?\d[\s-]?)?(?:\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4})(?!\d)/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g;
const ACCESS_TOKEN_RE = /(access_token|token|auth_token|sessionid)=?[A-Za-z0-9._-]{8,}/gi;
const CC_CANDIDATE_RE = /(?:^|\D)(\d[ -]?){13,19}(?:\D|$)/g;

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; --i) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) continue;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function maskValue(value: string): string {
  let out = value.replace(EMAIL_RE, '[REDACTED_EMAIL]');
  out = out.replace(PHONE_RE, '[REDACTED_PHONE]');
  out = out.replace(JWT_RE, '[REDACTED_JWT]');
  out = out.replace(ACCESS_TOKEN_RE, '$1=[REDACTED_TOKEN]');
  out = out.replace(CC_CANDIDATE_RE, match => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
      return match.replace(digits, '[REDACTED_CARD]');
    }
    return match;
  });
  return out;
}

export function redactKV<T>(obj: T): T {
  if (obj == null) return obj;
  if (typeof obj === 'string') return maskValue(obj) as unknown as T;
  if (Array.isArray(obj)) return obj.map(redactKV) as unknown as T;
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = redactKV(v);
    }
    return out as T;
  }
  return obj;
}


