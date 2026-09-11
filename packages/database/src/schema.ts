import {
  bigint,
  boolean,
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
    region: varchar('region', { length: 63 }).notNull().default('local'),
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
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    name: varchar('name', { length: 100 }).notNull(),
    /** First 8 chars of the raw key — safe to log/display for lookup. */
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    /** SHA-256 hex of the raw key. Raw key is shown once at creation only. */
    keyHash: varchar('key_hash', { length: 128 }).notNull().unique(),
    role: varchar('role', { length: 20 }).notNull().default('public'),
    scopes: text('scopes').array().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    requestCount: integer('request_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
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
    maxAttempts: integer('max_attempts').notNull().default(3),
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

/**
 * Phase 5 — storage metadata (control plane; bytes live in the provider).
 * Mirrors `MemoryStorageMetadataStore` record shapes 1:1 so the durable
 * adapter swaps in without touching routes.
 */
export const storageBuckets = pgTable(
  'storage_buckets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 63 }).notNull(),
    visibility: varchar('visibility', { length: 10 }).notNull().default('private'),
    fileSizeLimit: integer('file_size_limit'),
    allowedMimeTypes: text('allowed_mime_types').array().notNull().default([]),
    ownerIsolation: varchar('owner_isolation', { length: 5 }).notNull().default('true'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('storage_buckets_project_name_unique').on(t.projectId, t.name),
    index('storage_buckets_org_idx').on(t.organizationId),
  ],
);

export const storageObjects = pgTable(
  'storage_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    bucketId: uuid('bucket_id')
      .notNull()
      .references(() => storageBuckets.id, { onDelete: 'cascade' }),
    bucket: varchar('bucket', { length: 63 }).notNull(),
    path: varchar('path', { length: 1024 }).notNull(),
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 127 }).notNull(),
    size: integer('size').notNull().default(0),
    etag: varchar('etag', { length: 64 }).notNull().default(''),
    storageKey: text('storage_key').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('storage_objects_bucket_path_unique').on(t.bucketId, t.path),
    index('storage_objects_project_idx').on(t.projectId),
  ],
);

/**
 * Phase 7 — serverless functions (control plane; execution is isolated).
 * Mirrors the in-memory `FunctionService` record shapes 1:1 so the durable
 * adapter swaps in without touching routes. Source bytes live in versions
 * (content-hashed); secret env values stay in `function_env_vars` and are
 * masked on every read path.
 */
export const functions = pgTable(
  'functions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    slug: varchar('slug', { length: 63 }).notNull(),
    description: text('description').notNull().default(''),
    runtime: varchar('runtime', { length: 20 }).notNull().default('node22'),
    entrypoint: varchar('entrypoint', { length: 128 }).notNull().default('handler'),
    status: varchar('status', { length: 20 }).notNull().default('creating'),
    activeVersion: integer('active_version').notNull().default(0),
    lastError: text('last_error'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deployedAt: timestamp('deployed_at', { withTimezone: true }),
  },
  t => [
    unique('functions_project_slug_unique').on(t.projectId, t.slug),
    index('functions_org_idx').on(t.organizationId),
  ],
);

export const functionVersions = pgTable(
  'function_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    functionId: uuid('function_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    sourceHash: varchar('source_hash', { length: 64 }).notNull(),
    sourceBytes: integer('source_bytes').notNull().default(0),
    source: text('source').notNull(),
    runtime: varchar('runtime', { length: 20 }).notNull().default('node22'),
    entrypoint: varchar('entrypoint', { length: 128 }).notNull().default('handler'),
    active: varchar('active', { length: 5 }).notNull().default('false'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('function_versions_fn_version_unique').on(t.functionId, t.version),
    index('function_versions_fn_idx').on(t.functionId),
  ],
);

export const functionEnvVars = pgTable(
  'function_env_vars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    functionId: uuid('function_id')
      .notNull()
      .references(() => functions.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 64 }).notNull(),
    value: text('value').notNull(),
    secret: varchar('secret', { length: 5 }).notNull().default('false'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('function_env_fn_key_unique').on(t.functionId, t.key),
    index('function_env_fn_idx').on(t.functionId),
  ],
);

/**
 * Phase 8 — durable control-plane adapters.
 *
 * - `project_auth_configs`: per-project browser allowlists (memory
 *   `Map` in `MemoryRegistry` mirrors this shape 1:1).
 * - `organization_invites`: opaque-token org invites (sha256 only stored).
 * - `storage_usage`: per-project upload/download counters backing
 *   `StorageMetadataStore.usage()` (objects table gives files/bytes live).
 */

export const projectAuthConfigs = pgTable(
  'project_auth_configs',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    allowedOrigins: text('allowed_origins').array().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('project_auth_configs_org_idx').on(t.organizationId)],
);

export const organizationInvites = pgTable(
  'organization_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: varchar('role', { length: 20 }).notNull().default('member'),
    /** SHA-256 hex of the opaque token. The raw token is shown once. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('org_invites_org_idx').on(t.organizationId),
    index('org_invites_email_idx').on(t.email),
  ],
);

export const storageUsage = pgTable(
  'storage_usage',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    uploads: integer('uploads').notNull().default(0),
    downloads: integer('downloads').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('storage_usage_org_idx').on(t.organizationId)],
);

/**
 * Phase 12 — billing + usage metering.
 *
 * Billing belongs to organizations; usage is measured per organization,
 * project (`''` project id = org-level rollup row in aggregates), service,
 * and metric, bucketed by UTC `YYYY-MM` period. Raw events are retention-
 * bounded (see BILLING_RAW_RETENTION_DAYS); aggregates are the read path.
 * No payment credentials are ever stored — only provider references.
 */

export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' })
      .unique(),
    planId: varchar('plan_id', { length: 20 }).notNull().default('free'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    renewsAt: timestamp('renews_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    provider: varchar('provider', { length: 40 }).notNull().default('manual'),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('billing_subs_status_idx').on(t.status)],
);

export const billingInvoices = pgTable(
  'billing_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    number: varchar('number', { length: 40 }).notNull().unique(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    /** Line items: [{ label, quantity, unitCents, amountCents }]. No PII. */
    lines: jsonb('lines')
      .$type<{ label: string; quantity: number; unitCents: number; amountCents: number }[]>()
      .notNull()
      .default([]),
    amountCents: integer('amount_cents').notNull().default(0),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    status: varchar('status', { length: 20 }).notNull().default('open'),
    provider: varchar('provider', { length: 40 }).notNull().default('manual'),
    providerInvoiceId: text('provider_invoice_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('billing_invoices_org_idx').on(t.organizationId)],
);

export const billingPayments = pgTable(
  'billing_payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id').references(() => billingInvoices.id, { onDelete: 'set null' }),
    amountCents: integer('amount_cents').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    provider: varchar('provider', { length: 40 }).notNull().default('manual'),
    providerPaymentId: text('provider_payment_id').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('billing_payments_org_idx').on(t.organizationId)],
);

export const billingEvents = pgTable(
  'billing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 40 }).notNull(),
    eventId: varchar('event_id', { length: 200 }).notNull(),
    type: varchar('type', { length: 100 }).notNull(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    /** Redacted at write time: ids + status only, never payloads with secrets. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('billing_events_provider_event_unique').on(t.provider, t.eventId),
    index('billing_events_org_idx').on(t.organizationId),
  ],
);

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Empty string = org-level event (no single project). Plain text on purpose. */
    projectId: varchar('project_id', { length: 64 }).notNull().default(''),
    service: varchar('service', { length: 40 }).notNull(),
    metric: varchar('metric', { length: 40 }).notNull(),
    value: bigint('value', { mode: 'number' }).notNull(),
    period: varchar('period', { length: 7 }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('usage_records_org_period_idx').on(t.organizationId, t.period, t.service, t.metric),
    index('usage_records_recorded_idx').on(t.recordedAt),
  ],
);

export const usageAggregates = pgTable(
  'usage_aggregates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: varchar('project_id', { length: 64 }).notNull().default(''),
    service: varchar('service', { length: 40 }).notNull(),
    metric: varchar('metric', { length: 40 }).notNull(),
    period: varchar('period', { length: 7 }).notNull(),
    total: bigint('total', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('usage_agg_org_proj_svc_metric_period_unique').on(
      t.organizationId,
      t.projectId,
      t.service,
      t.metric,
      t.period,
    ),
    index('usage_agg_period_idx').on(t.period),
  ],
);

export const billingWarnings = pgTable(
  'billing_warnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    resource: varchar('resource', { length: 60 }).notNull(),
    period: varchar('period', { length: 7 }).notNull(),
    thresholds: text('thresholds').array().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    unique('billing_warnings_org_resource_period_unique').on(
      t.organizationId,
      t.resource,
      t.period,
    ),
  ],
);

export const billingCredits = pgTable(
  'billing_credits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull().default(0),
    reason: varchar('reason', { length: 200 }).notNull().default(''),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('billing_credits_org_idx').on(t.organizationId)],
);

/**
 * Phase 13 — agent access tokens.
 *
 * Dedicated credentials for AI/developer agents (Claude Code, OpenCode…),
 * deliberately separate from project API keys: organization- or
 * project-scoped, granular scopes, expiry, instant revocation, and an
 * optional approval gate for destructive operations. Only sha256 hashes are
 * stored — raw tokens are shown once at creation and never logged.
 */
export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    name: varchar('name', { length: 100 }).notNull(),
    prefix: varchar('prefix', { length: 20 }).notNull(),
    keyHash: text('key_hash').notNull().unique(),
    scopes: text('scopes').array().notNull().default([]),
    projectIds: text('project_ids').array().notNull().default([]),
    approvalRequired: boolean('approval_required').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    requestCount: integer('request_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('agent_tokens_user_idx').on(t.userId),
    index('agent_tokens_org_idx').on(t.organizationId),
  ],
);

export const agentApprovals = pgTable(
  'agent_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: varchar('project_id', { length: 64 }),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => agentTokens.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: varchar('action', { length: 80 }).notNull(),
    method: varchar('method', { length: 10 }).notNull(),
    path: varchar('path', { length: 500 }).notNull(),
    bodyHash: varchar('body_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('agent_approvals_org_idx').on(t.organizationId),
    index('agent_approvals_token_idx').on(t.tokenId),
    index('agent_approvals_status_idx').on(t.status),
  ],
);

export const agentActivity = pgTable(
  'agent_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenId: uuid('token_id').references(() => agentTokens.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),
    projectId: varchar('project_id', { length: 64 }),
    action: varchar('action', { length: 80 }).notNull(),
    resource: varchar('resource', { length: 300 }).notNull().default(''),
    result: varchar('result', { length: 20 }).notNull(),
    reason: varchar('reason', { length: 300 }).notNull().default(''),
    ip: varchar('ip', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('agent_activity_token_idx').on(t.tokenId),
    index('agent_activity_org_idx').on(t.organizationId),
    index('agent_activity_created_idx').on(t.createdAt),
  ],
);

/**
 * Phase 14 — automation (queues, schedules, webhooks, deliveries).
 * Tenant scoping mirrors the agent tables: every row carries
 * `organizationId` + `projectId` so authorization never trusts client IDs.
 */
export const automationQueues = pgTable(
  'automation_queues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: varchar('project_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    maxDeliveries: integer('max_deliveries').notNull().default(5),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('automation_queues_project_idx').on(t.projectId),
    unique('automation_queues_project_name_ux').on(t.projectId, t.name),
  ],
);

export const automationMessages = pgTable(
  'automation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queueId: uuid('queue_id')
      .notNull()
      .references(() => automationQueues.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: varchar('project_id', { length: 64 }).notNull(),
    body: jsonb('body').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    status: varchar('status', { length: 20 }).notNull().default('queued'),
    deliveries: integer('deliveries').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('automation_messages_queue_idx').on(t.queueId),
    index('automation_messages_status_idx').on(t.status),
  ],
);

export const automationSchedules = pgTable(
  'automation_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: varchar('project_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    functionSlug: varchar('function_slug', { length: 100 }).notNull(),
    cron: varchar('cron', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: varchar('last_status', { length: 20 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('automation_schedules_project_idx').on(t.projectId),
    index('automation_schedules_next_idx').on(t.nextRunAt),
    unique('automation_schedules_project_name_ux').on(t.projectId, t.name),
  ],
);

export const automationWebhooks = pgTable(
  'automation_webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: varchar('project_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    url: varchar('url', { length: 2000 }).notNull(),
    eventTypes: jsonb('event_types').notNull(),
    secretPrefix: varchar('secret_prefix', { length: 16 }).notNull(),
    secretHash: varchar('secret_hash', { length: 64 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    maxAttempts: integer('max_attempts').notNull().default(6),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('automation_webhooks_project_idx').on(t.projectId),
    unique('automation_webhooks_project_name_ux').on(t.projectId, t.name),
  ],
);

export const automationDeliveries = pgTable(
  'automation_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => automationWebhooks.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: varchar('project_id', { length: 64 }).notNull(),
    eventType: varchar('event_type', { length: 40 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    attempts: jsonb('attempts').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('automation_deliveries_webhook_idx').on(t.webhookId),
    index('automation_deliveries_status_idx').on(t.status),
    index('automation_deliveries_next_idx').on(t.nextAttemptAt),
  ],
);
