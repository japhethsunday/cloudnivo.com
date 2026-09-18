/**
 * The one place a request body is read.
 *
 * Six modules used to have their own copy of "drain the stream, then check the
 * size", which meant six copies of the same denial-of-service hole and — once
 * the WAF existed — six places that could quietly skip body inspection. Both
 * problems are structural: they come from having six readers, not from any one
 * of them being written badly.
 *
 * So there is one reader now, and it does both jobs:
 *
 *   1. enforces the byte cap WHILE STREAMING (see `readBoundedBody`)
 *   2. runs the WAF over the body, but ONLY where the payload shape is one the
 *      platform defines
 *
 * Point 2 is what lets the WAF stay switched on. On a tenant data plane the
 * body is the customer's own SQL, JSON or source code; pattern-matching it
 * would break the product, so `bodyIsOpaque` decides from the URL which bodies
 * are the platform's business and which are not.
 */

import type { IncomingMessage } from 'node:http';
import { ApiError, readBoundedBody } from '@cloudnivo/api-core';
import { bodyIsOpaque, inspectBody } from './waf.js';

export type WafMode = 'block' | 'report' | 'off';

/**
 * Module-level, set once at context creation.
 *
 * Every route reads a body without being handed config, and threading it
 * through a dozen signatures to avoid two module variables would be the worse
 * trade. They are written once at boot and only read afterwards.
 */
let wafMode: WafMode = 'block';
let defaultMaxBytes = 1_048_576;

export function configureBodyReader(mode: WafMode, maxBytes: number): void {
  wafMode = mode;
  defaultMaxBytes = maxBytes;
}

export function bodyReaderSettings(): { mode: WafMode; maxBytes: number } {
  return { mode: wafMode, maxBytes: defaultMaxBytes };
}

/** Raw body text, capped, inspected where the route's shape is platform-defined. */
export async function readCheckedBody(req: IncomingMessage, maxBytes?: number): Promise<string> {
  const text = await readBoundedBody(req, maxBytes ?? defaultMaxBytes);
  if (!text) return text;
  if (wafMode === 'off') return text;

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (bodyIsOpaque(pathname)) return text;

  const verdict = inspectBody(text);
  if (verdict.blocked && wafMode === 'block') {
    // The same opaque answer the pre-routing filter gives: the caller learns
    // the request was refused, never which rule refused it.
    throw new ApiError('BAD_REQUEST', 'Malformed request', 400);
  }
  return text;
}

/** `readCheckedBody` plus JSON parsing. An empty body resolves to undefined. */
export async function readCheckedJson(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  const text = await readCheckedBody(req, maxBytes);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('MALFORMED_JSON', 'Request body is not valid JSON', 400);
  }
}
