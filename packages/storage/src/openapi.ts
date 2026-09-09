/**
 * Static OpenAPI path fragments for the storage plane, merged with the
 * per-project table paths from `@cloudnivo/api-engine` at serve time.
 * `{projectId}` is templated by the route handler.
 */

export function storageOpenApiPaths(): Record<string, unknown> {
  const obj = (summary: string, description: string, extra: Record<string, unknown> = {}) => ({
    summary,
    description,
    ...extra,
    responses: {
      '200': { description: 'OK' },
      '201': { description: 'Created' },
      '202': { description: 'Accepted' },
      '400': { description: 'Validation error' },
      '401': { description: 'Unauthorized' },
      '403': { description: 'Forbidden' },
      '404': { description: 'Not found' },
      '409': { description: 'Conflict' },
      '413': { description: 'Too large' },
      '429': { description: 'Rate limited' },
    },
  });
  const bucketParam = { name: 'bucket', in: 'path', required: true, schema: { type: 'string' } };
  const authNote = 'Session JWT, project apikey, or customer JWT (owner-scoped).';
  return {
    '/storage/buckets': {
      get: obj('List buckets', `Project buckets. ${authNote}`),
      post: obj(
        'Create bucket',
        'Admin/owner only. Body: { name, visibility, fileSizeLimit, allowedMimeTypes, ownerIsolation }.',
      ),
    },
    '/storage/buckets/{bucket}': {
      get: obj('Get bucket', 'Bucket metadata.', { parameters: [bucketParam] }),
      delete: obj('Delete bucket', 'Must be empty. Admin/owner only.', {
        parameters: [bucketParam],
      }),
    },
    '/storage/buckets/{bucket}/objects': {
      get: obj('List objects', 'Query: prefix, limit (1-200), offset.', {
        parameters: [bucketParam],
      }),
    },
    '/storage/buckets/{bucket}/objects/{path}': {
      get: obj('Download object', 'Streams bytes. Anonymous iff bucket is public.', {
        parameters: [
          bucketParam,
          { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
      put: obj('Upload object', 'Raw request body (streamed). `?upsert=true` overwrites.', {
        parameters: [bucketParam],
      }),
      delete: obj('Delete object', 'Removes bytes + metadata.', { parameters: [bucketParam] }),
    },
    '/storage/buckets/{bucket}/objects/{path}/metadata': {
      get: obj('Object metadata', 'No bytes transferred.', { parameters: [bucketParam] }),
    },
    '/storage/buckets/{bucket}/objects/{path}/move': {
      post: obj('Move object', 'Body: { dest }.', { parameters: [bucketParam] }),
    },
    '/storage/buckets/{bucket}/objects/{path}/copy': {
      post: obj('Copy object', 'Body: { dest }.', { parameters: [bucketParam] }),
    },
    '/storage/buckets/{bucket}/sign': {
      post: obj(
        'Sign URL',
        'Body: { path, op: download|upload, expiresIn }. Returns capability token URL.',
        {
          parameters: [bucketParam],
        },
      ),
    },
    '/storage/s/{token}': {
      get: obj('Redeem download token', 'No auth header — the token IS the credential. Expires.', {
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      }),
      put: obj('Redeem upload token', 'PUT raw bytes to the pre-authorized path.', {
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    },
    '/storage/usage': {
      get: obj('Storage usage', 'Files, bytes, uploads, downloads vs quota.', {}),
    },
  };
}
