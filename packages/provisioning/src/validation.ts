/**
 * Strict validators for every provider input. Docker container names, db
 * names, and usernames are allow-listed so unsanitized user input can never
 * reach a process API — the primary defense against command injection.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const CONTAINER = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const PG_IDENT = /^[a-z][a-z0-9_]{0,62}$/;
const VERSION = /^\d{2}(\.\d+)?(-alpine)?$/;

export class InvalidProvisionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProvisionInputError';
  }
}

export function assertSlug(slug: string): string {
  if (!SLUG.test(slug)) {
    throw new InvalidProvisionInputError(
      'Slug must be 2-63 chars, lowercase alphanumeric with interior hyphens',
    );
  }
  return slug;
}

export function assertContainerName(name: string): string {
  if (!CONTAINER.test(name))
    throw new InvalidProvisionInputError('Invalid infrastructure identifier');
  return name;
}

export function assertPostgresIdent(name: string, what: string): string {
  if (!PG_IDENT.test(name)) {
    throw new InvalidProvisionInputError(`${what} must start with a letter, a-z/0-9/_ only`);
  }
  return name;
}

export function assertImageVersion(version: string): string {
  if (!VERSION.test(version)) throw new InvalidProvisionInputError('Invalid Postgres version');
  return version;
}

export function assertDbPassword(password: string): string {
  if (password.length < 12 || password.length > 128) {
    throw new InvalidProvisionInputError('Database password must be 12-128 characters');
  }
  return password;
}

/** Deterministic, collision-resistant provider handle. Random suffix, no user data. */
export function containerNameFor(slug: string, randHex: string): string {
  assertSlug(slug);
  if (!/^[0-9a-f]{8}$/.test(randHex))
    throw new InvalidProvisionInputError('Invalid handle entropy');
  return assertContainerName(`cn-${slug.slice(0, 40)}-${randHex}`);
}

export function dbNameFor(slug: string): string {
  return assertPostgresIdent(`cn_${slug.replace(/-/g, '_').slice(0, 40)}_db`, 'Database name');
}

export function dbUserFor(slug: string): string {
  return assertPostgresIdent(`cn_${slug.replace(/-/g, '_').slice(0, 40)}_u`, 'Database user');
}
