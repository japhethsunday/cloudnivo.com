import { FunctionError, type FunctionRuntimeName } from './types.js';

/**
 * Boundary validation for function inputs. Identifiers are allow-listed,
 * sizes are capped before any build/execution work starts. Error messages are
 * safe to return (they echo only validated prefixes).
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const ENTRY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function assertFunctionSlug(slug: string): string {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new FunctionError(
      'VALIDATION_ERROR',
      'Invalid function slug (lowercase, digits, dashes)',
      400,
    );
  }
  return slug;
}

export function assertFunctionName(name: string): string {
  if (typeof name !== 'string' || name.length < 2 || name.length > 100) {
    throw new FunctionError('VALIDATION_ERROR', 'Function name must be 2-100 characters', 400);
  }
  return name;
}

export function assertDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 2000) {
    throw new FunctionError(
      'VALIDATION_ERROR',
      'Description must be a string up to 2000 characters',
      400,
    );
  }
  return value;
}

export function assertRuntime(value: unknown): FunctionRuntimeName {
  if (value === 'node22') return value;
  throw new FunctionError('VALIDATION_ERROR', 'Unsupported runtime (supported: node22)', 400);
}

export function assertEntrypoint(value: unknown): string {
  const fallback = 'handler';
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > 128 || !ENTRY_RE.test(value)) {
    throw new FunctionError(
      'VALIDATION_ERROR',
      'Invalid entrypoint (dotted export path, e.g. handler)',
      400,
    );
  }
  // Prototype-pollution guard: resolution uses property access upstream.
  for (const part of value.split('.')) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new FunctionError('VALIDATION_ERROR', 'Invalid entrypoint segment', 400);
    }
  }
  return value;
}

export function assertSource(source: unknown, maxBytes: number): string {
  if (typeof source !== 'string' || source.length === 0) {
    throw new FunctionError('VALIDATION_ERROR', 'Function source is required', 400);
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > maxBytes) {
    throw new FunctionError('DEPLOYMENT_TOO_LARGE', `Source exceeds ${maxBytes} bytes`, 413);
  }
  return source;
}

export function assertEnvKey(key: unknown): string {
  if (typeof key !== 'string' || !ENV_KEY_RE.test(key)) {
    throw new FunctionError(
      'VALIDATION_ERROR',
      'Invalid env key (UPPER_SNAKE_CASE, max 64 chars)',
      400,
    );
  }
  return key;
}

export function assertEnvValue(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string') {
    throw new FunctionError('VALIDATION_ERROR', 'Env value must be a string', 400);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new FunctionError('VALIDATION_ERROR', 'Env value too large', 413);
  }
  return value;
}

/** Env keys the platform reserves — functions can read but never override. */
const RESERVED_ENV = new Set([
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'CLOUDNIVO_INTERNAL',
  'AWS_SECRET_ACCESS_KEY',
  'STORAGE_SIGNING_SECRET',
]);

export function assertEnvWritable(key: string): void {
  if (RESERVED_ENV.has(key)) {
    throw new FunctionError('FORBIDDEN', `Env key ${key} is reserved by the platform`, 403);
  }
}
