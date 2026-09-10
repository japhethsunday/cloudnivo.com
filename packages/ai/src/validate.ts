import { IDENT, type AIPlan, type DestructiveOp } from './plan.js';

/**
 * Semantic plan validation — runs AFTER schema parsing. Checks cross-field
 * invariants the schema cannot express: duplicate tables, dangling foreign
 * keys, missing primary keys, dependency cycles, conflicting resources
 * against live project state, and destructive-operation detection.
 * Pure function over (plan, existing) — no I/O, fully unit-testable.
 */

export interface ExistingState {
  tables: string[];
  buckets: string[];
  functions: string[];
  channels: string[];
  roles: string[];
}

export const EMPTY_STATE: ExistingState = {
  tables: [],
  buckets: [],
  functions: [],
  channels: [],
  roles: [],
};

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  destructive: DestructiveOp[];
}

const DESTRUCTIVE_PATTERNS: { op: DestructiveOp; re: RegExp }[] = [
  { op: 'DROP TABLE', re: /\bdrop\s+table\b/i },
  { op: 'DROP COLUMN', re: /\bdrop\s+column\b/i },
  { op: 'DELETE DATABASE', re: /\b(delete|drop)\s+(the\s+)?database\b/i },
  { op: 'DELETE BUCKET', re: /\bdelete\s+(the\s+)?bucket\b/i },
  { op: 'DELETE FUNCTION', re: /\bdelete\s+(the\s+)?function\b/i },
  { op: 'REMOVE AUTH PROVIDER', re: /\bremove\s+(the\s+)?auth(entication)?\s+provider\b/i },
];

/** Scan free text (prompts, descriptions, generated notes) for destructive intent. */
export function detectDestructiveOps(text: string): DestructiveOp[] {
  const found = new Set<DestructiveOp>();
  for (const { op, re } of DESTRUCTIVE_PATTERNS) {
    if (re.test(text)) found.add(op);
  }
  return [...found];
}

export function validatePlan(plan: AIPlan, existing: ExistingState = EMPTY_STATE): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const destructive = new Set<DestructiveOp>();

  // ── Tables ──
  const tableNames = plan.database.tables.map(t => t.name);
  const dupes = tableNames.filter((n, i) => tableNames.indexOf(n) !== i);
  for (const d of [...new Set(dupes)]) errors.push(`duplicate table: ${d}`);
  const tableSet = new Set(tableNames);

  for (const t of plan.database.tables) {
    const cols = t.columns.map(c => c.name);
    if (new Set(cols).size !== cols.length) errors.push(`table ${t.name}: duplicate columns`);
    for (const pk of t.primaryKey) {
      if (!cols.includes(pk)) errors.push(`table ${t.name}: primary key ${pk} is not a column`);
    }
    if (t.primaryKey.length === 0 && !cols.some(c => t.columns.find(x => x.name === c)?.unique)) {
      errors.push(`table ${t.name}: no primary key and no unique column`);
    }
    if (t.ownerColumn && !cols.includes(t.ownerColumn)) {
      errors.push(`table ${t.name}: owner column ${t.ownerColumn} is not a column`);
    }
    for (const c of t.columns) {
      if (!IDENT.test(c.name)) errors.push(`table ${t.name}: invalid column identifier ${c.name}`);
      if (c.default !== undefined && /;/.test(c.default)) {
        errors.push(`table ${t.name}.${c.name}: default must not contain semicolons`);
      }
    }
    if (existing.tables.includes(t.name)) {
      warnings.push(`table ${t.name} already exists — migration will be additive only`);
    }
  }

  // ── Relationships ──
  const byTable = new Map(
    plan.database.tables.map(t => [t.name, new Set(t.columns.map(c => c.name))]),
  );
  for (const r of plan.database.relationships) {
    if (!tableSet.has(r.fromTable)) errors.push(`relationship: unknown table ${r.fromTable}`);
    if (!tableSet.has(r.toTable)) errors.push(`relationship: unknown table ${r.toTable}`);
    if (byTable.get(r.fromTable)?.has(r.fromColumn) === false) {
      errors.push(`relationship: ${r.fromTable}.${r.fromColumn} is not a column`);
    }
    if (byTable.get(r.toTable)?.has(r.toColumn) === false) {
      errors.push(`relationship: ${r.toTable}.${r.toColumn} is not a column`);
    }
  }
  // Cycle detection over table dependency graph (FK edges).
  const edges = new Map<string, string[]>();
  for (const t of tableNames) edges.set(t, []);
  for (const r of plan.database.relationships) {
    if (tableSet.has(r.fromTable) && tableSet.has(r.toTable) && r.fromTable !== r.toTable) {
      edges.get(r.fromTable)?.push(r.toTable);
    }
  }
  const cycle = findCycle(edges);
  if (cycle)
    warnings.push(
      `foreign-key cycle detected: ${cycle.join(' → ')} — creation order will be deferred-constraint safe`,
    );

  // ── Indexes / policies / roles ──
  for (const ix of plan.database.indexes) {
    if (!tableSet.has(ix.table)) {
      errors.push(`index: unknown table ${ix.table}`);
      continue;
    }
    for (const c of ix.columns) {
      if (!byTable.get(ix.table)?.has(c)) errors.push(`index on ${ix.table}: unknown column ${c}`);
    }
  }
  for (const p of plan.auth.policies) {
    if (!tableSet.has(p.table) && !existing.tables.includes(p.table)) {
      errors.push(`policy: unknown table ${p.table}`);
    }
  }
  const roleNames = new Set(plan.auth.roles.map(r => r.name));
  for (const p of plan.auth.policies) {
    if (p.rule === 'all' && !roleNames.has(p.role) && !['admin', 'service_role'].includes(p.role)) {
      warnings.push(`policy grants ALL on ${p.table} to unknown role ${p.role}`);
    }
  }

  // ── Conflicts with live state ──
  for (const b of plan.storage.buckets) {
    if (existing.buckets.includes(b.name))
      warnings.push(`bucket ${b.name} already exists — kept as-is`);
  }
  for (const f of plan.functions) {
    if (existing.functions.includes(f.name))
      warnings.push(`function ${f.name} already exists — will create a new version`);
  }

  // ── Destructive scan over every free-text field in the plan ──
  const texts = [
    plan.summary,
    ...plan.database.tables.flatMap(t => [t.description]),
    ...plan.functions.flatMap(f => [f.purpose]),
    ...plan.auth.policies.flatMap(p => [p.description]),
  ];
  for (const t of texts) {
    for (const op of detectDestructiveOps(t)) destructive.add(op);
  }

  return { ok: errors.length === 0, errors, warnings, destructive: [...destructive] };
}

function findCycle(edges: Map<string, string[]>): string[] | null {
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    color.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      if (color.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!color.get(m)) {
        const hit = visit(m);
        if (hit) return hit;
      }
    }
    stack.pop();
    color.set(n, 2);
    return null;
  };
  for (const n of edges.keys()) {
    if (!color.get(n)) {
      const hit = visit(n);
      if (hit) return hit;
    }
  }
  return null;
}
