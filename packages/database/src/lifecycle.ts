/**
 * Project-database lifecycle — pure state machine (no I/O, fully unit-tested).
 *
 *   creating → ready → running ⇄ stopped → restarting → ready
 *                          ↘ failed    ↘ deleting → deleted
 *
 * `ready` = provisioned + healthy. `running`/`stopped` are steady operator
 * states reported by the provider. Terminal: `failed`, `deleted`.
 */

export const DATABASE_STATUSES = [
  'creating',
  'ready',
  'running',
  'stopped',
  'restarting',
  'failed',
  'deleting',
  'deleted',
] as const;
export type DatabaseStatus = (typeof DATABASE_STATUSES)[number];

const TRANSITIONS: Record<DatabaseStatus, readonly DatabaseStatus[]> = {
  creating: ['ready', 'failed', 'deleting'],
  ready: ['running', 'stopped', 'restarting', 'deleting', 'failed'],
  running: ['stopped', 'restarting', 'deleting', 'failed'],
  stopped: ['running', 'restarting', 'deleting'],
  restarting: ['ready', 'running', 'failed'],
  failed: ['creating', 'deleting'],
  deleting: ['deleted', 'failed'],
  deleted: [],
};

export function canTransition(from: DatabaseStatus, to: DatabaseStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: DatabaseStatus, to: DatabaseStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal database transition: ${from} → ${to}`);
  }
}

export function isTerminal(status: DatabaseStatus): boolean {
  return status === 'failed' || status === 'deleted';
}

export function isSteady(status: DatabaseStatus): boolean {
  return status === 'ready' || status === 'running' || status === 'stopped';
}

/** Display health reported by live probes (never invented — see health.ts). */
export const DB_HEALTHS = ['healthy', 'unhealthy', 'starting', 'unavailable'] as const;
export type DatabaseHealth = (typeof DB_HEALTHS)[number];

/** Audit event names for database management (passwords never included). */
export const DB_AUDIT_EVENTS = [
  'project.created',
  'database.provisioning.started',
  'database.provisioning.completed',
  'database.provisioning.failed',
  'database.restarted',
  'database.stopped',
  'database.started',
  'database.deleted',
  'database.credentials.accessed',
  'database.query.executed',
  'api_key.created',
  'api_key.revoked',
  'data.created',
  'data.updated',
  'data.deleted',
  'bucket.created',
  'bucket.deleted',
  'bucket.updated',
  'file.uploaded',
  'file.deleted',
  'file.updated',
  'file.moved',
  'file.copied',
  'function.created',
  'function.deploy_started',
  'function.deleted',
  'function.invoked',
  'platform.signup',
  'platform.login',
  'platform.login_failed',
  'org.invite.created',
  'org.invite.accepted',
  'ai.plan.requested',
  'ai.plan.generated',
  'ai.plan.approved',
  'ai.plan.rejected',
  'ai.plan.applied',
  'ai.plan.failed',
  'ai.plan.rolled_back',
  'billing.plan.changed',
  'billing.subscription.canceled',
  'billing.invoice.generated',
  'billing.invoice.voided',
  'billing.payment.recorded',
  'billing.webhook.processed',
  'billing.credit.granted',
  'billing.quota.warning',
] as const;
export type DbAuditEvent = (typeof DB_AUDIT_EVENTS)[number];
