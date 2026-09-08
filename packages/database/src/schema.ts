import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * CloudNivo control-plane schema.
 *
 * Hierarchy: User → Organization → Project → Project Infrastructure.
 * EVERY tenant-scoped row carries `organizationId` directly or via its parent
 * project, so authorization can always be verified server-side without trusting
 * client-supplied IDs (see tenant.ts).
 *
 * Conventions:
 * - UUIDv7-ready PKs (`defaultRandom()` = UUIDv4 today; swappable later).
 * - `createdAt/updatedAt` on all mutable entities for auditability.
 * - Raw API keys are NEVER stored — only `keyHash` + `keyPrefix` (see auth).
 * - No secrets/PII in `auditLogs.metadata` (enforced by code review + logger).
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  passwordHash: text('password_hash'),
  displayName: varchar('display_name', { length: 120 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 63 }).notNull().unique(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('organizations_slug_idx').on(t.slug)],
);

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 20 }).notNull().$type<OrgRole>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('org_memberships_org_user_unique').on(t.organizationId, t.userId),
    index('org_memberships_org_idx').on(t.organizationId),
    index('org_memberships_user_idx').on(t.userId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 63 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('projects_org_slug_unique').on(t.organizationId, t.slug),
    index('projects_org_idx').on(t.organizationId),
  ],
);

export const projectEnvironments = pgTable(
  'project_environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 63 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('project_envs_project_slug_unique').on(t.projectId, t.slug),
    index('project_envs_project_idx').on(t.projectId),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    /** First 8 chars of the raw key — safe to log/display for lookup. */
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    /** SHA-256 hex of the raw key. Raw key is shown once at creation only. */
    keyHash: varchar('key_hash', { length: 128 }).notNull().unique(),
    scopes: text('scopes').array().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('api_keys_project_idx').on(t.projectId)],
);

/** Static RBAC catalog (seeded; app code must not invent permission strings). */
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
});

export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 100 }).notNull().unique(),
  description: text('description'),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  t => [unique('role_permissions_unique').on(t.roleId, t.permissionId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 100 }),
    entityId: uuid('entity_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('audit_logs_org_idx').on(t.organizationId)],
);

/**
 * Phase 2 — project infrastructure metadata.
 *
 * Strictly separated from customer data: these tables live in the CloudNivo
 * CONTROL database and describe provisioned infrastructure. Customer tables
 * live inside each project's own PostgreSQL. Never mix the two.
 *
 * Tenancy: every row resolves to an `organizationId` via its project, so the
 * same `assertSameTenant()` boundary applies (see tenant.ts).
 */

/** Lifecycle of a provisioned project database (see lifecycle.ts). */
export const projectDatabases = pgTable(
  'project_databases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Provider-agnostic handle, e.g. Docker container name. Never user-controlled. */
    databaseId: varchar('database_id', { length: 128 }).notNull().unique(),
    engine: varchar('engine', { length: 20 }).notNull().default('postgres'),
    version: varchar('version', { length: 20 }).notNull().default('16'),
    host: varchar('host', { length: 255 }).notNull(),
    port: integer('port').notNull(),
    dbName: varchar('db_name', { length: 63 }).notNull(),
    dbUser: varchar('db_user', { length: 63 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('creating'),
    region: varchar('region', { length: 63 }).notNull().default('local'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('project_databases_project_unique').on(t.projectId),
    index('project_databases_org_idx').on(t.organizationId),
  ],
);

/**
 * Server-side credentials for project databases.
 * The password is required for health checks, metrics, and user-authorized
 * SQL execution. Access is always membership-checked + audit-logged, never
 * logged, and masked by default in API responses. (Phase 3: KMS envelope
 * encryption for this column.)
 */
export const databaseCredentials = pgTable(
  'database_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectDatabaseId: uuid('project_database_id')
      .notNull()
      .references(() => projectDatabases.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    dbUser: varchar('db_user', { length: 63 }).notNull(),
    dbPassword: text('db_password').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  t => [
    unique('database_credentials_db_unique').on(t.projectDatabaseId),
    index('database_credentials_project_idx').on(t.projectId),
  ],
);

/** Provider-level infrastructure records (one row per Docker container today). */
export const infrastructureInstances = pgTable(
  'infrastructure_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectDatabaseId: uuid('project_database_id')
      .notNull()
      .references(() => projectDatabases.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 40 }).notNull().default('docker'),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('creating'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('infra_instances_db_idx').on(t.projectDatabaseId)],
);

/** Async provisioning operations (see packages/provisioning jobs.ts). */
export const provisioningJobs = pgTable(
  'provisioning_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 40 }).notNull().default('provision'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    /** Client idempotency key — unique per org so double-submits collapse. */
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    logs: jsonb('logs').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('provisioning_jobs_project_idx').on(t.projectId),
    unique('provisioning_jobs_org_key_unique').on(t.organizationId, t.idempotencyKey),
  ],
);
