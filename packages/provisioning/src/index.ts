/**
 * ProvisioningService — how `Project → Project Infrastructure` gets realized.
 *
 * Phase 1 is intentionally local-only: `LocalProvisioningService` records the
 * desired state and provisions nothing billable. The interface already models
 * async operations (plan → apply → status) so a future Terraform/Cloud-API
 * driver can replace it without touching callers.
 */

export type ProvisioningStatus = 'pending' | 'provisioning' | 'ready' | 'failed';

export interface ProvisionPlan {
  projectId: string;
  organizationId: string;
  environmentSlug: string;
  database: { engine: 'postgres'; version: string };
  storage: { driver: 'local' | 's3' };
  realtime: { driver: 'memory' | 'redis' };
}

export interface ProvisionOperation {
  id: string;
  status: ProvisioningStatus;
  plan: ProvisionPlan;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningService {
  readonly driver: string;
  plan(input: Omit<ProvisionPlan, 'storage' | 'realtime'>): Promise<ProvisionPlan>;
  apply(plan: ProvisionPlan): Promise<ProvisionOperation>;
  status(operationId: string): Promise<ProvisionOperation | null>;
}

let counter = 0;

export class LocalProvisioningService implements ProvisioningService {
  readonly driver = 'local';
  private readonly ops = new Map<string, ProvisionOperation>();

  async plan(input: Omit<ProvisionPlan, 'storage' | 'realtime'>): Promise<ProvisionPlan> {
    if (!input.projectId || !input.organizationId || !input.environmentSlug) {
      throw new Error('Provision plan requires projectId, organizationId, environmentSlug');
    }
    return {
      ...input,
      storage: { driver: 'local' },
      realtime: { driver: 'memory' },
      database: input.database ?? { engine: 'postgres', version: '16' },
    };
  }

  async apply(plan: ProvisionPlan): Promise<ProvisionOperation> {
    counter += 1;
    const now = new Date().toISOString();
    const op: ProvisionOperation = {
      id: `op_local_${counter}`,
      status: 'ready',
      plan,
      message: 'Local plan recorded (no cloud resources provisioned in Phase 1)',
      createdAt: now,
      updatedAt: now,
    };
    this.ops.set(op.id, op);
    return op;
  }

  async status(operationId: string): Promise<ProvisionOperation | null> {
    return this.ops.get(operationId) ?? null;
  }
}

export function createProvisioningService(): ProvisioningService {
  return new LocalProvisioningService();
}
