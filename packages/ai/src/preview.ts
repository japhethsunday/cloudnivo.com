import type { ExistingState } from './validate.js';
import type { AIPlan } from './plan.js';

/**
 * Change detection: compare live project state against a validated plan and
 * render the exact +/−/~ list a developer approves. Nothing here touches
 * infrastructure — it is the approval artifact.
 */

export interface ChangeLine {
  op: '+' | '~' | '-';
  section: 'DATABASE' | 'AUTH' | 'STORAGE' | 'REALTIME' | 'FUNCTIONS' | 'ENV';
  text: string;
}

export function diffPlan(plan: AIPlan, existing: ExistingState): ChangeLine[] {
  const lines: ChangeLine[] = [];
  const existingTables = new Set(existing.tables);
  for (const t of plan.database.tables) {
    lines.push({
      op: existingTables.has(t.name) ? '~' : '+',
      section: 'DATABASE',
      text: existingTables.has(t.name)
        ? `Table ${t.name} exists — additive columns only, no drops`
        : `Create table ${t.name} (${t.columns.map(c => c.name).join(', ')})`,
    });
  }
  for (const r of plan.database.relationships) {
    lines.push({
      op: '+',
      section: 'DATABASE',
      text: `Link ${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`,
    });
  }
  for (const ix of plan.database.indexes) {
    lines.push({
      op: '+',
      section: 'DATABASE',
      text: `Add index on ${ix.table}(${ix.columns.join(', ')})`,
    });
  }
  const existingRoles = new Set(existing.roles);
  for (const r of plan.auth.roles) {
    if (!existingRoles.has(r.name))
      lines.push({ op: '+', section: 'AUTH', text: `Add role ${r.name}` });
  }
  for (const p of plan.auth.policies) {
    lines.push({
      op: '+',
      section: 'AUTH',
      text: `${p.operation} on ${p.table} for ${p.role}: ${p.rule}`,
    });
  }
  const existingBuckets = new Set(existing.buckets);
  for (const b of plan.storage.buckets) {
    lines.push({
      op: existingBuckets.has(b.name) ? '~' : '+',
      section: 'STORAGE',
      text: existingBuckets.has(b.name)
        ? `Bucket ${b.name} exists — kept as-is`
        : `Create ${b.visibility} bucket ${b.name}`,
    });
  }
  const existingChannels = new Set(existing.channels);
  for (const c of plan.realtime.channels) {
    lines.push({
      op: existingChannels.has(c.topic) ? '~' : '+',
      section: 'REALTIME',
      text: `${c.kind} channel ${c.topic}${c.table ? ` (table ${c.table})` : ''}`,
    });
  }
  const existingFunctions = new Set(existing.functions);
  for (const f of plan.functions) {
    lines.push({
      op: existingFunctions.has(f.name) ? '~' : '+',
      section: 'FUNCTIONS',
      text: existingFunctions.has(f.name)
        ? `New version of function ${f.name} (${f.trigger})`
        : `Create function ${f.name} (${f.trigger}): ${f.purpose.slice(0, 120)}`,
    });
  }
  for (const e of plan.env) {
    lines.push({
      op: '+',
      section: 'ENV',
      text: `Declare ${e.secret ? 'secret' : 'variable'} ${e.key}`,
    });
  }
  if (lines.length === 0) {
    lines.push({ op: '~', section: 'DATABASE', text: 'Nothing — plan proposes no changes' });
  }
  return lines;
}

/** Resource estimate from plan shape. Counts only — never fabricated costs. */
export function estimateResources(plan: AIPlan): {
  tables: number;
  relationships: number;
  indexes: number;
  buckets: number;
  channels: number;
  functions: number;
  policies: number;
  migrationStatements: number;
} {
  return {
    tables: plan.database.tables.length,
    relationships: plan.database.relationships.length,
    indexes: plan.database.indexes.length,
    buckets: plan.storage.buckets.length,
    channels: plan.realtime.channels.length,
    functions: plan.functions.length,
    policies: plan.auth.policies.length,
    migrationStatements:
      plan.database.tables.length +
      plan.database.relationships.length +
      plan.database.indexes.length,
  };
}
