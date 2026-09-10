/**
 * Leaf error type for the auth package. Lives here (not index.ts) so
 * customer/* modules can extend it without a package-level import cycle:
 * index.ts re-exports this module while customer/service.ts imports it
 * directly. Evaluation order stays safe under native ESM and CJS shims.
 */
export class AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}
