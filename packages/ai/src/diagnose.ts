/**
 * Deterministic failure analyzer (the AI Debugger's engine).
 *
 * Rule-based over real evidence — failed jobs, function error logs, failed
 * AI plans — with pattern-matched causes, affected service, suggested fix,
 * and an honest confidence level. No LLM, no guessing: unknown failures say
 * so and point at the raw evidence.
 */

export interface DiagnosisEvidence {
  source: 'job' | 'function-log' | 'ai-plan';
  ref: string;
  excerpt: string;
  at: string;
}

export interface DiagnosisInput {
  jobs: { id: string; kind: string; status: string; lastError: string | null; updatedAt: string }[];
  functionErrors: { function: string; message: string; at: string }[];
  planFailures: { planId: string; summary: string; error: string; at: string }[];
  note?: string;
}

export interface Diagnosis {
  healthy: boolean;
  probableCause: string;
  affectedService: string;
  evidence: DiagnosisEvidence[];
  suggestedFix: string;
  confidence: 'low' | 'medium' | 'high';
}

interface Rule {
  service: string;
  cause: string;
  fix: string;
  confidence: 'low' | 'medium' | 'high';
  test: RegExp;
}

const RULES: Rule[] = [
  {
    service: 'database',
    cause: 'Database provisioning or connectivity failure',
    fix: 'Open the project database view and check status, then retry the operation. If Docker or the managed database is unreachable, the platform reports INFRA_UNAVAILABLE — fix connectivity before retrying.',
    confidence: 'high',
    test: /provision|docker|container|connection refused|password authentication|INFRA_UNAVAILABLE|credential/i,
  },
  {
    service: 'functions',
    cause: 'Function build failure (source does not load or entrypoint missing)',
    fix: 'Open Functions → the failing function and read the deploy job log. Fix the syntax error or entrypoint export, then redeploy — failed builds never replace the active version.',
    confidence: 'high',
    test: /BUILD_FAILED|entrypoint|syntax|failed to load|NOT_DEPLOYED/i,
  },
  {
    service: 'functions',
    cause: 'Function timeout or crash at runtime',
    fix: 'Check the function logs for the failing invocation, split long work into smaller calls, and raise the execution timeout in project settings if the workload legitimately needs it.',
    confidence: 'medium',
    test: /FUNCTION_TIMEOUT|timed out|exceeded|RUNTIME_ERROR|INVOCATION_FAILED/i,
  },
  {
    service: 'api',
    cause: 'Rate limiting rejecting traffic',
    fix: 'The 429 responses name the exhausted budget (IP, key, or project). Back off and retry with jitter, or spread load across keys.',
    confidence: 'high',
    test: /RATE_LIMITED|429|too many/i,
  },
  {
    service: 'auth',
    cause: 'Authentication or CORS rejection',
    fix: 'Confirm the caller sends a valid session JWT, project apikey, or customer token, and that the origin is allow-listed in Authentication settings.',
    confidence: 'medium',
    test: /UNAUTHORIZED|FORBIDDEN|CORS|origin|INVALID_KEY|TOKEN_EXPIRED|TOKEN_REVOKED/i,
  },
  {
    service: 'billing',
    cause: 'Quota or plan limit blocking the operation',
    fix: 'Open Usage/Billing to see the exhausted meter, then wait for the next period or change plan.',
    confidence: 'medium',
    test: /quota|LIMIT_EXCEEDED|past_due|subscription/i,
  },
  {
    service: 'ai',
    cause: 'AI plan validation or apply failure',
    fix: 'Open the plan to read the validation errors, adjust the request to avoid the blocked operations, then generate a fresh plan.',
    confidence: 'medium',
    test: /validation|destructive|rolled back|rolled_back|apply failed/i,
  },
  {
    service: 'storage',
    cause: 'Storage operation failure',
    fix: 'Verify the bucket exists and the caller has access, then retry. Signed URLs expire — generate a fresh one.',
    confidence: 'medium',
    test: /bucket|object|STORAGE_ERROR|expired url|presign/i,
  },
];

export function diagnose(input: DiagnosisInput): Diagnosis {
  const evidence: DiagnosisEvidence[] = [];
  for (const j of input.jobs.filter(j => j.status === 'failed').slice(0, 5)) {
    evidence.push({
      source: 'job',
      ref: `${j.kind}:${j.id.slice(0, 8)}`,
      excerpt: (j.lastError ?? 'failed without a recorded error').slice(0, 300),
      at: j.updatedAt,
    });
  }
  for (const f of input.functionErrors.slice(0, 5)) {
    evidence.push({ source: 'function-log', ref: f.function, excerpt: f.message.slice(0, 300), at: f.at });
  }
  for (const p of input.planFailures.slice(0, 3)) {
    evidence.push({
      source: 'ai-plan',
      ref: p.planId.slice(0, 8),
      excerpt: `${p.summary} — ${p.error}`.slice(0, 300),
      at: p.at,
    });
  }
  if (evidence.length === 0) {
    return {
      healthy: true,
      probableCause: 'No recent failures detected in jobs, function logs, or AI plans',
      affectedService: 'none',
      evidence: [],
      suggestedFix: 'If something still misbehaves, reproduce it once (invoke the function or rerun the query) and diagnose again — fresh evidence beats old logs.',
      confidence: 'high',
    };
  }
  const haystack = `${evidence.map(e => e.excerpt).join('\n')}\n${input.note ?? ''}`;
  for (const rule of RULES) {
    if (rule.test.test(haystack)) {
      return {
        healthy: false,
        probableCause: rule.cause,
        affectedService: rule.service,
        evidence,
        suggestedFix: rule.fix,
        confidence: rule.confidence,
      };
    }
  }
  return {
    healthy: false,
    probableCause: 'Unrecognized failure signature — see the evidence below',
    affectedService: evidence[0]?.source === 'job' ? 'jobs' : (evidence[0]?.source ?? 'unknown'),
    evidence,
    suggestedFix:
      'Start from the newest evidence entry: open the linked logs, reproduce with a minimal call, and narrow from there.',
    confidence: 'low',
  };
}
