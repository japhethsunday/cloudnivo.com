import { z } from 'zod';

/**
 * Strict schema for AI-generated backend plans. Model output is NEVER the
 * source of truth until it parses here — malformed plans are rejected before
 * validation, preview, or execution. Every identifier that can reach SQL is
 * allow-listed at this layer; the migration generator re-validates.
 */

export const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const identField = (what: string): z.ZodType<string> =>
  z
    .string()
    .min(1)
    .max(63)
    .refine(v => IDENT.test(v), { message: `invalid ${what} identifier` });

const slugField = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'must be a kebab-case slug');

export const planColumnSchema = z.object({
  name: identField('column'),
  type: z.enum([
    'uuid',
    'text',
    'integer',
    'bigint',
    'boolean',
    'timestamptz',
    'date',
    'numeric',
    'jsonb',
  ]),
  nullable: z.boolean().default(true),
  default: z.string().max(200).optional(),
  unique: z.boolean().default(false),
});

export const planTableSchema = z.object({
  name: identField('table'),
  description: z.string().max(500).default(''),
  columns: z.array(planColumnSchema).min(1).max(100),
  /** Defaults to ["id"]; use [] only with an explicit unique column. */
  primaryKey: z.array(identField('primary-key column')).max(3).default(['id']),
  ownerColumn: identField('owner column').optional().describe('RLS owner column, e.g. user_id'),
});

export const planRelationshipSchema = z.object({
  fromTable: identField('relationship table'),
  fromColumn: identField('relationship column'),
  toTable: identField('relationship table'),
  toColumn: identField('relationship column'),
  onDelete: z.enum(['cascade', 'restrict', 'set null']).default('restrict'),
});

export const planIndexSchema = z.object({
  table: identField('index table'),
  columns: z.array(identField('index column')).min(1).max(5),
  unique: z.boolean().default(false),
});

export const planPolicySchema = z.object({
  table: identField('policy table'),
  operation: z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
  role: z.string().min(1).max(40),
  rule: z.enum(['own', 'all', 'none', 'authenticated']),
  description: z.string().max(500).default(''),
});

export const planRoleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be a lowercase role name'),
  description: z.string().max(500).default(''),
});

export const planBucketSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'must be a kebab-case bucket name'),
  visibility: z.enum(['private', 'public']).default('private'),
  allowedMimeTypes: z.array(z.string().max(127)).max(20).default([]),
  maxFileMb: z.number().int().min(1).max(5120).default(50),
});

export const planChannelSchema = z.object({
  topic: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9_.:-]+$/, 'must be a safe channel topic'),
  kind: z.enum(['table', 'broadcast', 'presence']).default('broadcast'),
  table: identField('channel table').optional(),
  description: z.string().max(500).default(''),
});

export const planFunctionSchema = z.object({
  name: slugField,
  purpose: z.string().min(10).max(2000),
  trigger: z.enum(['http', 'database_insert', 'database_update', 'schedule', 'manual']),
  table: identField('function table').optional(),
  /** Optional handler source. Absent = scaffold generated at apply time. */
  source: z.string().max(100_000).optional(),
});

export const planEnvSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z_][A-Z0-9_]*$/, 'must be UPPER_SNAKE_CASE'),
  secret: z.boolean().default(false),
  description: z.string().max(500).default(''),
});

export const aiPlanSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(10).max(2000),
  database: z
    .object({
      tables: z.array(planTableSchema).max(50).default([]),
      relationships: z.array(planRelationshipSchema).max(100).default([]),
      indexes: z.array(planIndexSchema).max(100).default([]),
    })
    .default({ tables: [], relationships: [], indexes: [] }),
  auth: z
    .object({
      providers: z.array(z.enum(['email'])).default(['email']),
      roles: z.array(planRoleSchema).max(20).default([]),
      policies: z.array(planPolicySchema).max(200).default([]),
    })
    .default({ providers: ['email'], roles: [], policies: [] }),
  storage: z
    .object({ buckets: z.array(planBucketSchema).max(20).default([]) })
    .default({ buckets: [] }),
  realtime: z
    .object({ channels: z.array(planChannelSchema).max(50).default([]) })
    .default({ channels: [] }),
  functions: z.array(planFunctionSchema).max(30).default([]),
  env: z.array(planEnvSchema).max(50).default([]),
});

export type AIPlan = z.infer<typeof aiPlanSchema>;
export type PlanTable = z.infer<typeof planTableSchema>;
export type PlanRelationship = z.infer<typeof planRelationshipSchema>;
export type PlanPolicy = z.infer<typeof planPolicySchema>;

export class PlanParseError extends Error {
  readonly issues: { field: string; message: string }[];
  constructor(issues: { field: string; message: string }[]) {
    super(`AI plan failed schema validation: ${issues[0]?.message ?? 'unknown'}`);
    this.name = 'PlanParseError';
    this.issues = issues;
  }
}

/** Parse untrusted model output into a validated plan. Throws PlanParseError. */
export function parsePlan(raw: unknown): AIPlan {
  const out = aiPlanSchema.safeParse(raw);
  if (!out.success) {
    throw new PlanParseError(
      out.error.issues.map(i => ({ field: i.path.join('.') || '(root)', message: i.message })),
    );
  }
  return out.data;
}

/** Operations that destroy data or infrastructure. Never auto-applied. */
export const DESTRUCTIVE_OPS = [
  'DROP TABLE',
  'DROP COLUMN',
  'DELETE DATABASE',
  'DELETE BUCKET',
  'DELETE FUNCTION',
  'REMOVE AUTH PROVIDER',
] as const;
export type DestructiveOp = (typeof DESTRUCTIVE_OPS)[number];
