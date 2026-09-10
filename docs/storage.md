# CloudNivo storage architecture (Phase 5)

Real buckets + objects: bytes persist through a provider, metadata stays
tenant-scoped, and every operation is authorized server-side.

## Provider boundary

```text
Routes ──► ObjectStorageService ──► StorageProvider ──► disk / S3
                │                          │
                ▼                          ▼
        MemoryStorageMetadataStore   LocalStorageProvider (streaming fs)
        (Drizzle tables as                 S3CompatibleProvider (SigV4)
         durable target)
```

- `StorageProvider` (13 ops: buckets are metadata-level; objects put/get/
  delete/stat/list/copy + multipart + presigned URLs). Business logic never
  imports `fs` or speaks HTTP to S3 directly.
- `LocalStorageProvider`: streaming writes (temp file + atomic rename, byte
  cap enforced mid-stream), real persistence under `STORAGE_LOCAL_DIR`.
- `S3CompatibleProvider`: SigV4 header + presigned-URL auth over injected
  `fetch` (works against AWS, R2, MinIO with path style). Multipart
  (`createMultipartUpload`/`completeMultipartUpload`) is implemented for large
  objects; the API streams direct PUTs today and can hand out S3 presigned
  upload URLs without code changes.
- Metadata is separate from bytes by design (spec §4): PostgreSQL rows
  (`storage_buckets`, `storage_objects`) vs provider objects.

## Buckets

Per-project names (`avatars`, `documents`…), unique per project, validated
(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`). Properties: visibility
(public/private), per-bucket file cap, MIME allowlist, owner-isolation toggle.
Deletion requires an empty bucket (409 otherwise) so data is never silently
dropped. Max buckets per project is configured (`STORAGE_MAX_BUCKETS`).

## Objects

Logical keys (`avatars/user-123/profile.png`) validated against traversal,
null bytes, absolute/drive paths, and length limits — then namespaced to
`p_<project>/b_<bucket>/<path>` internally. Metadata tracks filename, sniffed
MIME, size, sha256 etag, timestamps. Writes execute once; upserts are explicit
(`409` by default, `?upsert=true` to overwrite); move = copy + delete;
delete removes bytes AND metadata. Project deletion cascades all storage.

## Uploads without RAM blowups

- Local provider streams socket → temp file with a mid-stream byte cap;
  oversized streams abort and clean up.
- Route cap (`STORAGE_MAX_FILE_MB`, default 50 MB) enforced while reading.
- `upload-sign` mints capability tokens for direct PUTs; S3 multipart APIs
  exist for resumable large uploads.

## Signed URLs

HMAC-SHA256 capability tokens binding project + bucket + path + op +
expiry (+ nonce). Separate namespaces for download vs upload (cross-use
rejected). TTL floor 60s, ceiling `STORAGE_MAX_SIGNED_TTL_S`. Redeemed at
`.../storage/s/:token` with no auth headers — the token IS the credential —
and verified with constant-time comparison. S3 deployments use native
presigned URLs through the same route shapes.

## Public vs private

- Public bucket: exact-path anonymous download (+ signed URLs). Listing,
  upload, and management always require auth — no enumeration.
- Private bucket: every byte gated by `authorize()`; reads fail as 404 (no
  existence oracle), writes as 403.

## Policies

`authorize(bucket, caller, op, path)`: platform owner/admin = full; member =
objects + reads, no bucket management; viewer = read-only; service/admin keys
= full object access; public keys = read-only; customer users = owner-prefix
(`<userId>/…`) when the bucket enforces isolation (default on), admins bypass;
anonymous = public downloads only. Keys never manage buckets; customers never
touch key management (no escalation).

## Validation

Filenames, MIME allowlists per bucket, per-file and quota caps. Browser MIME
is untrusted: magic-byte sniffing reconciles it — mismatches downgrade to the
sniffed type, executable spoofs are rejected, and serving uses
`inline` only for a safe preview allowlist (images, PDF, text, JSON);
everything else (HTML/SVG/JS/zips/binaries) is `attachment`.

## Quotas + rate limits + events

Per-project bytes/files/uploads/downloads tracked on every mutation
(overwrites/deletes adjust, not just add); quota enforced pre- and
post-write (overshoot rolls back the bytes). Upload/download/sign/list/delete
share the `storage` rate bucket (`STORAGE_RATE_MAX`) plus the global IP
limiter (Redis-backed in prod). Every mutation emits audit events
(`bucket.*`, `file.*`) with IDs only — never paths-as-secrets or bytes.

## Local development vs production

Local: `STORAGE_DRIVER=local`, bytes under `STORAGE_LOCAL_DIR` (git-ignored,
ephemeral — back up or use S3 for anything durable). Production/Railway: set
`STORAGE_DRIVER=s3` + `STORAGE_S3_*`; see `docs/deploy-railway.md`. Never
commit credentials.

## AI-generated buckets (Phase 9)

The AI Builder proposes visibility/MIME/size-capped buckets as plan data; creation goes through the standard bucket API after approval. See docs/ai-builder.md.
