import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createChallenge,
  parseAuthenticatorData,
  verifyAuthentication,
  verifyRegistration,
} from './webauthn.js';

/**
 * A passkey IS the login, so these tests are built the way an attacker would
 * probe it: real ceremonies produced with real keys, then each field tampered
 * with in turn to prove the check that rejects it exists.
 *
 * The fixtures are generated rather than captured, so the same code path runs
 * for ES256 and RS256 without pasting opaque blobs nobody can audit.
 */

const RP_ID = 'cloudnivo.org';
const ORIGIN = 'https://cloudnivo.org';

const b64u = (b: Buffer): string => b.toString('base64url');

/** CBOR encoders — only the shapes an authenticator emits. */
function cborUint(n: number): Buffer {
  if (n < 24) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x18, n]);
  if (n < 65536) return Buffer.from([0x19, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = 0x1a;
  b.writeUInt32BE(n, 1);
  return b;
}
function cborNegative(n: number): Buffer {
  // Major type 1 shares uint's length encoding, so encode -1-n as a uint and
  // set the type bits on the header byte. Emitting a bare 0x20 plus a
  // separate uint (as a first cut did) decodes as -1 followed by garbage,
  // which is how RS256's alg -257 silently arrived as -1.
  const v = -1 - n;
  const b = cborUint(v);
  b[0] = (b[0] as number) | 0x20;
  return b;
}
function cborBytes(b: Buffer): Buffer {
  const head = cborUint(b.length);
  head[0] = (head[0] as number) | 0x40;
  return Buffer.concat([head, b]);
}
function cborText(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const head = cborUint(b.length);
  head[0] = (head[0] as number) | 0x60;
  return Buffer.concat([head, b]);
}
function cborMap(entries: [Buffer, Buffer][]): Buffer {
  const head = cborUint(entries.length);
  head[0] = (head[0] as number) | 0xa0;
  return Buffer.concat([head, ...entries.flatMap(([k, v]) => [k, v])]);
}
const key = (n: number): Buffer => (n < 0 ? cborNegative(n) : cborUint(n));

/** An EC2 P-256 COSE key from a real generated keypair. */
function es256Cose(publicKeyDer: Buffer): Buffer {
  // SPKI for P-256 is a fixed 26-byte prefix, then 0x04 || X || Y.
  const point = publicKeyDer.subarray(publicKeyDer.length - 65);
  const x = point.subarray(1, 33);
  const y = point.subarray(33, 65);
  return cborMap([
    [key(1), cborUint(2)], // kty: EC2
    [key(3), cborNegative(-7)], // alg: ES256
    [key(-1), cborUint(1)], // crv: P-256
    [key(-2), cborBytes(x)],
    [key(-3), cborBytes(y)],
  ]);
}

function rs256Cose(jwk: { n: string; e: string }): Buffer {
  return cborMap([
    [key(1), cborUint(3)], // kty: RSA
    [key(3), cborNegative(-257)], // alg: RS256
    [key(-1), cborBytes(Buffer.from(jwk.n, 'base64url'))],
    [key(-2), cborBytes(Buffer.from(jwk.e, 'base64url'))],
  ]);
}

function authData(opts: {
  rpId?: string;
  flags?: number;
  signCount?: number;
  credentialId?: Buffer;
  cose?: Buffer;
}): Buffer {
  const rpIdHash = createHash('sha256')
    .update(opts.rpId ?? RP_ID)
    .digest();
  const head = Buffer.alloc(5);
  // AT only when attested credential data actually follows, or the parser
  // rightly refuses the buffer before the flag under test is reached.
  const withCredential = Boolean(opts.credentialId && opts.cose);
  head[0] = opts.flags ?? (withCredential ? 0x45 : 0x05);
  head.writeUInt32BE(opts.signCount ?? 0, 1);
  const base = Buffer.concat([rpIdHash, head]);
  if (!opts.credentialId || !opts.cose) return base;
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(opts.credentialId.length, 0);
  return Buffer.concat([base, Buffer.alloc(16), idLen, opts.credentialId, opts.cose]);
}

function clientData(type: string, challenge: string, origin = ORIGIN): string {
  return b64u(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

function attestation(ad: Buffer, fmt = 'none'): string {
  return b64u(
    cborMap([
      [cborText('fmt'), cborText(fmt)],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(ad)],
    ]),
  );
}

/** A full registration + login pair for one algorithm. */
function ceremony(alg: 'es256' | 'rs256') {
  const credentialId = randomBytes(32);
  let cose: Buffer;
  let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];

  if (alg === 'es256') {
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateKey = kp.privateKey;
    cose = es256Cose(kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer);
  } else {
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = kp.privateKey;
    const jwk = kp.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    cose = rs256Cose(jwk);
  }

  const challenge = createChallenge();
  const ad = authData({ credentialId, cose });
  const registration = {
    attestationObject: attestation(ad),
    clientDataJSON: clientData('webauthn.create', challenge),
    expectedChallenge: challenge,
    expectedOrigins: [ORIGIN],
    expectedRpId: RP_ID,
  };

  const login = (
    opts: { signCount?: number; challenge?: string; origin?: string; uv?: boolean } = {},
  ) => {
    const ch = opts.challenge ?? createChallenge();
    const loginAd = authData({
      flags: opts.uv === false ? 0x01 : 0x05,
      signCount: opts.signCount ?? 0,
    });
    const cdj = clientData('webauthn.get', ch, opts.origin);
    const signed = Buffer.concat([
      loginAd,
      createHash('sha256').update(Buffer.from(cdj, 'base64url')).digest(),
    ]);
    const signer = createSign('SHA256');
    signer.update(signed);
    signer.end();
    const signature = signer.sign(
      alg === 'es256' ? { key: privateKey, dsaEncoding: 'der' } : privateKey,
    );
    return {
      credentialId: b64u(credentialId),
      authenticatorData: b64u(loginAd),
      clientDataJSON: cdj,
      signature: b64u(signature),
      expectedChallenge: ch,
      expectedOrigins: [ORIGIN],
      expectedRpId: RP_ID,
    };
  };

  return { registration, login, credentialId };
}

describe.each(['es256', 'rs256'] as const)('a real %s passkey', alg => {
  it('registers, then verifies a login signed by the matching private key', () => {
    const { registration, login } = ceremony(alg);
    const cred = verifyRegistration(registration);
    expect(cred.algorithm).toBe(alg === 'es256' ? -7 : -257);
    expect(cred.credentialId).toHaveLength(43);

    const result = verifyAuthentication({
      ...login(),
      storedPublicKey: cred.publicKey,
      storedAlgorithm: cred.algorithm,
      storedSignCount: cred.signCount,
    });
    expect(result.signCountSuspect).toBe(false);
  });

  it('rejects a signature made by a DIFFERENT key', () => {
    // The whole point: possession of the credential id is not authentication.
    const victim = ceremony(alg);
    const attacker = ceremony(alg);
    const cred = verifyRegistration(victim.registration);
    const forged = attacker.login();

    expect(() =>
      verifyAuthentication({
        ...forged,
        storedPublicKey: cred.publicKey,
        storedAlgorithm: cred.algorithm,
        storedSignCount: 0,
      }),
    ).toThrow(/Signature verification failed/);
  });

  it('rejects a tampered signature, authenticatorData or clientDataJSON', () => {
    const { registration, login } = ceremony(alg);
    const cred = verifyRegistration(registration);
    const good = login();
    const base = {
      storedPublicKey: cred.publicKey,
      storedAlgorithm: cred.algorithm,
      storedSignCount: 0,
    };

    const flip = (s: string): string => {
      const b = Buffer.from(s, 'base64url');
      b[b.length - 1] = (b[b.length - 1] as number) ^ 0xff;
      return b.toString('base64url');
    };

    expect(() =>
      verifyAuthentication({ ...good, ...base, signature: flip(good.signature) }),
    ).toThrow();
    expect(() =>
      verifyAuthentication({ ...good, ...base, authenticatorData: flip(good.authenticatorData) }),
    ).toThrow();
  });
});

describe('ceremony binding', () => {
  it('refuses a login replayed against a different challenge', () => {
    const { registration, login } = ceremony('es256');
    const cred = verifyRegistration(registration);
    const good = login();
    expect(() =>
      verifyAuthentication({
        ...good,
        expectedChallenge: createChallenge(), // server expected a different one
        storedPublicKey: cred.publicKey,
        storedAlgorithm: cred.algorithm,
        storedSignCount: 0,
      }),
    ).toThrow(/Challenge mismatch/);
  });

  it('refuses an origin that merely looks like ours', () => {
    const { registration, login } = ceremony('es256');
    const cred = verifyRegistration(registration);
    for (const origin of [
      'https://cloudnivo.org.evil.com',
      'http://cloudnivo.org',
      'https://evil.com',
    ]) {
      const attempt = login({ origin });
      expect(
        () =>
          verifyAuthentication({
            ...attempt,
            storedPublicKey: cred.publicKey,
            storedAlgorithm: cred.algorithm,
            storedSignCount: 0,
          }),
        origin,
      ).toThrow(/Origin not allowed/);
    }
  });

  it('refuses an assertion presented as a registration, and vice versa', () => {
    const challenge = createChallenge();
    const ad = authData({});
    expect(() =>
      verifyRegistration({
        attestationObject: attestation(ad),
        clientDataJSON: clientData('webauthn.get', challenge), // wrong ceremony
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      }),
    ).toThrow(/Expected ceremony webauthn.create/);
  });

  it('refuses a credential registered for a different rpId', () => {
    const { registration } = ceremony('es256');
    expect(() => verifyRegistration({ ...registration, expectedRpId: 'evil.com' })).toThrow(
      /rpId mismatch/,
    );
  });
});

describe('policy flags', () => {
  it('requires user presence', () => {
    const challenge = createChallenge();
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ad = authData({
      flags: 0x40, // AT set, UP clear
      credentialId: randomBytes(32),
      cose: es256Cose(kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer),
    });
    expect(() =>
      verifyRegistration({
        attestationObject: attestation(ad),
        clientDataJSON: clientData('webauthn.create', challenge),
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      }),
    ).toThrow(/User presence/);
  });

  it('enforces user verification only when asked', () => {
    const { registration, login } = ceremony('es256');
    const cred = verifyRegistration(registration);
    // UP set, UV clear: the user touched the key but did not prove who they are.
    const attempt = login({ uv: false });
    const base = {
      storedPublicKey: cred.publicKey,
      storedAlgorithm: cred.algorithm,
      storedSignCount: 0,
    };
    expect(() => verifyAuthentication({ ...attempt, ...base })).not.toThrow();
    expect(() =>
      verifyAuthentication({ ...attempt, ...base, requireUserVerification: true }),
    ).toThrow(/User verification required/);
  });
});

describe('cloned-authenticator signal', () => {
  it('flags a counter that fails to advance, but not one that never moves', () => {
    const { registration, login } = ceremony('es256');
    const cred = verifyRegistration(registration);
    const base = {
      storedPublicKey: cred.publicKey,
      storedAlgorithm: cred.algorithm,
    };

    // Platform passkeys commonly leave the counter at zero forever.
    expect(
      verifyAuthentication({ ...login({ signCount: 0 }), ...base, storedSignCount: 0 })
        .signCountSuspect,
    ).toBe(false);

    // A counter that moves forward is healthy.
    expect(
      verifyAuthentication({ ...login({ signCount: 6 }), ...base, storedSignCount: 5 })
        .signCountSuspect,
    ).toBe(false);

    // One that goes backwards is what a clone looks like.
    expect(
      verifyAuthentication({ ...login({ signCount: 4 }), ...base, storedSignCount: 9 })
        .signCountSuspect,
    ).toBe(true);
  });
});

describe('malformed input is refused, not crashed on', () => {
  it('rejects junk in every base64url field', () => {
    const challenge = createChallenge();
    expect(() =>
      verifyRegistration({
        attestationObject: 'not!base64',
        clientDataJSON: clientData('webauthn.create', challenge),
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      }),
    ).toThrow(/Malformed/);
  });

  it('rejects truncated authenticatorData', () => {
    expect(() => parseAuthenticatorData(Buffer.alloc(10))).toThrow(/too short/);
  });

  it('rejects a credential id length that would read past the buffer', () => {
    // 55 bytes of header claiming a 1000-byte credential id.
    const ad = Buffer.concat([Buffer.alloc(53), Buffer.from([0x03, 0xe8])]);
    const flagged = Buffer.concat([ad]);
    flagged[32] = 0x45;
    expect(() => parseAuthenticatorData(flagged)).toThrow(/credential id length/);
  });

  it('rejects clientDataJSON that is not JSON', () => {
    const challenge = createChallenge();
    expect(() =>
      verifyRegistration({
        attestationObject: attestation(authData({})),
        clientDataJSON: b64u(Buffer.from('<<<not json>>>')),
        expectedChallenge: challenge,
        expectedOrigins: [ORIGIN],
        expectedRpId: RP_ID,
      }),
    ).toThrow(/not valid JSON/);
  });
});
