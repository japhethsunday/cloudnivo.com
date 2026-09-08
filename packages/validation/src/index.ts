import { z } from 'zod';

/**
 * Shared runtime validation primitives.
 * Every API boundary MUST validate with these (or stricter) schemas —
 * never trust client-supplied IDs, roles, or ownership claims.
 */

export const uuidSchema = z.string().uuid('must be a valid UUID');

export const slugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'must be a kebab-case slug')
  .describe('URL-safe project/org slug');

export const emailSchema = z.string().email().max(320);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** Standard envelope validation for outgoing error payloads (see api-core). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export function formatZodIssues(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map(i => ({
    field: i.path.join('.') || '(root)',
    message: i.message,
  }));
}

/** Control-plane entity schemas (also mirrored in database package). */
export const organizationSchema = z.object({
  name: z.string().min(2).max(100),
  slug: slugSchema,
});

export const projectSchema = z.object({
  name: z.string().min(2).max(100),
  slug: slugSchema,
  organizationId: uuidSchema,
  environment: z.enum(['development', 'staging', 'production']).default('development'),
});

export const apiKeySchema = z.object({
  name: z.string().min(1).max(100),
  projectId: uuidSchema,
  expiresAt: z.string().datetime().optional(),
});
