/**
 * Domain errors with explicit { code, status } so the API envelope maps
 * them structurally (no 500s for client mistakes, no leaks for infra faults).
 */
export class DbToolsError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'DbToolsError';
    this.code = code;
    this.status = status;
  }
}
