# Docker images (Phase 2)

Phase 1 runs `apps/dashboard` (Vercel) + `apps/api` (Node) without custom
images — `docker-compose.yml` only provides Postgres 16 + Redis 7.

When custom images are needed, add `Dockerfile.api` / `Dockerfile.dashboard`
here building from the workspace `dist/` output. Keep them distroless and
secret-free (all config via environment).
