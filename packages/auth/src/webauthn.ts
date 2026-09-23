import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * WebAuthn / passkeys (W3C Level 2), dependency-free like totp.ts.
 *
 * Only the server half lives here: the browser produces attestation and
 * assertion objects, and everything below exists to disbelieve them until
 * they prove themselves. A passkey is a login credential, so every check the
 * spec calls for is performed server-side and none of it trusts a field the
 * client could simply set.
 *
 * Supported algorithms are ES256 (-7) and RS256 (-257): between them they
 * cover every shipping platform authenticator, and both verify with
 * node:crypto alone.
 *
 * Deliberately NOT implemented: attestation statement verification (packed,
 * tpm, android-key…). Verifying it proves which *make* of authenticator was
 * used, which matters only when an enterprise restricts hardware. For
 * consumer passkeys the browser already vouches for the credential, and a
 * half-checked attestation chain is worse than none — it reads as a
 * guarantee while providing nothing. `fmt` is recorded so a policy could be
 * added later without a migration.
 */

export class WebAuthnError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'WebAuthnError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Declared as a function, not a const arrow: only a declaration lets
 * TypeScript treat the call as terminating, so `fail()` narrows types the
 * way an inline `throw` would.
 */
function fail(message: string): never {
  throw new WebAuthnError('WEBAUTHN_FAILED', message, 400);
}

// ── base64url ────────────────────────────────────────────────────────────

export function b64url(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

export function fromB64url(value: string, what: string): Buffer {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9_-]+=*$/.test(value)) {
    fail(`Malformed ${what}`);
  }
  return Buffer.from(value, 'base64url');
}

// ── CBOR ─────────────────────────────────────────────────────────────────

/**
 * A CBOR reader covering exactly the subset WebAuthn uses: unsigned and
 * negative integers, byte and text strings, arrays, and maps. Anything else
 * (tags, floats, indefinite lengths) is refused rather than guessed at — an
 * attestation object containing them is not something this code should be
 * interpreting.
 *
 * A general CBOR library would be a larger dependency and a larger attack
 * surface than the format actually needs here.
 */
class CborReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get position(): number {
    return this.offset;
  }

  private byte(): number {
    if (this.offset >= this.buf.length) fail('Truncated CBOR');
    return this.buf[this.offset++] as number;
  }

  private take(n: number): Buffer {
    if (n < 0 || this.offset + n > this.buf.length) fail('Truncated CBOR');
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  private length(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return (this.byte() << 8) | this.byte();
    if (info === 26) {
      return this.take(4).readUInt32BE(0);
    }
    // 27 is a 64-bit length; nothing in an attestation object is that large,
    // and allowing it invites an allocation the process cannot survive.
    return fail('Unsupported CBOR length');
  }

  read(): unknown {
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 31;

    switch (major) {
      case 0:
        return this.length(info);
      case 1:
        return -1 - this.length(info);
      case 2:
        return this.take(this.length(info));
      case 3:
        return this.take(this.length(info)).toString('utf8');
      case 4: {
        const n = this.length(info);
        const arr: unknown[] = [];
        for (let i = 0; i < n; i += 1) arr.push(this.read());
        return arr;
      }
      case 5: {
        const n = this.length(info);
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < n; i += 1) {
          const key = this.read();
          map.set(key, this.read());
        }
        return map;
      }
      default:
        return fail(`Unsupported CBOR major type ${major}`);
    }
  }
}

function cborDecodeFirst(buf: Buffer): { value: unknown; bytesRead: number } {
  const reader = new CborReader(buf);
  const value = reader.read();
  return { value, bytesRead: reader.position };
}

// ── COSE keys ────────────────────────────────────────────────────────────

const COSE_ES256 = -7;
const COSE_RS256 = -257;
export const SUPPORTED_ALGORITHMS = [COSE_ES256, COSE_RS256] as const;

function num(map: Map<unknown, unknown>, key: number, what: string): number {
  const v = map.get(key);
  if (typeof v !== 'number') fail(`COSE key missing ${what}`);
  return v as number;
}

function bytes(map: Map<unknown, unknown>, key: number, what: string): Buffer {
  const v = map.get(key);
  if (!Buffer.isBuffer(v)) fail(`COSE key missing ${what}`);
  return v as Buffer;
}

/**
 * Turn a COSE key into something node:crypto can verify with, by wrapping it
 * in DER. Node has no COSE parser, and building the DER here keeps the
 * supported algorithms explicit.
 */
function coseToKey(cose: Map<unknown, unknown>): { key: KeyObject; alg: number } {
  const kty = num(cose, 1, 'kty');
  const alg = num(cose, 3, 'alg');

  if (alg === COSE_ES256) {
    if (kty !== 2) fail('ES256 key must be EC2');
    if (num(cose, -1, 'crv') !== 1) fail('ES256 key must use P-256');
    const x = bytes(cose, -2, 'x');
    const y = bytes(cose, -3, 'y');
    if (x.length !== 32 || y.length !== 32) fail('Malformed P-256 coordinates');
    // SPKI prefix for id-ecPublicKey / prime256v1, then the uncompressed point.
    const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
    const der = Buffer.concat([prefix, Buffer.from([0x04]), x, y]);
    return { key: createPublicKey({ key: der, format: 'der', type: 'spki' }), alg };
  }

  if (alg === COSE_RS256) {
    if (kty !== 3) fail('RS256 key must be RSA');
    const n = bytes(cose, -1, 'n');
    const e = bytes(cose, -2, 'e');
    const der = rsaSpki(n, e);
    return { key: createPublicKey({ key: der, format: 'der', type: 'spki' }), alg };
  }

  return fail(`Unsupported COSE algorithm: ${alg}`);
}

/** Minimal DER: SEQUENCE(AlgorithmIdentifier, BIT STRING(SEQUENCE(n, e))). */
function rsaSpki(n: Buffer, e: Buffer): Buffer {
  const der = (tag: number, body: Buffer): Buffer =>
    Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
  const uint = (b: Buffer): Buffer => {
    // DER integers are signed: a leading high bit needs a zero byte, or the
    // value is read as negative and the key silently becomes wrong.
    const trimmed = b[0] === 0 ? b.subarray(1) : b;
    const needsPad = (trimmed[0] as number) & 0x80 ? Buffer.from([0]) : Buffer.alloc(0);
    return der(0x02, Buffer.concat([needsPad, trimmed]));
  };
  const rsaKey = der(0x30, Buffer.concat([uint(n), uint(e)]));
  const algId = Buffer.from('300d06092a864886f70d0101010500', 'hex');
  const bitString = der(0x03, Buffer.concat([Buffer.from([0]), rsaKey]));
  return der(0x30, Buffer.concat([algId, bitString]));
}

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytesOut: number[] = [];
  let remaining = len;
  while (remaining > 0) {
    bytesOut.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytesOut.length, ...bytesOut]);
}

// ── authenticatorData ────────────────────────────────────────────────────

export interface AuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  signCount: number;
  credentialId: Buffer | null;
  credentialPublicKey: Map<unknown, unknown> | null;
  aaguid: Buffer | null;
}

export function parseAuthenticatorData(data: Buffer): AuthenticatorData {
  if (data.length < 37) fail('authenticatorData too short');
  const rpIdHash = data.subarray(0, 32);
  const flags = data[32] as number;
  const signCount = data.readUInt32BE(33);

  const base: AuthenticatorData = {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    backupEligible: (flags & 0x08) !== 0,
    backedUp: (flags & 0x10) !== 0,
    signCount,
    credentialId: null,
    credentialPublicKey: null,
    aaguid: null,
  };

  const hasAttestedCredential = (flags & 0x40) !== 0;
  if (!hasAttestedCredential) return base;

  if (data.length < 55) fail('Attested credential data truncated');
  const aaguid = data.subarray(37, 53);
  const idLen = data.readUInt16BE(53);
  // A credential id is at most 1023 bytes per spec; a larger claim is either
  // corrupt or an attempt to read past the buffer.
  if (idLen > 1023 || 55 + idLen > data.length) fail('Invalid credential id length');
  const credentialId = data.subarray(55, 55 + idLen);
  const rest = data.subarray(55 + idLen);
  const { value } = cborDecodeFirst(rest);
  if (!(value instanceof Map)) fail('Credential public key is not a CBOR map');

  return {
    ...base,
    aaguid,
    credentialId,
    credentialPublicKey: value as Map<unknown, unknown>,
  };
}

// ── clientDataJSON ───────────────────────────────────────────────────────

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function parseClientData(raw: Buffer): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return fail('clientDataJSON is not valid JSON');
  }
  const obj = parsed as Partial<ClientData>;
  if (
    typeof obj?.type !== 'string' ||
    typeof obj.challenge !== 'string' ||
    typeof obj.origin !== 'string'
  ) {
    return fail('clientDataJSON is missing required fields');
  }
  return obj as ClientData;
}

/** Compare without leaking position through timing. */
function sameBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function assertClientData(
  client: ClientData,
  expected: { type: string; challenge: string; origins: string[]; rpId: string },
  rpIdHash: Buffer,
): void {
  if (client.type !== expected.type) {
    // Guards the cross-ceremony attack: an assertion replayed as a
    // registration, or the reverse.
    fail(`Expected ceremony ${expected.type}, got ${client.type}`);
  }
  if (!sameBytes(Buffer.from(client.challenge), Buffer.from(expected.challenge))) {
    fail('Challenge mismatch');
  }
  if (!expected.origins.includes(client.origin)) {
    // Exact origin match; a prefix test would accept evil-example.com.
    fail('Origin not allowed');
  }
  if (client.crossOrigin === true) fail('Cross-origin ceremonies are not accepted');
  const expectedHash = createHash('sha256').update(expected.rpId).digest();
  if (!sameBytes(rpIdHash, expectedHash)) fail('rpId mismatch');
}

// ── challenges ───────────────────────────────────────────────────────────

/** A fresh challenge. 32 bytes is the spec's recommended minimum. */
export function createChallenge(): string {
  return b64url(randomBytes(32));
}

// ── registration ─────────────────────────────────────────────────────────

export interface RegistrationInput {
  attestationObject: string;
  clientDataJSON: string;
  expectedChallenge: string;
  expectedOrigins: string[];
  expectedRpId: string;
  /** Require the authenticator to have verified the user (PIN/biometric). */
  requireUserVerification?: boolean;
}

export interface RegisteredCredential {
  credentialId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
  aaguid: string | null;
  fmt: string;
  backupEligible: boolean;
  backedUp: boolean;
  userVerified: boolean;
}

export function verifyRegistration(input: RegistrationInput): RegisteredCredential {
  const attestation = fromB64url(input.attestationObject, 'attestationObject');
  const clientDataRaw = fromB64url(input.clientDataJSON, 'clientDataJSON');
  const client = parseClientData(clientDataRaw);

  const { value } = cborDecodeFirst(attestation);
  if (!(value instanceof Map)) fail('attestationObject is not a CBOR map');
  const map = value as Map<unknown, unknown>;
  const authDataRaw = map.get('authData');
  const fmt = map.get('fmt');
  if (!Buffer.isBuffer(authDataRaw)) fail('attestationObject missing authData');

  const authData = parseAuthenticatorData(authDataRaw as Buffer);
  assertClientData(
    client,
    {
      type: 'webauthn.create',
      challenge: input.expectedChallenge,
      origins: input.expectedOrigins,
      rpId: input.expectedRpId,
    },
    authData.rpIdHash,
  );

  if (!authData.userPresent) fail('User presence flag not set');
  if (input.requireUserVerification && !authData.userVerified) {
    fail('User verification required but not performed');
  }
  if (!authData.credentialId || !authData.credentialPublicKey) {
    fail('Registration did not include a credential');
  }

  // Proves the key is one we can actually verify with later; a credential
  // stored now and unusable at login is worse than a refusal now.
  const { key, alg } = coseToKey(authData.credentialPublicKey);

  return {
    credentialId: b64url(authData.credentialId),
    publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64'),
    algorithm: alg,
    signCount: authData.signCount,
    aaguid: authData.aaguid ? authData.aaguid.toString('hex') : null,
    fmt: typeof fmt === 'string' ? fmt : 'none',
    backupEligible: authData.backupEligible,
    backedUp: authData.backedUp,
    userVerified: authData.userVerified,
  };
}

// ── authentication ───────────────────────────────────────────────────────

export interface AuthenticationInput {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  /** SPKI DER, base64 — exactly what verifyRegistration returned. */
  storedPublicKey: string;
  storedAlgorithm: number;
  storedSignCount: number;
  expectedChallenge: string;
  expectedOrigins: string[];
  expectedRpId: string;
  requireUserVerification?: boolean;
}

export interface AuthenticationResult {
  signCount: number;
  userVerified: boolean;
  backedUp: boolean;
  /**
   * True when the authenticator's counter did not advance as it should.
   * The spec calls this a possible clone. It is reported rather than thrown
   * because many passkeys legitimately keep the counter at zero — the caller
   * decides policy with the credential's history in hand.
   */
  signCountSuspect: boolean;
}

export function verifyAuthentication(input: AuthenticationInput): AuthenticationResult {
  const authDataRaw = fromB64url(input.authenticatorData, 'authenticatorData');
  const clientDataRaw = fromB64url(input.clientDataJSON, 'clientDataJSON');
  const signature = fromB64url(input.signature, 'signature');
  const client = parseClientData(clientDataRaw);
  const authData = parseAuthenticatorData(authDataRaw);

  assertClientData(
    client,
    {
      type: 'webauthn.get',
      challenge: input.expectedChallenge,
      origins: input.expectedOrigins,
      rpId: input.expectedRpId,
    },
    authData.rpIdHash,
  );

  if (!authData.userPresent) fail('User presence flag not set');
  if (input.requireUserVerification && !authData.userVerified) {
    fail('User verification required but not performed');
  }

  const key = createPublicKey({
    key: Buffer.from(input.storedPublicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });

  // The signed message is authenticatorData || SHA-256(clientDataJSON).
  const signedData = Buffer.concat([
    authDataRaw,
    createHash('sha256').update(clientDataRaw).digest(),
  ]);

  const verifier = createVerify('SHA256');
  verifier.update(signedData);
  verifier.end();

  let ok: boolean;
  if (input.storedAlgorithm === COSE_ES256) {
    // WebAuthn ECDSA signatures are DER-encoded, which is what node expects.
    ok = verifier.verify({ key, dsaEncoding: 'der' }, signature);
  } else if (input.storedAlgorithm === COSE_RS256) {
    ok = verifier.verify(key, signature);
  } else {
    return fail(`Unsupported stored algorithm: ${input.storedAlgorithm}`);
  }

  if (!ok) fail('Signature verification failed');

  /**
   * Counter check. A counter that stays at zero means the authenticator does
   * not implement one (common for platform passkeys) and is not suspicious.
   * A counter that moves backwards, or fails to advance when it previously
   * did, is what cloning looks like.
   */
  const suspect =
    authData.signCount > 0 || input.storedSignCount > 0
      ? authData.signCount <= input.storedSignCount
      : false;

  return {
    signCount: authData.signCount,
    userVerified: authData.userVerified,
    backedUp: authData.backedUp,
    signCountSuspect: suspect,
  };
}
