import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY,
  MAX_DIMENSION,
  MAX_OUTPUT_PIXELS,
  applyTransform,
  assertTransformable,
  outputMime,
  parseTransform,
  transformCacheKey,
} from './transform.js';

/**
 * A signed URL already proves the caller may read the object, so a transform
 * cannot widen access. What it can do is turn one short link into arbitrary
 * CPU and memory. Most of what follows is about that ceiling.
 */

const q = (s: string): URLSearchParams => new URLSearchParams(s);

describe('parsing a transform request', () => {
  it('returns null when nothing was asked for, so the original is served', () => {
    expect(parseTransform(q(''))).toBeNull();
    expect(parseTransform(q('download=1'))).toBeNull();
  });

  it('reads a full request', () => {
    const spec = parseTransform(q('width=200&height=100&fit=contain&format=webp&quality=60'));
    expect(spec).toEqual({
      width: 200,
      height: 100,
      fit: 'contain',
      format: 'webp',
      quality: 60,
      keepMetadata: false,
    });
  });

  it('accepts jpg as a spelling of jpeg', () => {
    expect(parseTransform(q('format=jpg'))?.format).toBe('jpeg');
  });

  it('defaults quality and fit rather than leaving them undefined', () => {
    const spec = parseTransform(q('width=50'));
    expect(spec?.quality).toBe(DEFAULT_QUALITY);
    expect(spec?.fit).toBe('cover');
  });

  it('strips metadata unless explicitly asked to keep it', () => {
    // EXIF carries GPS coordinates; keeping it has to be a decision.
    expect(parseTransform(q('width=50'))?.keepMetadata).toBe(false);
    expect(parseTransform(q('width=50&metadata=keep'))?.keepMetadata).toBe(true);
  });
});

describe('the cost ceiling', () => {
  it('refuses a dimension past the cap', () => {
    expect(() => parseTransform(q(`width=${MAX_DIMENSION + 1}`))).toThrow();
    expect(() => parseTransform(q(`height=${MAX_DIMENSION + 1}`))).toThrow();
    expect(() => parseTransform(q(`width=${MAX_DIMENSION}`))).not.toThrow();
  });

  it('refuses an area past the cap even when each edge is legal', () => {
    // 4000x4000 is under the per-edge cap but 16M pixels.
    expect(() => parseTransform(q('width=4000&height=4000'))).toThrow();
    expect(4000 * 4000).toBeGreaterThan(MAX_OUTPUT_PIXELS);
  });

  it('refuses a non-integer, zero or negative dimension', () => {
    for (const bad of ['width=0', 'width=-5', 'width=1.5', 'width=abc', 'width=1e9']) {
      expect(() => parseTransform(q(bad)), bad).toThrow();
    }
  });

  it('refuses an out-of-range quality and an unknown format or fit', () => {
    expect(() => parseTransform(q('quality=0'))).toThrow();
    expect(() => parseTransform(q('quality=101'))).toThrow();
    expect(() => parseTransform(q('format=svg'))).toThrow();
    expect(() => parseTransform(q('format=../../etc/passwd'))).toThrow();
    expect(() => parseTransform(q('fit=nonsense'))).toThrow();
  });

  it('refuses to transform a type that is not a raster image', () => {
    // SVG is the notable one: it can reference remote entities.
    for (const mime of ['image/svg+xml', 'application/pdf', 'text/html', 'application/zip']) {
      expect(() => assertTransformable(mime), mime).toThrow();
    }
    expect(() => assertTransformable('image/png')).not.toThrow();
  });
});

describe('cache key', () => {
  it('is stable across parameter order', () => {
    const a = parseTransform(q('width=100&format=webp'));
    const b = parseTransform(q('format=webp&width=100'));
    expect(transformCacheKey('etag1', a!)).toBe(transformCacheKey('etag1', b!));
  });

  it('changes when the transform changes', () => {
    const base = parseTransform(q('width=100'))!;
    for (const other of [
      'width=101',
      'width=100&height=50',
      'width=100&format=webp',
      'width=100&quality=50',
      'width=100&fit=inside',
    ]) {
      expect(transformCacheKey('etag1', parseTransform(q(other))!)).not.toBe(
        transformCacheKey('etag1', base),
      );
    }
  });

  it('changes when the object changes, so derivatives expire with it', () => {
    const spec = parseTransform(q('width=100'))!;
    expect(transformCacheKey('etag2', spec)).not.toBe(transformCacheKey('etag1', spec));
  });
});

describe('outputMime', () => {
  it('follows the requested format, else keeps the source type', () => {
    expect(outputMime(parseTransform(q('format=webp'))!, 'image/png')).toBe('image/webp');
    expect(outputMime(parseTransform(q('width=10'))!, 'image/png')).toBe('image/png');
  });
});

/**
 * Real bytes through the real encoder. Asserting on a spec object would not
 * show that sharp accepts what we build.
 */
describe('transforming actual image bytes', () => {
  /** A real PNG of the given size, built by the same encoder under test. */
  const png = async (width: number, height: number): Promise<Uint8Array> => {
    const sharp = (await import('sharp')).default;
    return new Uint8Array(
      await sharp({ create: { width, height, channels: 3, background: '#4488cc' } })
        .png()
        .toBuffer(),
    );
  };
  const big = (): Promise<Uint8Array> => png(600, 400);

  it('resizes and re-encodes to webp', async () => {
    const out = await applyTransform(
      await big(),
      parseTransform(q('width=100&format=webp'))!,
      'image/png',
    );
    expect(out.contentType).toBe('image/webp');
    expect(out.width).toBe(100);
    // webp magic: RIFF....WEBP
    expect(Buffer.from(out.bytes.slice(0, 4)).toString('ascii')).toBe('RIFF');
    expect(Buffer.from(out.bytes.slice(8, 12)).toString('ascii')).toBe('WEBP');
  });

  it('honours fit when both edges are given', async () => {
    const out = await applyTransform(
      await big(),
      parseTransform(q('width=100&height=100&fit=contain'))!,
      'image/png',
    );
    expect(out.width).toBe(100);
    expect(out.height).toBe(100);
  });

  it('never enlarges a smaller source', async () => {
    // Upscaling costs bytes and adds no detail.
    const out = await applyTransform(
      await png(20, 20),
      parseTransform(q('width=500'))!,
      'image/png',
    );
    expect(out.width).toBe(20);
  });

  it('reports a corrupt image as a 400, not a crash', async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(
      applyTransform(junk, parseTransform(q('width=10'))!, 'image/png'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a non-image source before touching the encoder', async () => {
    await expect(
      applyTransform(await png(20, 20), parseTransform(q('width=10'))!, 'application/pdf'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
