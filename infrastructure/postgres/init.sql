-- CloudNivo control-plane bootstrap.
-- The authoritative schema lives in packages/database (Drizzle + migrations).
-- This init script only ensures required extensions exist for a fresh local DB.
-- It is idempotent and safe to run on every `docker compose up` for a new volume.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
