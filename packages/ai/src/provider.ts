import { parsePlan, type AIPlan } from './plan.js';

/**
 * Model provider abstraction. The platform never hardcodes one vendor:
 * `LocalPlannerProvider` (deterministic, offline, rule-based NL→plan) is the
 * default; `HttpAIProvider` speaks OpenAI-compatible chat-completions for
 * frontier models when AI_API_KEY is configured. Both return unknown JSON
 * that MUST parse via parsePlan before anything else touches it.
 */

export interface AICapabilities {
  provider: string;
  models: string[];
  jsonMode: boolean;
  streaming: boolean;
}

export interface AIUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  model: string;
}

export interface GenerateResult {
  raw: unknown;
  plan: AIPlan;
  usage: AIUsage;
}

export interface AIProvider {
  readonly name: string;
  getCapabilities(): AICapabilities;
  generate(prompt: string, context: Record<string, unknown>): Promise<GenerateResult>;
}

export interface AIProviderConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

// ── Secret hygiene ────────────────────────────────────────────────

const SECRET_KEY =
  /(password|passwd|secret|api[_-]?key|token|credential|private[_-]?key|signing|jwt|database[_-]?url|connection[_-]?string|\bdsn\b)/i;

/** Deep-strip secret-bearing fields before anything reaches a model. Bounded. */
export function sanitizeContext(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map(v => sanitizeContext(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : sanitizeContext(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 4000);
  return value;
}

/** Scrub a prompt for audit storage: truncate + mask secret assignments. */
export function redactPrompt(prompt: string): string {
  return prompt
    .slice(0, 2000)
    .replace(/(password|secret|api[_-]?key|token)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

// ── Local deterministic planner ───────────────────────────────────

interface EntityDef {
  columns: {
    name: string;
    type: 'uuid' | 'text' | 'integer' | 'boolean' | 'timestamptz' | 'numeric' | 'jsonb';
    unique?: boolean;
  }[];
  owner?: string;
  description: string;
}

const ENTITIES: Record<string, EntityDef> = {
  students: {
    columns: [
      { name: 'full_name', type: 'text' },
      { name: 'email', type: 'text', unique: true },
      { name: 'class_id', type: 'uuid' },
      { name: 'parent_id', type: 'uuid' },
    ],
    owner: 'parent_id',
    description: 'Enrolled students',
  },
  teachers: {
    columns: [
      { name: 'full_name', type: 'text' },
      { name: 'email', type: 'text', unique: true },
      { name: 'subject', type: 'text' },
    ],
    description: 'Teaching staff',
  },
  classes: {
    columns: [
      { name: 'name', type: 'text' },
      { name: 'teacher_id', type: 'uuid' },
      { name: 'schedule', type: 'text' },
    ],
    description: 'Class groups',
  },
  attendance: {
    columns: [
      { name: 'student_id', type: 'uuid' },
      { name: 'class_id', type: 'uuid' },
      { name: 'present', type: 'boolean' },
      { name: 'recorded_at', type: 'timestamptz' },
    ],
    description: 'Daily attendance records',
  },
  assignments: {
    columns: [
      { name: 'title', type: 'text' },
      { name: 'class_id', type: 'uuid' },
      { name: 'due_at', type: 'timestamptz' },
    ],
    description: 'Class assignments',
  },
  results: {
    columns: [
      { name: 'student_id', type: 'uuid' },
      { name: 'assignment_id', type: 'uuid' },
      { name: 'score', type: 'numeric' },
    ],
    owner: 'student_id',
    description: 'Assignment results and grades',
  },
  parents: {
    columns: [
      { name: 'full_name', type: 'text' },
      { name: 'email', type: 'text', unique: true },
    ],
    description: 'Parent accounts linked to students',
  },
  products: {
    columns: [
      { name: 'name', type: 'text' },
      { name: 'price', type: 'numeric' },
      { name: 'category_id', type: 'uuid' },
      { name: 'stock', type: 'integer' },
    ],
    description: 'Catalog products',
  },
  categories: {
    columns: [{ name: 'name', type: 'text', unique: true }],
    description: 'Product categories',
  },
  customers: {
    columns: [
      { name: 'full_name', type: 'text' },
      { name: 'email', type: 'text', unique: true },
    ],
    owner: 'user_id',
    description: 'Store customers',
  },
  orders: {
    columns: [
      { name: 'customer_id', type: 'uuid' },
      { name: 'status', type: 'text' },
      { name: 'total', type: 'numeric' },
    ],
    owner: 'customer_id',
    description: 'Customer orders',
  },
  order_items: {
    columns: [
      { name: 'order_id', type: 'uuid' },
      { name: 'product_id', type: 'uuid' },
      { name: 'quantity', type: 'integer' },
      { name: 'unit_price', type: 'numeric' },
    ],
    description: 'Line items per order',
  },
  payments: {
    columns: [
      { name: 'order_id', type: 'uuid' },
      { name: 'amount', type: 'numeric' },
      { name: 'status', type: 'text' },
    ],
    description: 'Order payments',
  },
  messages: {
    columns: [
      { name: 'channel', type: 'text' },
      { name: 'sender_id', type: 'uuid' },
      { name: 'body', type: 'text' },
    ],
    owner: 'sender_id',
    description: 'Chat messages',
  },
  posts: {
    columns: [
      { name: 'author_id', type: 'uuid' },
      { name: 'title', type: 'text' },
      { name: 'body', type: 'text' },
    ],
    owner: 'author_id',
    description: 'Blog posts',
  },
  comments: {
    columns: [
      { name: 'post_id', type: 'uuid' },
      { name: 'author_id', type: 'uuid' },
      { name: 'body', type: 'text' },
    ],
    owner: 'author_id',
    description: 'Post comments',
  },
  tasks: {
    columns: [
      { name: 'title', type: 'text' },
      { name: 'owner_id', type: 'uuid' },
      { name: 'done', type: 'boolean' },
    ],
    owner: 'owner_id',
    description: 'Todo tasks',
  },
  notifications: {
    columns: [
      { name: 'user_id', type: 'uuid' },
      { name: 'title', type: 'text' },
      { name: 'read', type: 'boolean' },
    ],
    owner: 'user_id',
    description: 'User notifications',
  },
  profiles: {
    columns: [
      { name: 'user_id', type: 'uuid', unique: true },
      { name: 'display_name', type: 'text' },
      { name: 'avatar_url', type: 'text' },
    ],
    owner: 'user_id',
    description: 'Extended user profiles',
  },
};

const RELATIONS: [string, string, string, string][] = [
  ['students', 'class_id', 'classes', 'id'],
  ['students', 'parent_id', 'parents', 'id'],
  ['classes', 'teacher_id', 'teachers', 'id'],
  ['attendance', 'student_id', 'students', 'id'],
  ['attendance', 'class_id', 'classes', 'id'],
  ['assignments', 'class_id', 'classes', 'id'],
  ['results', 'student_id', 'students', 'id'],
  ['results', 'assignment_id', 'assignments', 'id'],
  ['products', 'category_id', 'categories', 'id'],
  ['orders', 'customer_id', 'customers', 'id'],
  ['order_items', 'order_id', 'orders', 'id'],
  ['order_items', 'product_id', 'products', 'id'],
  ['payments', 'order_id', 'orders', 'id'],
  ['comments', 'post_id', 'posts', 'id'],
  ['messages', 'sender_id', 'profiles', 'user_id'],
];

const ROLE_KEYWORDS: Record<string, string[]> = {
  teacher: ['teacher'],
  parent: ['parent'],
  admin: ['admin'],
  customer: ['customer', 'shopper', 'buyer'],
  student: ['student'],
  author: ['author', 'blogger'],
};

const STORAGE_KEYWORDS: {
  match: RegExp;
  bucket: string;
  visibility: 'private' | 'public';
  mime: string[];
}[] = [
  {
    match: /avatar|profile picture|profile pic/i,
    bucket: 'avatars',
    visibility: 'public',
    mime: ['image/'],
  },
  {
    match: /private document|document/i,
    bucket: 'private-documents',
    visibility: 'private',
    mime: [],
  },
  {
    match: /receipt/i,
    bucket: 'receipts',
    visibility: 'private',
    mime: ['image/', 'application/pdf'],
  },
  {
    match: /product image|upload.*image|image.*upload/i,
    bucket: 'product-images',
    visibility: 'public',
    mime: ['image/'],
  },
  { match: /\bimages?\b|\bphotos?\b/i, bucket: 'images', visibility: 'public', mime: ['image/'] },
  {
    match: /assignment.*(file|upload|attach)|homework.*(file|upload)/i,
    bucket: 'assignment-files',
    visibility: 'private',
    mime: [],
  },
];

const REALTIME_KEYWORDS: {
  match: RegExp;
  topic: string;
  kind: 'table' | 'broadcast' | 'presence';
}[] = [
  { match: /\bchat\b/i, topic: 'chat', kind: 'broadcast' },
  { match: /presence|who.?s online|online users/i, topic: 'presence', kind: 'presence' },
  { match: /live|realtime|real-time/i, topic: 'updates', kind: 'broadcast' },
  { match: /notif/i, topic: 'notifications', kind: 'broadcast' },
  { match: /attendance/i, topic: 'attendance', kind: 'broadcast' },
];

const FUNCTION_TRIGGERS: {
  match: RegExp;
  name: string;
  trigger: 'database_insert' | 'http' | 'schedule' | 'manual';
  table?: string;
  purpose: string;
}[] = [
  {
    match: /email.*new order|new order.*email|order.*notif/i,
    name: 'notify-new-order',
    trigger: 'database_insert',
    table: 'orders',
    purpose:
      'Send a confirmation email when a new order row is inserted. Replace the TODO with your mail provider call.',
  },
  {
    match: /notify.*parent|parent.*notif|result.*parent/i,
    name: 'notify-parent',
    trigger: 'database_insert',
    table: 'results',
    purpose:
      'Notify a parent when a new result is recorded for their child. Replace the TODO with your mail/push call.',
  },
  {
    match: /welcome.*(signup|sign-up|user)|new user.*email/i,
    name: 'welcome-email',
    trigger: 'database_insert',
    table: 'customers',
    purpose:
      'Send a welcome email when a customer signs up. Replace the TODO with your mail provider call.',
  },
];

export interface Analysis {
  entities: string[];
  roles: string[];
  wantsStorage: boolean;
  wantsRealtime: boolean;
  intents: string[];
}

export function analyzePrompt(prompt: string): Analysis {
  const entities = Object.keys(ENTITIES).filter(name => {
    const re = new RegExp(`\\b${name.replace(/_/g, '[_\\s]?')}\\b`, 'i');
    const singular = name.endsWith('s') ? name.slice(0, -1) : name;
    return re.test(prompt) || new RegExp(`\\b${singular}\\b`, 'i').test(prompt);
  });
  const roles = Object.keys(ROLE_KEYWORDS).filter(role =>
    ROLE_KEYWORDS[role]?.some(k => new RegExp(`\\b${k}s?\\b`, 'i').test(prompt)),
  );
  const wantsStorage = /avatar|picture|document|image|photo|upload|file|receipt/i.test(prompt);
  const wantsRealtime = /chat|live|realtime|real-time|presence|notif|online/i.test(prompt);
  const intents: string[] = [];
  if (entities.length > 0)
    intents.push(`model ${entities.length} entit${entities.length === 1 ? 'y' : 'ies'}`);
  if (roles.length > 0) intents.push(`authorize ${roles.join(', ')}`);
  if (wantsStorage) intents.push('provision storage');
  if (wantsRealtime) intents.push('enable realtime');
  if (/\bemail\b/i.test(prompt)) intents.push('notify by email');
  return { entities, roles, wantsStorage, wantsRealtime, intents };
}

/** Deterministic NL→plan. Offline, testable, and always schema-valid. */
export class LocalPlannerProvider implements AIProvider {
  readonly name = 'local';

  getCapabilities(): AICapabilities {
    return { provider: 'local', models: ['local-planner-v1'], jsonMode: true, streaming: false };
  }

  async generate(prompt: string, context: Record<string, unknown>): Promise<GenerateResult> {
    const started = Date.now();
    const analysis = analyzePrompt(prompt);
    const existingTables = new Set(
      Array.isArray(context['tables'] as unknown[] | undefined)
        ? ((context['tables'] as string[]) ?? [])
        : [],
    );
    const tables = analysis.entities
      .filter(e => ENTITIES[e] && !existingTables.has(e))
      .map(e => {
        const def = ENTITIES[e] as EntityDef;
        const columns = [
          { name: 'id', type: 'uuid' as const, nullable: false, unique: true },
          ...def.columns.map(c => ({
            name: c.name,
            type: c.type,
            nullable: true,
            unique: c.unique ?? false,
          })),
          { name: 'created_at', type: 'timestamptz' as const, nullable: false, unique: false },
        ];
        // Owner scoping convention: tables carrying a user-ish id column get one.
        const ownerCol =
          def.owner ?? (columns.some(c => c.name === 'user_id') ? 'user_id' : undefined);
        return {
          name: e,
          description: def.description,
          columns,
          primaryKey: ['id'],
          ...(ownerCol ? { ownerColumn: ownerCol } : {}),
        };
      });
    if (tables.length === 0) {
      return {
        raw: { empty: true },
        plan: parsePlan({
          version: 1,
          summary: `Understood: ${analysis.intents.join('; ') || 'no concrete resources detected'}. No new tables proposed — existing project already covers the recognized entities. Name new entities explicitly to extend the schema.`,
          database: { tables: [], relationships: [], indexes: [] },
          auth: { providers: ['email'], roles: [], policies: [] },
          storage: { buckets: [] },
          realtime: { channels: [] },
          functions: [],
          env: [],
        }),
        usage: {
          promptTokens: null,
          completionTokens: null,
          latencyMs: Date.now() - started,
          model: 'local-planner-v1',
        },
      };
    }
    const tableSet = new Set(tables.map(t => t.name));
    const relationships = RELATIONS.filter(([a, , b]) => tableSet.has(a) && tableSet.has(b)).map(
      ([fromTable, fromColumn, toTable, toColumn]) => ({
        fromTable,
        fromColumn,
        toTable,
        toColumn,
        onDelete: 'restrict' as const,
      }),
    );
    const indexes = [...tableSet].flatMap(table => {
      const t = tables.find(x => x.name === table);
      const fkCols = relationships.filter(r => r.fromTable === table).map(r => r.fromColumn);
      const cols = [...new Set([...fkCols, ...(t?.ownerColumn ? [t.ownerColumn] : [])])];
      return cols.length > 0 ? [{ table, columns: cols, unique: false }] : [];
    });

    const roles = [...new Set([...analysis.roles, ...(tables.length > 0 ? ['admin'] : [])])].map(
      name => ({
        name,
        description: `${name} role inferred from request`,
      }),
    );
    const policies = tables.flatMap(t => {
      const owner = (t as { ownerColumn?: string }).ownerColumn;
      const out: {
        table: string;
        operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
        role: string;
        rule: 'own' | 'all' | 'none' | 'authenticated';
        description: string;
      }[] = [];
      for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
        if (owner) {
          out.push({
            table: t.name,
            operation: op,
            role: 'admin',
            rule: 'all',
            description: `admins manage all ${t.name}`,
          });
          for (const r of analysis.roles.filter(x => x !== 'admin')) {
            out.push({
              table: t.name,
              operation: op,
              role: r,
              rule: 'own',
              description: `${r}s access their own ${t.name}`,
            });
          }
        } else {
          out.push({
            table: t.name,
            operation: op,
            role: 'authenticated',
            rule: 'authenticated',
            description: `${t.name} open to project members`,
          });
        }
      }
      return out;
    });

    const buckets = STORAGE_KEYWORDS.filter(s => s.match.test(prompt)).map(s => ({
      name: s.bucket,
      visibility: s.visibility,
      allowedMimeTypes: s.mime,
      maxFileMb: 50,
    }));
    const seenBuckets = new Set<string>();
    const dedupedBuckets = buckets.filter(b =>
      seenBuckets.has(b.name) ? false : (seenBuckets.add(b.name), true),
    );

    const channels: {
      topic: string;
      kind: 'table' | 'broadcast' | 'presence';
      table?: string;
      description: string;
    }[] = REALTIME_KEYWORDS.filter(r => r.match.test(prompt)).map(r => ({
      topic: r.topic,
      kind: r.kind,
      description: `${r.topic} channel`,
    }));
    for (const t of tables) {
      if (
        /messages|notifications|attendance|orders/.test(t.name) &&
        !channels.some(c => c.topic === t.name)
      ) {
        channels.push({
          topic: t.name,
          kind: 'table',
          table: t.name,
          description: `live ${t.name} row changes`,
        });
      }
    }

    const functions = FUNCTION_TRIGGERS.filter(f => f.match.test(prompt)).map(f => ({
      name: f.name,
      purpose: f.purpose,
      trigger: f.trigger,
      ...(f.table && tableSet.has(f.table) ? { table: f.table } : {}),
    }));

    const summaryBits = [
      `${tables.length} tables (${tables.map(t => t.name).join(', ')})`,
      `${relationships.length} relationships`,
      roles.length > 0 ? `roles: ${roles.map(r => r.name).join(', ')}` : null,
      dedupedBuckets.length > 0 ? `buckets: ${dedupedBuckets.map(b => b.name).join(', ')}` : null,
      channels.length > 0 ? `channels: ${channels.map(c => c.topic).join(', ')}` : null,
      functions.length > 0 ? `functions: ${functions.map(f => f.name).join(', ')}` : null,
    ].filter(Boolean);

    const plan = parsePlan({
      version: 1,
      summary: `Backend plan: ${summaryBits.join('; ')}.`,
      database: { tables, relationships, indexes },
      auth: { providers: ['email'], roles, policies },
      storage: { buckets: dedupedBuckets },
      realtime: { channels },
      functions,
      env: [],
    });
    return {
      raw: { planner: 'local-v1', entities: analysis.entities },
      plan,
      usage: {
        promptTokens: null,
        completionTokens: null,
        latencyMs: Date.now() - started,
        model: 'local-planner-v1',
      },
    };
  }
}

// ── HTTP provider (frontier models, env-configured) ─────────────────

const PLAN_SYSTEM_PROMPT = [
  'You are CloudNivo AI Builder. Respond with a single JSON object matching this schema, nothing else.',
  'Top-level: {version:1, summary:string, database:{tables:[{name,description,columns:[{name,type,nullable,unique}],primaryKey,ownerColumn?}],relationships:[{fromTable,fromColumn,toTable,toColumn,onDelete}],indexes:[{table,columns,unique}]},',
  'auth:{providers:["email"],roles:[{name,description}],policies:[{table,operation,role,rule,description}]},',
  'storage:{buckets:[{name,visibility,allowedMimeTypes,maxFileMb}]}, realtime:{channels:[{topic,kind,table?,description}]},',
  'functions:[{name,purpose,trigger,table?}], env:[{key,secret,description}]}.',
  'Column types: uuid|text|integer|bigint|boolean|timestamptz|date|numeric|jsonb. Identifiers: ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$.',
  'Bucket names and function names are kebab-case. Every table needs id uuid + created_at timestamptz.',
  'Never invent DROP/DELETE operations. Never include secrets, keys, or credentials anywhere.',
].join('\n');

export class HttpAIProvider implements AIProvider {
  readonly name: string;
  constructor(private readonly cfg: AIProviderConfig) {
    this.name = cfg.provider;
  }

  getCapabilities(): AICapabilities {
    return {
      provider: this.cfg.provider,
      models: [this.cfg.model],
      jsonMode: true,
      streaming: false,
    };
  }

  async generate(prompt: string, context: Record<string, unknown>): Promise<GenerateResult> {
    const started = Date.now();
    if (!this.cfg.apiKey) throw new Error('AI provider API key is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0.2,
          max_tokens: 4000,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: PLAN_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Request:\n${prompt.slice(0, 8000)}\n\nProject context (secrets stripped):\n${JSON.stringify(sanitizeContext(context)).slice(0, 8000)}`,
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`AI provider responded with HTTP ${res.status}`);
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = body.choices?.[0]?.message?.content ?? '';
      let raw: unknown;
      try {
        raw = JSON.parse(content) as unknown;
      } catch {
        throw new Error('AI provider returned non-JSON output');
      }
      const plan = parsePlan(raw);
      return {
        raw,
        plan,
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? null,
          completionTokens: body.usage?.completion_tokens ?? null,
          latencyMs: Date.now() - started,
          model: this.cfg.model,
        },
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error('AI provider request timed out');
      throw err instanceof Error ? err : new Error('AI provider request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

export function providerFromConfig(cfg: AIProviderConfig): AIProvider {
  if (cfg.provider === 'local' || !cfg.apiKey) return new LocalPlannerProvider();
  return new HttpAIProvider(cfg);
}
