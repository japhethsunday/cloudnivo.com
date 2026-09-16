/**
 * Known OIDC providers, as presets over the generic SSO connection.
 *
 * CloudNivo's SSO client is provider-agnostic: discovery plus PKCE plus JWKS
 * verification works against any conformant OIDC provider, and nothing here
 * adds a second authentication system. What a preset removes is the part
 * administrators actually get wrong — the exact issuer URL, the application
 * type that produces a usable client secret, and the redirect URI that must
 * match on both sides.
 */

export interface SsoPreset {
  id: string;
  label: string;
  /**
   * Issuer template with `{tenant}` / `{domain}` placeholders. Empty for
   * providers whose issuer has no predictable shape.
   */
  issuerTemplate: string;
  /** What the placeholder means, in the provider's own vocabulary. */
  placeholderHint: string;
  /** The application type in the provider's console that this flow needs. */
  applicationType: string;
  /** Scopes CloudNivo requests; recorded so the preset can be verified. */
  scopes: string[];
  /** Provider-specific setup notes an admin needs before it will work. */
  notes: string[];
  docsUrl: string;
}

export const SSO_PRESETS: readonly SsoPreset[] = [
  {
    id: 'logto',
    label: 'Logto',
    issuerTemplate: 'https://{tenant}.logto.app/oidc',
    placeholderHint: 'Your Logto tenant ID, from the endpoint in Logto → Settings.',
    applicationType: 'Traditional web',
    scopes: ['openid', 'profile', 'email'],
    notes: [
      'The issuer must end in /oidc — Logto serves its discovery document at <endpoint>/oidc/.well-known/openid-configuration.',
      'Create a "Traditional web" application. Native and single-page apps are public clients with no secret, and this flow needs a confidential one.',
      'Logto registers traditional web apps with token_endpoint_auth_method=client_secret_basic; CloudNivo reads that from discovery and authenticates accordingly.',
      'Self-hosted Logto works the same way: use your own endpoint in place of the logto.app host.',
    ],
    docsUrl: 'https://docs.logto.io/integrate-logto/traditional-web',
  },
  {
    id: 'auth0',
    label: 'Auth0',
    issuerTemplate: 'https://{tenant}.us.auth0.com/',
    placeholderHint: 'Your Auth0 tenant and region, e.g. acme.eu.',
    applicationType: 'Regular web application',
    scopes: ['openid', 'profile', 'email'],
    notes: ['Add the callback URL to "Allowed Callback URLs" on the application.'],
    docsUrl: 'https://auth0.com/docs/get-started/authentication-and-authorization-flow',
  },
  {
    id: 'okta',
    label: 'Okta',
    issuerTemplate: 'https://{domain}/oauth2/default',
    placeholderHint: 'Your Okta domain, e.g. acme.okta.com.',
    applicationType: 'Web application',
    scopes: ['openid', 'profile', 'email'],
    notes: ['Use the authorization server issuer, not the org URL alone.'],
    docsUrl: 'https://developer.okta.com/docs/guides/sign-into-web-app-redirect/',
  },
  {
    id: 'entra',
    label: 'Microsoft Entra ID',
    issuerTemplate: 'https://login.microsoftonline.com/{tenant}/v2.0',
    placeholderHint: 'Your directory (tenant) ID.',
    applicationType: 'Web',
    scopes: ['openid', 'profile', 'email'],
    notes: ['Register a Web platform redirect URI; SPA platform will not issue a secret.'],
    docsUrl: 'https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc',
  },
  {
    id: 'google',
    label: 'Google Workspace',
    issuerTemplate: 'https://accounts.google.com',
    placeholderHint: 'No tenant value — Google uses one issuer for every domain.',
    applicationType: 'Web application',
    scopes: ['openid', 'profile', 'email'],
    notes: ['Restrict sign-in to your domain in the Google Cloud console.'],
    docsUrl: 'https://developers.google.com/identity/openid-connect/openid-connect',
  },
  {
    id: 'generic',
    label: 'Other OIDC provider',
    issuerTemplate: '',
    placeholderHint: 'Paste the issuer URL from the provider.',
    applicationType: 'Confidential client with a secret',
    scopes: ['openid', 'profile', 'email'],
    notes: ['Any provider that serves an OIDC discovery document works.'],
    docsUrl: 'https://openid.net/specs/openid-connect-discovery-1_0.html',
  },
];

export function ssoPreset(id: string): SsoPreset | null {
  return SSO_PRESETS.find(p => p.id === id) ?? null;
}

/**
 * Fill a preset's issuer template. Returns null when the preset needs a
 * value the caller did not supply, so a half-filled template never reaches
 * discovery as a broken URL.
 */
export function ssoIssuerFor(presetId: string, tenant: string): string | null {
  const preset = ssoPreset(presetId);
  if (!preset) return null;
  if (!preset.issuerTemplate) return null;
  if (!preset.issuerTemplate.includes('{')) return preset.issuerTemplate;

  const value = tenant
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  if (!value) return null;

  // Administrators paste the whole endpoint at least as often as the bare
  // tenant, so a value that already carries a host replaces the template's
  // host rather than being substituted into it — otherwise
  // "https://acme.logto.app" becomes "acme.logto.app.logto.app".
  if (value.includes('.') || value.includes('/')) {
    const host = value.split('/')[0] ?? value;
    const path = preset.issuerTemplate.replace(/^https?:\/\/[^/]+/, '');
    return `https://${host}${path}`;
  }
  return preset.issuerTemplate.replace('{tenant}', value).replace('{domain}', value);
}
