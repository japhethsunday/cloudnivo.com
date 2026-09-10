import { randomUUID } from 'node:crypto';
import {
  detectDestructiveOps,
  validatePlan,
  type ExistingState,
  type PlanValidation,
} from './validate.js';
import { diffPlan, estimateResources, type ChangeLine } from './preview.js';
import { parsePlan, type AIPlan, type DestructiveOp } from './plan.js';

/**
 * Plan lifecycle + permission levels. A plan moves
 * pending → approved|rejected → applying → applied|failed (→ rolled_back
 * where a safe inverse exists). Destructive plans additionally require an
 * explicit per-operation confirmation set — approval alone never suffices.
 * The AI never holds more permission than the initiating caller: every
 * transition re-checks the caller's level.
 */

export type PlanStatus =
  'pending' | 'approved' | 'rejected' | 'applying' | 'applied' | 'failed' | 'rolled_back';

export type PermissionLevel =
  'READ_ONLY' | 'PLAN' | 'APPROVAL_REQUIRED' | 'AUTO_APPLY_SAFE' | 'ADMIN';

/** Map a CloudNivo membership role to the max AI permission it confers. */
export function levelForRole(role: string): PermissionLevel {
  if (role === 'owner' || role === 'admin') return 'ADMIN';
  if (role === 'member') return 'APPROVAL_REQUIRED';
  return 'READ_ONLY';
}

export interface StoredPlan {
  id: string;
  projectId: string;
  organizationId: string;
  userId: string;
  prompt: string;
  provider: string;
  model: string;
  plan: AIPlan;
  validation: PlanValidation;
  changes: ChangeLine[];
  estimate: ReturnType<typeof estimateResources>;
  status: PlanStatus;
  confirmations: DestructiveOp[];
  appliedSteps: { step: string; ok: boolean; detail: string }[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class PlanError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    this.status = status;
  }
}

export class PlanStore {
  private readonly plans = new Map<string, StoredPlan>();

  create(input: {
    projectId: string;
    organizationId: string;
    userId: string;
    prompt: string;
    provider: string;
    model: string;
    raw: unknown;
    existing: ExistingState;
  }): StoredPlan {
    const plan = parsePlan(input.raw);
    const validation = validatePlan(plan, input.existing);
    const now = new Date().toISOString();
    const stored: StoredPlan = {
      id: randomUUID(),
      projectId: input.projectId,
      organizationId: input.organizationId,
      userId: input.userId,
      prompt: input.prompt.slice(0, 2000),
      provider: input.provider,
      model: input.model,
      plan,
      validation,
      changes: diffPlan(plan, input.existing),
      estimate: estimateResources(plan),
      status: 'pending',
      confirmations: [],
      appliedSteps: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(stored.id, stored);
    return stored;
  }

  get(projectId: string, planId: string): StoredPlan {
    const p = this.plans.get(planId);
    if (!p || p.projectId !== projectId) throw new PlanError('NOT_FOUND', 'Plan not found', 404);
    return p;
  }

  list(projectId: string): StoredPlan[] {
    return [...this.plans.values()]
      .filter(p => p.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  approve(
    projectId: string,
    planId: string,
    level: PermissionLevel,
    confirmations: DestructiveOp[],
  ): StoredPlan {
    const p = this.get(projectId, planId);
    if (p.status !== 'pending')
      throw new PlanError('CONFLICT', `Plan is ${p.status}, not pending`, 409);
    if (level !== 'ADMIN' && level !== 'AUTO_APPLY_SAFE') {
      throw new PlanError('FORBIDDEN', 'Approving plans requires admin', 403);
    }
    if (!p.validation.ok)
      throw new PlanError(
        'INVALID_PLAN',
        `Plan has errors: ${p.validation.errors[0] ?? 'unknown'}`,
        422,
      );
    const missing = p.validation.destructive.filter(d => !confirmations.includes(d));
    if (missing.length > 0) {
      throw new PlanError(
        'CONFIRM_DESTRUCTIVE',
        `Explicit confirmation required: ${missing.join(', ')}`,
        428,
      );
    }
    p.status = 'approved';
    p.confirmations = [...confirmations];
    p.updatedAt = new Date().toISOString();
    return p;
  }

  reject(projectId: string, planId: string): StoredPlan {
    const p = this.get(projectId, planId);
    if (p.status !== 'pending')
      throw new PlanError('CONFLICT', `Plan is ${p.status}, not pending`, 409);
    p.status = 'rejected';
    p.updatedAt = new Date().toISOString();
    return p;
  }

  markApplying(projectId: string, planId: string): StoredPlan {
    const p = this.get(projectId, planId);
    if (p.status !== 'approved')
      throw new PlanError('CONFLICT', 'Only approved plans can be applied', 409);
    p.status = 'applying';
    p.updatedAt = new Date().toISOString();
    return p;
  }

  recordStep(projectId: string, planId: string, step: string, ok: boolean, detail: string): void {
    const p = this.get(projectId, planId);
    p.appliedSteps.push({ step, ok, detail: detail.slice(0, 500) });
    p.updatedAt = new Date().toISOString();
  }

  markFinished(
    projectId: string,
    planId: string,
    ok: boolean,
    error: string | null,
    rolledBack: boolean,
  ): StoredPlan {
    const p = this.get(projectId, planId);
    p.status = rolledBack ? 'rolled_back' : ok ? 'applied' : 'failed';
    p.error = error?.slice(0, 500) ?? null;
    p.updatedAt = new Date().toISOString();
    return p;
  }
}

export { detectDestructiveOps };
