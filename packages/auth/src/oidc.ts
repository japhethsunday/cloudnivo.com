import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Generic OIDC SSO (authorization-code + PKCE). Powers Organization SSO and
 * Enterprise SSO connections: any OIDC IdP (Google, Okta, Keycloak,
 * Microsoft Entra, Auth0) works through discovery — no per-provider code.
 * Client secrets live server-side only (connection rows store metadata;
 * secrets arrive per-request from env/secret store, never from the client).
 */

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export interface OidcProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export class OidcError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OidcError';
    this.code = code;
    this.status = status;
  }
}

export async function discoverOidc(issuer: string): Promise<OidcDiscovery> {
  const normalized = issuer.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${normalized}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new OidcError('OIDC_UNREACHABLE', 'Identity provider is unreachable');
  }
  if (!res.ok) throw new OidcError('OIDC_DISCOVERY_FAILED', 'Provider discovery failed');
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    !json ||
    typeof json['authorization_endpoint'] !== 'string' ||
    typeof json['token_endpoint'] !== 'string' ||
    typeof json['jwks_uri'] !== 'string'
  ) {
    throw new OidcError('OIDC_DISCOVERY_FAILED', 'Provider metadata is incomplete');
  }
  return {
    issuer: typeof json['issuer'] === 'string' ? (json['issuer'] as string) : normalized,
    authorization_endpoint: json['authorization_endpoint'] as string,
    token_endpoint: json['token_endpoint'] as string,
    jwks_uri: json['jwks_uri'] as string,
    userinfo_endpoint:
      typeof json['userinfo_endpoint'] === 'string'
        ? (json['userinfo_endpoint'] as string)
        : undefined,
  };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(input: {
  discovery: OidcDiscovery;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const url = new URL(input.discovery.authorization_endpoint);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? ['openid', 'email', 'profile']).join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeOidcCode(input: {
  discovery: OidcDiscovery;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ idToken: string; accessToken: string | null }> {
  let res: Response;
  try {
    res = await fetch(input.discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new OidcError('OIDC_UNREACHABLE', 'Identity provider is unreachable');
  }
  if (!res.ok) throw new OidcError('OIDC_CODE_FAILED', 'Authorization code rejected by provider');
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json['id_token'] !== 'string') {
    throw new OidcError('OIDC_CODE_FAILED', 'Provider did not return an ID token');
  }
  return {
    idToken: json['id_token'] as string,
    accessToken: typeof json['access_token'] === 'string' ? (json['access_token'] as string) : null,
  };
}

export async function verifyOidcIdToken(input: {
  discovery: OidcDiscovery;
  clientId: string;
  idToken: string;
  nonce?: string;
}): Promise<OidcProfile> {
  let payload: Record<string, unknown>;
  try {
    const jwks = createRemoteJWKSet(new URL(input.discovery.jwks_uri));
    const verified = await jwtVerify(input.idToken, jwks, {
      issuer: input.discovery.issuer,
      audience: input.clientId,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new OidcError('OIDC_TOKEN_INVALID', 'ID token signature or claims invalid', 401);
  }
  if (input.nonce && payload['nonce'] !== input.nonce) {
    throw new OidcError('OIDC_TOKEN_INVALID', 'ID token nonce mismatch', 401);
  }
  const sub = payload['sub'];
  if (typeof sub !== 'string' || !sub) throw new OidcError('OIDC_TOKEN_INVALID', 'ID token has no subject', 401);
  const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : null;
  return {
    sub,
    email,
    emailVerified: payload['email_verified'] === true,
    name: typeof payload['name'] === 'string' ? (payload['name'] as string) : null,
  };
}
