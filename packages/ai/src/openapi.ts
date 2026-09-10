/**
 * Static OpenAPI path fragments for the AI Builder. Merged with table/storage/
 * realtime/function paths at serve time.
 */
export function aiOpenApiPaths(): Record<string, unknown> {
  const bearer = [{ bearerAuth: [] }];
  return {
    '/ai/plan': {
      post: {
        summary: 'Generate backend plan',
        description: 'Natural-language request → validated structured plan (never executes).',
        security: bearer,
        responses: {
          '201': { description: 'Plan created' },
          '429': { description: 'Rate limited' },
        },
      },
    },
    '/ai/plans': {
      get: {
        summary: 'List plans',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/ai/plans/{planId}': {
      get: {
        summary: 'Plan detail with preview, diff, validation, migration SQL',
        security: bearer,
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/ai/plans/{planId}/approve': {
      post: {
        summary: 'Approve plan (admin; destructive ops need explicit confirmations)',
        security: bearer,
        responses: {
          '200': { description: 'Approved' },
          '428': { description: 'Confirmation required' },
        },
      },
    },
    '/ai/plans/{planId}/reject': {
      post: {
        summary: 'Reject plan',
        security: bearer,
        responses: { '200': { description: 'Rejected' } },
      },
    },
    '/ai/plans/{planId}/apply': {
      post: {
        summary: 'Apply approved plan through project-bound tools',
        security: bearer,
        responses: { '200': { description: 'Applied' }, '409': { description: 'Not approved' } },
      },
    },
    '/ai/usage': {
      get: {
        summary: 'AI usage counters',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/ai/history': {
      get: {
        summary: 'AI audit history',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
  };
}
