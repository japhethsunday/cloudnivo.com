/**
 * Rule-based database advisors over real pg statistics. Every finding cites
 * the measurement it came from (table, numbers, query) so results are
 * auditable, never vibes. Findings are advisory: the API surfaces them,
 * apply paths stay explicit (index creation runs through the guarded SQL
 * route with approval where destructive).
 */

export interface AdvisorFinding {
  id: string;
  severity: 'info' | 'warn' | 'critical';
  category: 'index' | 'query' | 'health' | 'storage';
  title: string;
  detail: string;
  /** Concrete next step (SQL where safe to suggest). */
  suggestion: string;
  /** Evidence the rule fired on. */
  evidence: Record<string, string | number | boolean | null>;
}

export type StatsQuery = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function safeQuery(
  run: StatsQuery,
  text: string,
  findings: AdvisorFinding[],
  onRows: (rows: Record<string, unknown>[]) => void,
  ruleId: string,
): Promise<void> {
  try {
    onRows(await run(text, []));
  } catch {
    findings.push({
      id: `${ruleId}-unavailable`,
      severity: 'info',
      category: 'health',
      title: 'Statistics source unavailable',
      detail: `Skipped ${ruleId}: the monitoring view is not readable with this role.`,
      suggestion: 'Grant pg_monitor or run as the project owner role.',
      evidence: { rule: ruleId },
    });
  }
}

/** Unused indexes (never scanned) outside tiny tables. */
export async function adviseUnusedIndexes(run: StatsQuery): Promise<AdvisorFinding[]> {
  const findings: AdvisorFinding[] = [];
  await safeQuery(
    run,
    `select schemaname as schema, relname as tbl, indexrelname as idx,
            idx_scan as scans, pg_relation_size(indexrelid) as bytes
     from pg_stat_user_indexes
     order by pg_relation_size(indexrelid) desc`,
    findings,
    rows => {
      for (const r of rows.slice(0, 200)) {
        if (num(r['scans']) === 0 && num(r['bytes']) > 8192) {
          findings.push({
            id: `unused-index:${str(r['schema'])}.${str(r['idx'])}`,
            severity: 'warn',
            category: 'index',
            title: `Unused index ${str(r['schema'])}.${str(r['idx'])}`,
            detail: `Index on ${str(r['tbl'])} was never scanned and occupies ${num(r['bytes'])} bytes — pure write overhead.`,
            suggestion: `DROP INDEX "${str(r['schema'])}"."${str(r['idx'])}"; -- verify query plans first`,
            evidence: { schema: str(r['schema']), table: str(r['tbl']), index: str(r['idx']), bytes: num(r['bytes']) },
          });
        }
      }
    },
    'unused-indexes',
  );
  return findings;
}

/** Foreign-key columns without a supporting index (join + delete penalty). */
export async function adviseMissingFkIndexes(run: StatsQuery): Promise<AdvisorFinding[]> {
  const findings: AdvisorFinding[] = [];
  await safeQuery(
    run,
    `select tc.table_schema as schema, tc.table_name as tbl, kcu.column_name as col
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu
       on tc.constraint_name = kcu.constraint_name
      and tc.table_schema = kcu.table_schema
     where tc.constraint_type = 'FOREIGN KEY'`,
    findings,
    async fkRows => {
      let indexed: Set<string> = new Set();
      try {
        const idxRows = await run(
          `select schemaname as schema, tablename as tbl, indexdef as defn from pg_indexes
           where schemaname not in ('pg_catalog','information_schema')`,
          [],
        );
        indexed = new Set(
          idxRows.map(r => `${str(r['schema'])}.${str(r['tbl'])}::${str(r['defn'])}`),
        );
      } catch {
        return;
      }
      for (const r of fkRows.slice(0, 200)) {
        const key = `${str(r['schema'])}.${str(r['tbl'])}`;
        const covered = [...indexed].some(
          entry => entry.startsWith(`${key}::`) && entry.includes(str(r['col'])),
        );
        if (!covered) {
          findings.push({
            id: `missing-fk-index:${key}.${str(r['col'])}`,
            severity: 'warn',
            category: 'index',
            title: `Foreign key without index: ${key}(${str(r['col'])})`,
            detail: 'Unindexed FK columns slow down joins and make parent deletes scan the child table.',
            suggestion: `CREATE INDEX CONCURRENTLY ON "${str(r['schema'])}"."${str(r['tbl'])}" ("${str(r['col'])}");`,
            evidence: { schema: str(r['schema']), table: str(r['tbl']), column: str(r['col']) },
          });
        }
      }
    },
    'missing-fk-indexes',
  );
  return findings;
}

/** Sequential-scan-heavy tables and cache hit ratio (query/health). */
export async function adviseQueryHealth(run: StatsQuery): Promise<AdvisorFinding[]> {
  const findings: AdvisorFinding[] = [];
  await safeQuery(
    run,
    `select schemaname as schema, relname as tbl, seq_scan as seq, seq_tup_read as seqrows,
            idx_scan as idx, n_live_tup as live
     from pg_stat_user_tables`,
    findings,
    rows => {
      for (const r of rows.slice(0, 200)) {
        const seq = num(r['seq']);
        const idx = num(r['idx']);
        const live = num(r['live']);
        if (seq > 100 && live > 10_000 && idx / Math.max(1, seq) < 0.1) {
          findings.push({
            id: `seq-scan:${str(r['schema'])}.${str(r['tbl'])}`,
            severity: 'warn',
            category: 'query',
            title: `Sequential scans dominate ${str(r['schema'])}.${str(r['tbl'])}`,
            detail: `${seq} sequential scans vs ${idx} index scans on ~${live} live rows. Check WHERE clauses and missing indexes.`,
            suggestion: 'Run EXPLAIN ANALYZE on the hot queries (database/query accepts EXPLAIN).',
            evidence: { schema: str(r['schema']), table: str(r['tbl']), seqScans: seq, indexScans: idx, liveRows: live },
          });
        }
      }
    },
    'query-health',
  );
  await safeQuery(
    run,
    `select sum(heap_blks_read) as reads, sum(heap_blks_hit) as hits from pg_statio_user_tables`,
    findings,
    rows => {
      const reads = num(rows[0]?.['reads']);
      const hits = num(rows[0]?.['hits']);
      const total = reads + hits;
      if (total > 10_000) {
        const ratio = hits / total;
        if (ratio < 0.9) {
          findings.push({
            id: 'cache-hit-ratio',
            severity: ratio < 0.8 ? 'critical' : 'warn',
            category: 'health',
            title: `Low buffer cache hit ratio (${(ratio * 100).toFixed(1)}%)`,
            detail: 'Most reads hit disk. Consider more memory, connection pooling, or hotter working-set indexes.',
            suggestion: 'Review PROVISION_MAX_DB_SIZE_MB and query patterns before scaling.',
            evidence: { hitRatio: Number(ratio.toFixed(4)), heapReads: reads, heapHits: hits },
          });
        }
      }
    },
    'cache-ratio',
  );
  return findings;
}

/** Bloat-prone tables (high dead-tuple ratio) + long-running transactions. */
export async function adviseMaintenance(run: StatsQuery): Promise<AdvisorFinding[]> {
  const findings: AdvisorFinding[] = [];
  await safeQuery(
    run,
    `select schemaname as schema, relname as tbl, n_live_tup as live, n_dead_tup as dead,
            last_autovacuum as av
     from pg_stat_user_tables`,
    findings,
    rows => {
      for (const r of rows.slice(0, 200)) {
        const live = num(r['live']);
        const dead = num(r['dead']);
        if (live > 1000 && dead / Math.max(1, live) > 0.5) {
          findings.push({
            id: `bloat:${str(r['schema'])}.${str(r['tbl'])}`,
            severity: 'warn',
            category: 'storage',
            title: `Dead-tuple bloat on ${str(r['schema'])}.${str(r['tbl'])}`,
            detail: `${dead} dead vs ${live} live tuples. Autovacuum may be falling behind.`,
            suggestion: `VACUUM (ANALYZE) "${str(r['schema'])}"."${str(r['tbl'])}";`,
            evidence: { schema: str(r['schema']), table: str(r['tbl']), liveTuples: live, deadTuples: dead },
          });
        }
      }
    },
    'maintenance',
  );
  return findings;
}

/** Replication/lag visibility (empty on standalone — honest, not an error). */
export async function replicationStatus(run: StatsQuery): Promise<{
  replicas: { client: string; state: string; lagBytes: number }[];
  inRecovery: boolean;
}> {
  try {
    const rec = await run(`select pg_is_in_recovery() as rec`, []);
    const inRecovery = rec[0]?.['rec'] === true;
    const rows = await run(
      `select client_addr as client, state as state,
              pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) as lag
       from pg_stat_replication`,
      [],
    );
    return {
      replicas: rows.map(r => ({
        client: str(r['client']),
        state: str(r['state']),
        lagBytes: num(r['lag']),
      })),
      inRecovery,
    };
  } catch {
    return { replicas: [], inRecovery: false };
  }
}

export async function runAllAdvisors(run: StatsQuery): Promise<AdvisorFinding[]> {
  const groups = await Promise.all([
    adviseUnusedIndexes(run),
    adviseMissingFkIndexes(run),
    adviseQueryHealth(run),
    adviseMaintenance(run),
  ]);
  return groups.flat().slice(0, 200);
}
