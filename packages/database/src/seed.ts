import { createDatabaseService } from './service.js';
import { permissionsFor, PERMISSIONS, ROLE_HIERARCHY } from './rbac.js';
import { permissions, rolePermissions, roles } from './schema.js';

/**
 * Control-plane seed: static RBAC catalog (`roles`, `permissions`,
 * `role_permissions`). Idempotent (`onConflictDoNothing`) — safe to run on
 * every deploy after `db:migrate`. App code must never invent permission
 * strings; the catalog lives here and in `rbac.ts` (kept in sync by review).
 *
 * Usage: `npm run db:seed --workspace=packages/database`
 * (needs DATABASE_URL; never logs secrets).
 */

const ROLE_DESCRIPTIONS: Record<string, string> = {
  owner: 'Full control of the organization',
  admin: 'Manage members, projects, and settings',
  member: 'Create and work in projects',
  viewer: 'Read-only access',
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('DATABASE_URL is required for seeding');
  const svc = createDatabaseService(url);
  try {
    const health = await svc.healthCheck();
    if (!health.ok) throw new Error(`Control database unreachable: ${health.error ?? 'unknown'}`);
    const db = svc.db;
    for (const key of ROLE_HIERARCHY) {
      await db
        .insert(roles)
        .values({
          key,
          name: key[0]?.toUpperCase() + key.slice(1),
          description: ROLE_DESCRIPTIONS[key] ?? null,
        })
        .onConflictDoNothing({ target: roles.key });
    }
    for (const key of PERMISSIONS) {
      await db
        .insert(permissions)
        .values({ key, description: null })
        .onConflictDoNothing({ target: permissions.key });
    }
    const roleRows = await db.select().from(roles);
    const permRows = await db.select().from(permissions);
    const roleId = new Map(roleRows.map(r => [r.key, r.id]));
    const permId = new Map(permRows.map(p => [p.key, p.id]));
    for (const role of ROLE_HIERARCHY) {
      const rid = roleId.get(role);
      if (!rid) continue;
      for (const perm of permissionsFor(role)) {
        const pid = permId.get(perm);
        if (!pid) continue;
        await db
          .insert(rolePermissions)
          .values({ roleId: rid, permissionId: pid })
          .onConflictDoNothing();
      }
    }
    process.stdout.write(
      `seeded ${ROLE_HIERARCHY.length} roles, ${PERMISSIONS.length} permissions\n`,
    );
  } finally {
    await svc.close();
  }
}

main().catch(err => {
  console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
