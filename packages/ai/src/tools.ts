import type { ExistingState } from './validate.js';
import type { PermissionLevel } from './approvals.js';

/**
 * AI tool boundary. Each tool declares its required permission level and
 * validates + authorizes its own arguments through injected service adapters
 * — the AI's decision is never treated as permission. Adapters are wired in
 * the API layer to real CloudNivo services, project-scoped at construction.
 */

export type ToolName =
  | 'inspect_project'
  | 'inspect_database'
  | 'create_migration'
  | 'create_bucket'
  | 'create_function'
  | 'enable_realtime';

export interface ToolDef {
  name: ToolName;
  description: string;
  minLevel: PermissionLevel;
  destructive: boolean;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'inspect_project',
    description: 'Read project resources (tables, buckets, functions, channels)',
    minLevel: 'READ_ONLY',
    destructive: false,
  },
  {
    name: 'inspect_database',
    description: 'Read live database schema',
    minLevel: 'READ_ONLY',
    destructive: false,
  },
  {
    name: 'create_migration',
    description: 'Execute validated DDL migration statements',
    minLevel: 'ADMIN',
    destructive: false,
  },
  {
    name: 'create_bucket',
    description: 'Create a storage bucket from a validated plan',
    minLevel: 'ADMIN',
    destructive: false,
  },
  {
    name: 'create_function',
    description: 'Create + deploy a scanned function from a validated plan',
    minLevel: 'ADMIN',
    destructive: false,
  },
  {
    name: 'enable_realtime',
    description: 'Enable CDC table feeds for validated table channels',
    minLevel: 'ADMIN',
    destructive: false,
  },
];

const LEVEL_RANK: Record<PermissionLevel, number> = {
  READ_ONLY: 0,
  PLAN: 1,
  APPROVAL_REQUIRED: 2,
  AUTO_APPLY_SAFE: 3,
  ADMIN: 4,
};

export class ToolError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.status = status;
  }
}

export function checkToolPermission(tool: ToolName, level: PermissionLevel): void {
  const def = TOOLS.find(t => t.name === tool);
  if (!def) throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${String(tool).slice(0, 60)}`, 400);
  if (LEVEL_RANK[level] < LEVEL_RANK[def.minLevel]) {
    throw new ToolError('TOOL_FORBIDDEN', `Tool ${tool} requires ${def.minLevel}`, 403);
  }
}

/** Live project facts handed to the planner. Secrets are never included. */
export interface ProjectContext {
  projectId: string;
  tables: { schema: string; name: string; columns: string[] }[];
  buckets: { name: string; visibility: string }[];
  functions: { slug: string; status: string }[];
  channels: string[];
  roles: string[];
  recentChanges: string[];
}

export function contextToExisting(ctx: ProjectContext): ExistingState {
  return {
    tables: ctx.tables.map(t => t.name),
    buckets: ctx.buckets.map(b => b.name),
    functions: ctx.functions.map(f => f.slug),
    channels: [...ctx.channels],
    roles: [...ctx.roles],
  };
}

/** Service adapters, bound to one project by the API layer. */
export interface ToolAdapters {
  inspectProject(): Promise<ProjectContext>;
  inspectDatabase(): Promise<{ schema: string; name: string; columns: string[] }[]>;
  executeMigration(statements: string[]): Promise<{ executed: number }>;
  rollbackMigration(rollbackStatements: string[]): Promise<{ rolledBack: number }>;
  createBucket(input: {
    name: string;
    visibility: 'private' | 'public';
    allowedMimeTypes: string[];
    maxFileMb: number;
  }): Promise<{ name: string }>;
  createFunction(input: {
    name: string;
    purpose: string;
    source: string;
  }): Promise<{ slug: string; jobId: string }>;
  enableRealtime(input: {
    topic: string;
    kind: string;
    table?: string;
  }): Promise<{ topic: string }>;
}

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

/** Execute one tool call: permission → arg validation → adapter → verified result. */
export async function executeTool(
  adapters: ToolAdapters,
  level: PermissionLevel,
  call: ToolCall,
): Promise<{ ok: boolean; result: unknown }> {
  checkToolPermission(call.tool, level);
  const args = call.args ?? {};
  switch (call.tool) {
    case 'inspect_project': {
      return { ok: true, result: await adapters.inspectProject() };
    }
    case 'inspect_database': {
      return { ok: true, result: await adapters.inspectDatabase() };
    }
    case 'create_migration': {
      const statements = args['statements'];
      if (!Array.isArray(statements) || statements.length === 0 || statements.length > 200) {
        throw new ToolError('BAD_ARGS', 'statements must be a non-empty array (max 200)', 400);
      }
      for (const s of statements) {
        if (typeof s !== 'string' || s.length === 0 || s.length > 20_000) {
          throw new ToolError('BAD_ARGS', 'each statement must be a bounded string', 400);
        }
      }
      return { ok: true, result: await adapters.executeMigration(statements as string[]) };
    }
    case 'create_bucket': {
      const { name, visibility, allowedMimeTypes, maxFileMb } = args as Record<string, unknown>;
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
        throw new ToolError('BAD_ARGS', 'invalid bucket name', 400);
      }
      if (visibility !== 'private' && visibility !== 'public')
        throw new ToolError('BAD_ARGS', 'invalid visibility', 400);
      return {
        ok: true,
        result: await adapters.createBucket({
          name,
          visibility,
          allowedMimeTypes: Array.isArray(allowedMimeTypes)
            ? (allowedMimeTypes as string[]).slice(0, 20)
            : [],
          maxFileMb: typeof maxFileMb === 'number' ? Math.min(Math.max(maxFileMb, 1), 5120) : 50,
        }),
      };
    }
    case 'create_function': {
      const { name, purpose, source } = args as Record<string, unknown>;
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
        throw new ToolError('BAD_ARGS', 'invalid function name', 400);
      }
      if (typeof purpose !== 'string' || purpose.length < 10)
        throw new ToolError('BAD_ARGS', 'purpose required', 400);
      if (typeof source !== 'string' || source.length === 0 || source.length > 100_000) {
        throw new ToolError('BAD_ARGS', 'source must be a bounded string', 400);
      }
      return { ok: true, result: await adapters.createFunction({ name, purpose, source }) };
    }
    case 'enable_realtime': {
      const { topic, kind, table } = args as Record<string, unknown>;
      if (typeof topic !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(topic)) {
        throw new ToolError('BAD_ARGS', 'invalid topic', 400);
      }
      if (kind !== 'table' && kind !== 'broadcast' && kind !== 'presence') {
        throw new ToolError('BAD_ARGS', 'invalid channel kind', 400);
      }
      return {
        ok: true,
        result: await adapters.enableRealtime({
          topic,
          kind,
          table: typeof table === 'string' ? table : undefined,
        }),
      };
    }
    default:
      throw new ToolError('UNKNOWN_TOOL', 'Unknown tool', 400);
  }
}
