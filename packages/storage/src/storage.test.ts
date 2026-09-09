import { describe, expect, it, vi } from 'vitest';
import { assertBucketName, assertObjectPath, fileNameOf, storageKeyFor } from './validation.js';
import { dispositionFor, resolveMime, sniffMime } from './mime.js';
import { signToken, verifyToken } from './signed-urls.js';
import { authorize } from './policies.js';
import type { Bucket, StorageCaller } from './types.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]);

function bucket(over: Partial<Bucket> = {}): Bucket {
  return {
    id: 'b1',
    organizationId: 'o1',
    projectId: '11111111-1111-4111-8111-111111111111',
    name: 'avatars',
    visibility: 'private',
    fileSizeLimit: null,
    allowedMimeTypes: [],
    ownerIsolation: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function caller(over: Partial<StorageCaller> = {}): StorageCaller {
  return {
    kind: 'session',
    userId: 'u1',
    role: 'member',
    projectId: '11111111-1111-4111-8111-111111111111',
    organizationId: 'o1',
    ...over,
  };
}

describe('path validation', () => {
  it('accepts logical keys, normalizes dots', () => {
    expect(assertObjectPath('avatars/user-123/profile.png')).toBe('avatars/user-123/profile.png');
    expect(assertObjectPath('a/./b')).toBe('a/b');
    expect(fileNameOf('a/b/c.png')).toBe('c.png');
  });

  it('blocks traversal, absolute, null bytes, bad segments', () => {
    for (const bad of [
      '../evil',
      'a/../../b',
      '/abs/path',
      'C:\\win',
      '\\\\unc\\x',
      'a\0b',
      '',
      '.',
      'x'.repeat(1025),
    ]) {
      expect(() => assertObjectPath(bad), bad.slice(0, 20)).toThrow();
    }
    // '//' collapses to single segment join — empty segments skipped, still valid:
    expect(assertObjectPath('a//b')).toBe('a/b');
  });

  it('validates bucket names + storage keys', () => {
    expect(assertBucketName('my-bucket-1')).toBe('my-bucket-1');
    for (const bad of ['AB', 'a', '-x-', 'has space', 'UPPER']) {
      expect(() => assertBucketName(bad), bad).toThrow();
    }
    expect(storageKeyFor('11111111-1111-4111-8111-111111111111', 'avatars', 'u/a.png')).toBe(
      'p_11111111-1111-4111-8111-111111111111/b_avatars/u/a.png',
    );
  });
});

describe('mime sniffing', () => {
  it('detects magic bytes', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(ZIP)).toBe('application/zip');
    expect(sniffMime(new TextEncoder().encode('{"a":1}'))).toBe(null);
  });

  it('trusts bytes over browser claims, rejects spoofs', () => {
    expect(resolveMime('image/png', 'a.png', PNG).mime).toBe('image/png');
    // PNG bytes labeled jpeg → corrected, flagged.
    const fixed = resolveMime('image/jpeg', 'a.png', PNG);
    expect(fixed.mime).toBe('image/png');
    expect(fixed.spoofed).toBe(true);
    // Binary blob claiming image → rejected.
    expect(() => resolveMime('image/png', 'evil.png', EXE)).toThrow();
    // Executable claim rejected outright.
    expect(() => resolveMime('application/x-msdownload', 'x.exe', EXE)).toThrow();
    // Plain text/json accepted.
    expect(resolveMime('application/json', 'a.json', new TextEncoder().encode('{}')).mime).toBe(
      'application/json',
    );
  });

  it('serves safe types inline, rest as attachment', () => {
    expect(dispositionFor('image/png', 'a.png')).toContain('inline');
    expect(dispositionFor('text/html', 'a.html')).toContain('attachment');
    expect(dispositionFor('image/svg+xml', 'a.svg')).toContain('attachment');
    expect(dispositionFor('application/json', 'a"b.json')).not.toContain('"b');
  });
});

describe('signed URLs', () => {
  const secret = 's'.repeat(48);
  const claims = {
    projectId: '11111111-1111-4111-8111-111111111111',
    bucket: 'avatars',
    path: 'u/a.png',
    op: 'download' as const,
    exp: Math.floor(Date.now() / 1000) + 300,
  };

  it('round-trips, enforces expiry + tamper evidence', () => {
    const token = signToken(secret, claims, 3600);
    expect(verifyToken(secret, token).path).toBe('u/a.png');
    expect(verifyToken(secret, token).op).toBe('download');
    const tampered = `${token.slice(0, -2)}xx`;
    expect(() => verifyToken(secret, tampered)).toThrow(/signature/i);
    expect(() => verifyToken('x'.repeat(48), token)).toThrow(/signature/i);
    // Wrong secret must fail even with identical payload shape.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const t = signToken(secret, { ...claims, exp: Math.floor(Date.now() / 1000) + 300 }, 3600);
      vi.setSystemTime(new Date('2026-01-01T00:10:00Z'));
      expect(() => verifyToken(secret, t)).toThrow(/expired/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects over-long TTLs and weak secrets', () => {
    expect(() => signToken(secret, claims, 60)).toThrow(/exceeds maximum/);
    expect(() => signToken('short', claims, 3600)).toThrow();
  });
});

describe('storage policies', () => {
  it('platform roles: admin full, member objects, viewer read-only', () => {
    const b = bucket();
    expect(authorize(b, caller({ role: 'admin' }), 'bucket:delete', null).allowed).toBe(true);
    expect(authorize(b, caller({ role: 'member' }), 'object:upload', 'x/y.png').allowed).toBe(true);
    expect(authorize(b, caller({ role: 'member' }), 'bucket:delete', null).allowed).toBe(false);
    expect(authorize(b, caller({ role: 'viewer' }), 'object:download', 'x').allowed).toBe(true);
    expect(authorize(b, caller({ role: 'viewer' }), 'object:delete', 'x').allowed).toBe(false);
  });

  it('project keys: service writes, public reads, never buckets', () => {
    const b = bucket();
    const svc = caller({ kind: 'key', role: 'service', userId: null });
    const pub = caller({ kind: 'key', role: 'public', userId: null });
    expect(authorize(b, svc, 'object:upload', 'a/b').allowed).toBe(true);
    expect(authorize(b, pub, 'object:upload', 'a/b').allowed).toBe(false);
    expect(authorize(b, pub, 'object:download', 'a/b').allowed).toBe(true);
    expect(authorize(b, svc, 'bucket:create', null).allowed).toBe(false);
  });

  it('customers: owner-prefix enforced, admins bypass', () => {
    const b = bucket();
    const u1 = caller({ kind: 'customer', role: 'authenticated', userId: 'user-1' });
    expect(authorize(b, u1, 'object:upload', 'user-1/a.png').allowed).toBe(true);
    expect(authorize(b, u1, 'object:upload', 'user-2/a.png').allowed).toBe(false);
    expect(authorize(b, u1, 'object:download', 'user-1').allowed).toBe(true);
    const admin = caller({ kind: 'customer', role: 'admin', userId: 'user-9' });
    expect(authorize(b, admin, 'object:delete', 'user-2/a.png').allowed).toBe(true);
    const open = bucket({ ownerIsolation: false });
    expect(authorize(open, u1, 'object:download', 'any/path.png').allowed).toBe(true);
  });

  it('anonymous: public downloads only, exact paths', () => {
    const pub = bucket({ visibility: 'public' });
    const priv = bucket();
    const anon = caller({ kind: 'anonymous', userId: null, role: 'anonymous' });
    expect(authorize(pub, anon, 'object:download', 'a/b.png').allowed).toBe(true);
    expect(authorize(priv, anon, 'object:download', 'a/b.png').allowed).toBe(false);
    expect(authorize(pub, anon, 'object:list', null).allowed).toBe(false);
    expect(authorize(pub, anon, 'object:upload', 'a/b.png').allowed).toBe(false);
  });
});
