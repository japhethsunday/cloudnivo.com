/**
 * Static OpenAPI path fragments for function management + invocation.
 * Merged with table/storage/realtime paths at serve time.
 */
export function functionsOpenApiPaths(): Record<string, unknown> {
  const bearer = [{ bearerAuth: [] }];
  const param = (name: string, description: string): unknown => ({
    name,
    in: 'path',
    required: true,
    description,
    schema: { type: 'string' },
  });
  return {
    '/functions': {
      get: {
        summary: 'List functions',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Create function',
        description: 'Creates a CREATING record; deploy source separately.',
        security: bearer,
        responses: { '201': { description: 'Created' } },
      },
    },
    '/functions/{slug}': {
      parameters: [param('slug', 'Function slug or id')],
      get: {
        summary: 'Get function',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
      patch: {
        summary: 'Update function',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
      delete: {
        summary: 'Delete function',
        security: bearer,
        responses: { '204': { description: 'Deleted' } },
      },
    },
    '/functions/{slug}/deploy': {
      post: {
        summary: 'Deploy source',
        description:
          'Accepts `{ source, runtime?, entrypoint? }`, runs the async build pipeline, returns the job. Poll the deployment until READY.',
        parameters: [param('slug', 'Function slug or id')],
        security: bearer,
        responses: { '202': { description: 'Accepted' } },
      },
    },
    '/functions/{slug}/redeploy': {
      post: {
        summary: 'Redeploy latest version source',
        parameters: [param('slug', 'Function slug or id')],
        security: bearer,
        responses: { '202': { description: 'Accepted' } },
      },
    },
    '/functions/{slug}/invoke': {
      post: {
        summary: 'Invoke active version',
        description:
          'Session member, project key, or project customer JWT. Body becomes the handler request (size-capped).',
        parameters: [param('slug', 'Function slug or id')],
        responses: { '200': { description: 'Function result' } },
      },
    },
    '/functions/{slug}/logs': {
      get: {
        summary: 'Function logs',
        parameters: [param('slug', 'Function slug or id')],
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/functions/{slug}/versions': {
      get: {
        summary: 'Version history',
        parameters: [param('slug', 'Function slug or id')],
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/functions/{slug}/env': {
      get: {
        summary: 'List env vars (secrets masked)',
        parameters: [param('slug', 'Function slug or id')],
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
      put: {
        summary: 'Set env var',
        parameters: [param('slug', 'Function slug or id')],
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
  };
}
