/**
 * Content-type handling. The browser-supplied MIME is UNTRUSTED: we sniff
 * magic bytes and reconcile. Mismatches fail closed for executable-ish
 * payloads and downgrade everything else to the sniffed (or octet-stream)
 * type, so uploads can never be stored as a more privileged type than they are.
 */

interface Signature {
  mime: string;
  offset: number;
  bytes: number[];
}

const SIGNATURES: Signature[] = [
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  { mime: 'image/bmp', offset: 0, bytes: [0x42, 0x4d] },
  { mime: 'image/avif', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] },
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/gzip', offset: 0, bytes: [0x1f, 0x8b] },
  { mime: 'video/mp4', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/mpeg', offset: 0, bytes: [0xff, 0xfb] },
];

const EXECUTABLE_MIMES = new Set([
  'application/x-msdownload',
  'application/x-sh',
  'application/x-executable',
  'application/x-mach-binary',
]);

const EXTENSION_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  svg: 'image/svg+xml',
  css: 'text/css',
  js: 'text/javascript',
};

function matches(bytes: Uint8Array, sig: Signature): boolean {
  if (bytes.length < sig.offset + sig.bytes.length) return false;
  return sig.bytes.every((b, i) => bytes[sig.offset + i] === b);
}

/** Sniff magic bytes. Returns null when unknown (caller falls back safely). */
export function sniffMime(sample: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (matches(sample, sig)) return sig.mime;
  }
  return null;
}

function isTextual(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  if (n === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < n; i += 1) {
    const b = bytes[i] as number;
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) suspicious += 1;
  }
  return suspicious / n < 0.05;
}

/**
 * Reconcile browser claim + extension + content. Returns the SAFE mime to
 * store and serve. Throws on executable spoofing.
 */
export function resolveMime(
  provided: string | null,
  filename: string,
  sample: Uint8Array,
): { mime: string; sniffed: string | null; spoofed: boolean } {
  const clean = (provided ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const sniffed = sniffMime(sample);
  const fromExt = EXTENSION_MAP[ext] ?? null;

  if (EXECUTABLE_MIMES.has(clean)) {
    throw new Error('Executable content types are not accepted');
  }
  // Binary claiming to be an image/text while sniffing otherwise (or nothing
  // recognizable with NUL bytes) → spoof attempt.
  if (!sniffed && !isTextual(sample) && (clean.startsWith('image/') || clean.startsWith('text/'))) {
    throw new Error('MIME spoofing detected: content does not match claimed type');
  }
  if (sniffed && clean && clean !== sniffed && clean !== 'application/octet-stream') {
    // Trust the bytes, but flag it. Executable sniffs are rejected outright.
    if (EXECUTABLE_MIMES.has(sniffed)) throw new Error('Executable content detected');
    return { mime: sniffed, sniffed, spoofed: true };
  }
  const mime = sniffed ?? (clean || fromExt || 'application/octet-stream');
  return { mime, sniffed, spoofed: false };
}

/** Content-Disposition: inline only for safe previewable types. */
export function dispositionFor(mime: string, filename: string): string {
  const safeInline = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/avif',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
  ]);
  const safe = filename.replace(/["\r\n]/g, '_');
  if (safeInline.has(mime)) return `inline; filename="${safe}"`;
  return `attachment; filename="${safe}"`;
}
