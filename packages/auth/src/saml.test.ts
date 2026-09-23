import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignedXml } from 'xml-crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  beginSamlLogin,
  buildConnection,
  memorySamlRequestCache,
  normalizeCertificate,
  samlMetadata,
  verifySamlResponse,
  type SamlConnection,
} from './saml.js';

/**
 * A real IdP, in miniature: a self-signed key pair signs genuine SAML
 * assertions, which the service provider then verifies. Signature checking is
 * the whole security of SAML, so a test that mocked it would prove nothing.
 */

const SP_ENTITY = 'https://cloudnivo.org/saml/metadata';
const ACS = 'https://cloudnivo.org/api/v1/projects/p1/auth/saml/callback';
const IDP_ISSUER = 'https://idp.example.com/entity';
const IDP_SSO = 'https://idp.example.com/sso';

let privateKeyPem = '';
let certPem = '';
let certBody = '';

beforeAll(() => {
  // openssl is present on CI images and locally; generating here keeps a
  // private key out of the repository.
  const dir = mkdtempSync(join(tmpdir(), 'cn-saml-'));
  const keyPath = join(dir, 'idp.key');
  const certPath = join(dir, 'idp.crt');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '2',
    '-subj',
    '/CN=idp.example.com',
  ]);
  privateKeyPem = execFileSync('cat', [keyPath]).toString();
  certPem = execFileSync('cat', [certPath]).toString();
  certBody = normalizeCertificate(certPem);
  writeFileSync(join(dir, 'ok'), 'done');
});

function connection(over: Partial<Parameters<typeof buildConnection>[0]> = {}): SamlConnection {
  return buildConnection({
    idpIssuer: IDP_ISSUER,
    signOnUrl: IDP_SSO,
    callbackUrl: ACS,
    spEntityId: SP_ENTITY,
    certificates: [certPem],
    ...over,
  });
}

/** Build and sign a SAML Response the way an IdP would. */
function signedResponse(opts: {
  inResponseTo: string;
  email?: string;
  audience?: string;
  issuer?: string;
  notOnOrAfter?: string;
  signAssertion?: boolean;
}): string {
  const id = `_${Math.random().toString(16).slice(2)}`;
  const assertionId = `_${Math.random().toString(16).slice(2)}`;
  const now = new Date();
  const notOnOrAfter = opts.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000).toISOString();
  const email = opts.email ?? 'user@example.com';

  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>${opts.issuer ?? IDP_ISSUER}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData InResponseTo="${opts.inResponseTo}" Recipient="${ACS}" NotOnOrAfter="${notOnOrAfter}"/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${opts.audience ?? SP_ENTITY}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${assertionId}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="displayName"><saml:AttributeValue>Ada Lovelace</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>`;

  let inner = assertion;
  if (opts.signAssertion !== false) {
    const sig = new SignedXml({
      privateKey: privateKeyPem,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
    });
    sig.computeSignature(assertion, {
      location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
    });
    inner = sig.getSignedXml();
  }

  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
    `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}" ` +
    `Destination="${ACS}" InResponseTo="${opts.inResponseTo}">` +
    `<saml:Issuer>${opts.issuer ?? IDP_ISSUER}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    inner +
    `</samlp:Response>`;
  return Buffer.from(response).toString('base64');
}

/** Run a full round trip and hand back the request id the library issued. */
async function beginAndCapture(conn: SamlConnection) {
  const cache = memorySamlRequestCache();
  const ids: string[] = [];
  const wrapped = {
    ...cache,
    saveAsync: async (k: string, v: string) => {
      ids.push(k);
      return cache.saveAsync(k, v);
    },
  };
  const { url } = await beginSamlLogin(conn, 'relay-1', wrapped);
  return { url, cache: wrapped, requestId: ids[0] as string };
}

describe('connection configuration', () => {
  it('accepts a certificate however an admin pasted it', () => {
    const armoured = certPem;
    const oneLine = certBody;
    const crlf = certPem.replace(/\n/g, '\r\n');
    for (const variant of [armoured, oneLine, crlf]) {
      expect(normalizeCertificate(variant)).toBe(certBody);
    }
  });

  it('refuses junk that is not a certificate', () => {
    expect(() => normalizeCertificate('hello world!!')).toThrow();
    expect(() => normalizeCertificate('')).toThrow();
  });

  it('refuses a plaintext IdP endpoint but allows localhost for development', () => {
    expect(() => connection({ signOnUrl: 'http://idp.example.com/sso' })).toThrow(/https/);
    expect(() => connection({ signOnUrl: 'http://localhost:8080/sso' })).not.toThrow();
  });

  it('requires an issuer, an entity id and at least one certificate', () => {
    expect(() => connection({ idpIssuer: '' })).toThrow();
    expect(() => connection({ spEntityId: '' })).toThrow();
    expect(() => connection({ certificates: [] })).toThrow();
  });

  it('publishes SP metadata naming our entity id and ACS', () => {
    const xml = samlMetadata(connection());
    expect(xml).toContain(SP_ENTITY);
    expect(xml).toContain(ACS);
  });
});

describe('a genuine signed assertion', () => {
  it('is accepted, and yields the identity', async () => {
    const conn = connection();
    const { url, cache, requestId } = await beginAndCapture(conn);
    expect(url).toContain('SAMLRequest=');
    expect(url).toContain('RelayState=relay-1');

    const identity = await verifySamlResponse(
      conn,
      signedResponse({ inResponseTo: requestId }),
      cache,
    );
    expect(identity.email).toBe('user@example.com');
    expect(identity.name).toBe('Ada Lovelace');
    expect(identity.nameId).toBe('user@example.com');
  });
});

describe('forgeries and misdirection are refused', () => {
  it('refuses an UNSIGNED assertion', async () => {
    // The single most important refusal in the file.
    const conn = connection();
    const { cache, requestId } = await beginAndCapture(conn);
    await expect(
      verifySamlResponse(
        conn,
        signedResponse({ inResponseTo: requestId, signAssertion: false }),
        cache,
      ),
    ).rejects.toThrow();
  });

  it('refuses an assertion signed by a DIFFERENT key', async () => {
    const conn = connection();
    const { cache, requestId } = await beginAndCapture(conn);
    // Configure the SP to trust an unrelated certificate instead.
    const dir = mkdtempSync(join(tmpdir(), 'cn-saml-other-'));
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'k'),
      '-out',
      join(dir, 'c'),
      '-days',
      '2',
      '-subj',
      '/CN=other.example.com',
    ]);
    const otherCert = execFileSync('cat', [join(dir, 'c')]).toString();
    const wrongTrust = connection({ certificates: [otherCert] });
    await expect(
      verifySamlResponse(wrongTrust, signedResponse({ inResponseTo: requestId }), cache),
    ).rejects.toThrow();
  });

  it('refuses an UNSOLICITED assertion — InResponseTo names no request we made', async () => {
    const conn = connection();
    const { cache } = await beginAndCapture(conn);
    await expect(
      verifySamlResponse(conn, signedResponse({ inResponseTo: '_never_issued' }), cache),
    ).rejects.toThrow();
  });

  it('refuses the same assertion twice', async () => {
    // The request id is consumed on success, so a captured response cannot be
    // posted again.
    const conn = connection();
    const { cache, requestId } = await beginAndCapture(conn);
    const response = signedResponse({ inResponseTo: requestId });
    await expect(verifySamlResponse(conn, response, cache)).resolves.toBeTruthy();
    await expect(verifySamlResponse(conn, response, cache)).rejects.toThrow();
  });

  it('refuses an assertion meant for a different audience', async () => {
    const conn = connection();
    const { cache, requestId } = await beginAndCapture(conn);
    await expect(
      verifySamlResponse(
        conn,
        signedResponse({ inResponseTo: requestId, audience: 'https://someone-else.example' }),
        cache,
      ),
    ).rejects.toThrow();
  });

  it('refuses an assertion from an unexpected issuer', async () => {
    const conn = connection();
    const { cache, requestId } = await beginAndCapture(conn);
    await expect(
      verifySamlResponse(
        conn,
        signedResponse({ inResponseTo: requestId, issuer: 'https://evil.example/entity' }),
        cache,
      ),
    ).rejects.toThrow();
  });

  it('refuses an expired assertion', async () => {
    const conn = connection();
    const { cache, requestId } = await beginAndCapture(conn);
    await expect(
      verifySamlResponse(
        conn,
        signedResponse({
          inResponseTo: requestId,
          notOnOrAfter: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
        cache,
      ),
    ).rejects.toThrow();
  });

  it('refuses garbage in place of a response', async () => {
    const conn = connection();
    const { cache } = await beginAndCapture(conn);
    for (const junk of ['', 'not-base64-xml', Buffer.from('<hello/>').toString('base64')]) {
      await expect(verifySamlResponse(conn, junk, cache)).rejects.toThrow();
    }
  });
});

describe('tenant restriction', () => {
  it('refuses an email outside the allowed domains', async () => {
    const conn = connection({ allowedDomains: ['corp.example'] });
    const { cache, requestId } = await beginAndCapture(conn);
    await expect(
      verifySamlResponse(conn, signedResponse({ inResponseTo: requestId }), cache),
    ).rejects.toThrow(/domain is not allowed/);
  });

  it('accepts an email inside them', async () => {
    const conn = connection({ allowedDomains: ['example.com'] });
    const { cache, requestId } = await beginAndCapture(conn);
    const identity = await verifySamlResponse(
      conn,
      signedResponse({ inResponseTo: requestId }),
      cache,
    );
    expect(identity.email).toBe('user@example.com');
  });
});
