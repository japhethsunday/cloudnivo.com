-- Environment-level authorization.
--
-- The `environment` on a migration is caller-supplied, so it cannot decide
-- whether the production approval gate applies: a token holding
-- database.destructive could declare 'development', target the same database,
-- and skip the gate entirely. These two columns move that decision to the
-- server.
--
-- is_production marks which environments are production, on the row.
-- environments confines an agent token to named environments; production is
-- never implied by an empty list and must be granted explicitly.

ALTER TABLE "project_environments"
  ADD COLUMN IF NOT EXISTS "is_production" boolean DEFAULT false NOT NULL;

ALTER TABLE "agent_tokens"
  ADD COLUMN IF NOT EXISTS "environments" text[] DEFAULT '{}'::text[] NOT NULL;

-- Existing rows that are production by convention are marked as such, so the
-- gate is not silently weaker for projects created before this migration.
UPDATE "project_environments"
   SET "is_production" = true
 WHERE "is_production" = false
   AND lower("slug") IN ('production', 'prod');

CREATE INDEX IF NOT EXISTS "project_envs_production_idx"
  ON "project_environments" ("project_id", "is_production");
