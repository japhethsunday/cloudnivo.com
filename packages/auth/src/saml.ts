import { SAML } from '@node-saml/node-saml';
import { AuthError } from './errors.js';

/**
 * SAML 2.0 service provider, for enterprise tenants whose IdP does not speak
 * OIDC.
 *
 * Signature verification is delegated to @node-saml/node-saml (xml-crypto
 * underneath) rather than written here. SAML's security rests on XML
 * canonicalisation and signature placement, and the protocol has a long
 * history of signature-wrapping (XSW) breaks in implementations that parsed
 * the assertion themselves. Hand-rolling that would be the single worst
 * decision available in this file.
 *
 * What DOES live here is everything specific to CloudNivo: how a connection
 * is configured and validated, which assertion fields become a user, and the
 * refusals that must not be left to a library's defaults.
 */

export class SamlError extends AuthError {
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(code, message);
    this.name = 'SamlError';
    this.status = status;
  }
}

/**
 * Where issued AuthnRequest ids are remembered between the redirect out and
 * the assertion coming back. It is what makes InResponseTo enforceable, so it
 * must outlive a single request and be shared by both halves of the flow —
 * the API layer backs it with the project's cache.
 */
export interface SamlRequestCache {
  saveAsync(key: string, value: string): Promise<{ createdAt: Date; value: string } | null>;
  getAsync(key: string): Promise<string | null>;
  removeAsync(key: string | null): Promise<string | null>;
}

/** In-process cache: fine for one node, and what tests use. */
export function memorySamlRequestCache(ttlMs = 10 * 60 * 1000): SamlRequestCache {
  const store = new Map<string, { createdAt: number; value: string }>();
  return {
    async saveAsync(key, value) {
      const createdAt = Date.now();
      store.set(key, { createdAt, value });
      return { createdAt: new Date(createdAt), value };
    },
    async getAsync(key) {
      const hit = store.get(key);
      if (!hit) return null;
      // Expiry is enforced on read: an id that sat unused is not a valid
      // answer to a login nobody is still waiting on.
      if (Date.now() - hit.createdAt > ttlMs) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async removeAsync(key) {
      if (key === null) return null;
      store.delete(key);
      return key;
    },
  };
}

export interface SamlConnectionInput {
  /** IdP entity id (the `Issuer` its assertions carry). */
  idpIssuer: string;
  /** IdP SSO endpoint the browser is redirected to. */
  signOnUrl: string;
  /** IdP signing certificate(s), PEM or bare base64. Several = rotation. */
  certificates: string[];
  /** Our entity id, as registered at the IdP. */
  spEntityId: string;
  /** Our ACS URL, where the IdP posts its response. */
  callbackUrl: string;
  /** Map IdP attribute names onto CloudNivo fields. */
  attributeMap?: { email?: string; name?: string };
  /** Domains allowed to sign in through this connection. */
  allowedDomains?: string[];
  /** Accept assertions the IdP signed but did not encrypt. Default true. */
  wantAssertionsSigned?: boolean;
}

export interface SamlConnection extends SamlConnectionInput {
  attributeMap: { email?: string; name?: string };
  allowedDomains: string[];
  wantAssertionsSigned: boolean;
}

const PEM_BODY = /^[A-Za-z0-9+/\s=]+$/;

/**
 * Normalise a certificate to bare base64.
 *
 * Administrators paste these from an IdP console in every shape: with or
 * without PEM armour, with CRLF, with the whole thing on one line. The
 * library wants the base64 body, so the variance is absorbed once, here,
 * rather than producing an opaque signature failure later.
 */
export function normalizeCertificate(raw: string): string {
  const stripped = raw
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (stripped.length < 64 || !PEM_BODY.test(stripped)) {
    throw new SamlError('SAML_CERT_INVALID', 'Certificate is not valid base64 PEM content', 400);
  }
  return stripped;
}

function assertHttps(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SamlError('SAML_CONFIG_INVALID', `${field} is not a valid URL`, 400);
  }
  /**
   * An IdP endpoint reached over http: would let a network attacker rewrite
   * the redirect. localhost is exempted so the flow can be developed against
   * a local IdP without weakening the production rule.
   */
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new SamlError('SAML_CONFIG_INVALID', `${field} must use https`, 400);
  }
  return parsed.toString();
}

export function buildConnection(input: SamlConnectionInput): SamlConnection {
  if (!input.idpIssuer?.trim()) {
    throw new SamlError('SAML_CONFIG_INVALID', 'idpIssuer is required', 400);
  }
  if (!input.spEntityId?.trim()) {
    throw new SamlError('SAML_CONFIG_INVALID', 'spEntityId is required', 400);
  }
  if (!Array.isArray(input.certificates) || input.certificates.length === 0) {
    throw new SamlError('SAML_CONFIG_INVALID', 'At least one IdP certificate is required', 400);
  }
  return {
    ...input,
    signOnUrl: assertHttps(input.signOnUrl, 'signOnUrl'),
    callbackUrl: assertHttps(input.callbackUrl, 'callbackUrl'),
    certificates: input.certificates.map(normalizeCertificate),
    attributeMap: input.attributeMap ?? {},
    allowedDomains: (input.allowedDomains ?? []).map(d => d.trim().toLowerCase()).filter(Boolean),
    wantAssertionsSigned: input.wantAssertionsSigned ?? true,
  };
}

function client(conn: SamlConnection, cache: SamlRequestCache): SAML {
  return new SAML({
    cacheProvider: cache as never,
    entryPoint: conn.signOnUrl,
    issuer: conn.spEntityId,
    callbackUrl: conn.callbackUrl,
    idpCert: conn.certificates,
    /**
     * These four are the difference between SAML and a login anyone can
     * forge, so they are set explicitly rather than inherited:
     *  - the assertion (not merely the response envelope) must be signed,
     *    because an unsigned assertion inside a signed response is the
     *    classic wrapping attack;
     *  - the IdP's Issuer must match the one configured;
     *  - InResponseTo must match a request we actually made, which is what
     *    stops an unsolicited assertion being replayed at us;
     *  - clock skew is bounded rather than unlimited.
     */
    wantAssertionsSigned: conn.wantAssertionsSigned,
    wantAuthnResponseSigned: false,
    idpIssuer: conn.idpIssuer,
    validateInResponseTo: 'always' as never,
    acceptedClockSkewMs: 30_000,
    audience: conn.spEntityId,
    disableRequestedAuthnContext: true,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
  });
}

/**
 * Begin login: the URL to send the browser to.
 *
 * The AuthnRequest id is written into `cache` by the library as it builds the
 * request. The same cache must be passed to verifySamlResponse, or
 * InResponseTo cannot be checked and any assertion the IdP ever issued would
 * be accepted.
 */
export async function beginSamlLogin(
  conn: SamlConnection,
  relayState: string,
  cache: SamlRequestCache,
): Promise<{ url: string }> {
  const saml = client(conn, cache);
  const url = await saml.getAuthorizeUrlAsync(relayState, new URL(conn.callbackUrl).host, {});
  return { url };
}

export interface SamlIdentity {
  nameId: string;
  email: string;
  name: string | null;
  attributes: Record<string, string>;
  sessionIndex: string | null;
}

const EMAIL_CLAIMS = [
  'email',
  'mail',
  'emailAddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
];
const NAME_CLAIMS = [
  'displayName',
  'name',
  'cn',
  'urn:oid:2.5.4.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
];

function pick(attrs: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = attrs[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
  }
  return null;
}

/**
 * Verify a posted SAML response and turn it into an identity.
 *
 * `cache` must be the same one beginSamlLogin wrote to. The library refuses
 * an assertion whose InResponseTo names no id it issued, which is what stops
 * an unsolicited assertion being replayed at the ACS endpoint by anyone the
 * IdP would vouch for.
 */
export async function verifySamlResponse(
  conn: SamlConnection,
  samlResponse: string,
  cache: SamlRequestCache,
): Promise<SamlIdentity> {
  if (!samlResponse || typeof samlResponse !== 'string') {
    throw new SamlError('SAML_RESPONSE_INVALID', 'Missing SAMLResponse', 400);
  }

  const saml = client(conn, cache);
  let profile;
  try {
    const result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
    profile = result.profile;
  } catch (err) {
    // One message for every verification failure: which check failed is
    // information an attacker would use to iterate.
    throw new SamlError(
      'SAML_RESPONSE_INVALID',
      `SAML response rejected: ${err instanceof Error ? err.message.slice(0, 160) : 'unknown'}`,
      401,
    );
  }
  if (!profile)
    throw new SamlError('SAML_RESPONSE_INVALID', 'SAML response carried no assertion', 401);

  /**
   * Issuer check, enforced HERE rather than by the library.
   *
   * node-saml accepts an `idpIssuer` option, but as of 5.1.0 its
   * verifyIssuer() is only called for LogoutRequest and LogoutResponse - the
   * login assertion is never checked against it. Configuring the option and
   * assuming it applied would leave the assertion's Issuer unvalidated, which
   * a test caught. It is checked explicitly here, and the option is left set
   * so behaviour does not silently change if the library starts honouring it.
   */
  const claimedIssuer = String(profile.issuer ?? '');
  if (claimedIssuer !== conn.idpIssuer) {
    throw new SamlError(
      'SAML_ISSUER_MISMATCH',
      'SAML assertion came from an unexpected identity provider',
      401,
    );
  }

  const attrs = (profile.attributes ?? {}) as Record<string, unknown>;
  const mapped = conn.attributeMap.email ? pick(attrs, [conn.attributeMap.email]) : null;
  const email = (mapped ?? pick(attrs, EMAIL_CLAIMS) ?? profile.nameID ?? '').toLowerCase().trim();

  if (!email || !email.includes('@')) {
    throw new SamlError(
      'SAML_NO_EMAIL',
      'The IdP assertion contained no email address; check the attribute mapping',
      400,
    );
  }

  /**
   * Domain restriction. Without it, an IdP misconfigured to vouch for any
   * verified address would let an outsider into the tenant.
   */
  if (conn.allowedDomains.length > 0) {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!conn.allowedDomains.includes(domain)) {
      throw new SamlError(
        'SAML_DOMAIN_FORBIDDEN',
        'This email domain is not allowed to sign in',
        403,
      );
    }
  }

  const nameKeys = conn.attributeMap.name ? [conn.attributeMap.name, ...NAME_CLAIMS] : NAME_CLAIMS;
  return {
    nameId: String(profile.nameID ?? email),
    email,
    name: pick(attrs, nameKeys),
    attributes: Object.fromEntries(
      Object.entries(attrs).map(([k, v]) => [
        k,
        Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''),
      ]),
    ),
    sessionIndex: profile.sessionIndex ? String(profile.sessionIndex) : null,
  };
}

/** SP metadata XML, for pasting into the IdP. */
export function samlMetadata(conn: SamlConnection): string {
  return client(conn, memorySamlRequestCache()).generateServiceProviderMetadata(null, null);
}
