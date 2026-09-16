/**
 * What to show for a project's database.
 *
 * A project whose provisioning failed has no database record at all, and every
 * surface used to fall back to the literal string "provisioning" — so a dead
 * project claimed to be busy forever, with the real error sitting unread in its
 * provision job. Derive the state from both facts instead, and never claim work
 * is in flight when the job that would do it has already failed.
 */

export interface ProvisionJobLike {
  status: string;
  lastError?: string | null;
}

export interface DatabaseLike {
  status: string;
  health?: string;
}

export interface DatabaseState {
  /** Word shown to the user. */
  label: string;
  /** True while provisioning is genuinely still running. */
  pending: boolean;
  /** The provisioner's own error, when the last attempt failed. */
  error: string | null;
  /** True when the project has no database and none is being made. */
  actionable: boolean;
}

export function databaseState(
  database: DatabaseLike | null | undefined,
  job: ProvisionJobLike | null | undefined,
): DatabaseState {
  if (database) {
    return { label: database.status, pending: false, error: null, actionable: false };
  }
  if (job && (job.status === 'pending' || job.status === 'running' || job.status === 'retrying')) {
    return { label: 'provisioning', pending: true, error: null, actionable: false };
  }
  if (job && job.status === 'failed') {
    return {
      label: 'provisioning failed',
      pending: false,
      error: job.lastError ?? null,
      actionable: true,
    };
  }
  // No database and no job to explain it: honest "nothing here", not "busy".
  return { label: 'not provisioned', pending: false, error: null, actionable: true };
}
