import type * as sharpTypes from 'sharp';
import { StorageError } from './types.js';

/**
 * On-the-fly image transformation.
 *
 * A signed download URL already proves the caller may read the object, so
 * transform parameters do not widen access — they change the representation
 * of bytes the caller can already fetch. What they DO create is CPU and
 * memory amplification: one short URL can ask for a 30000x30000 resize.
 * Everything here exists to bound that.
 *
 * The bounds are deliberately not configurable per request. A caller who
 * could raise them could spend the whole origin's CPU from a single link.
 */

/** Largest output edge. Beyond this a "thumbnail" is really a denial of service. */
export const MAX_DIMENSION = 4000;
/** Largest output area, which catches 4000x4000 asked for as a wide strip. */
export const MAX_OUTPUT_PIXELS = 8_000_000;
/**
 * Largest source image sharp will even decode. A small file can expand into
 * an enormous bitmap ("decompression bomb"), so the limit is on pixels, not
 * on bytes.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

export const TRANSFORMABLE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/tiff',
]);

const OUTPUT_FORMATS = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png',
} as const;

export type OutputFormat = keyof typeof OUTPUT_FORMATS;

/** sharp's fit modes, named as the API exposes them. */
const FITS = new Set(['cover', 'contain', 'fill', 'inside', 'outside']);
export type Fit = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';

export interface TransformSpec {
  width?: number;
  height?: number;
  fit: Fit;
  format?: OutputFormat;
  quality: number;
  /** Strip EXIF and friends. On by default: location data is a privacy leak. */
  keepMetadata: boolean;
}

export const DEFAULT_QUALITY = 80;

function intParam(raw: string | null, name: string, max: number): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new StorageError(
      'VALIDATION_ERROR',
      `${name} must be an integer between 1 and ${max}`,
      400,
    );
  }
  return n;
}

/**
 * Read a transform out of a query string. Returns null when none was asked
 * for, so the caller can serve the original bytes untouched.
 */
export function parseTransform(params: URLSearchParams): TransformSpec | null {
  const width = intParam(params.get('width'), 'width', MAX_DIMENSION);
  const height = intParam(params.get('height'), 'height', MAX_DIMENSION);
  const formatRaw = params.get('format');
  const qualityRaw = params.get('quality');
  const fitRaw = params.get('fit');
  const metaRaw = params.get('metadata');

  if (
    width === undefined &&
    height === undefined &&
    !formatRaw &&
    !qualityRaw &&
    !fitRaw &&
    !metaRaw
  ) {
    return null;
  }

  let format: OutputFormat | undefined;
  if (formatRaw) {
    const clean = formatRaw.trim().toLowerCase();
    // `jpg` is what people type; `jpeg` is what the format is called.
    const normalized = clean === 'jpg' ? 'jpeg' : clean;
    if (!(normalized in OUTPUT_FORMATS)) {
      throw new StorageError(
        'VALIDATION_ERROR',
        `Unsupported format: ${clean.slice(0, 20)} (webp, avif, jpeg, png)`,
        400,
      );
    }
    format = normalized as OutputFormat;
  }

  const quality = qualityRaw === null ? DEFAULT_QUALITY : intParam(qualityRaw, 'quality', 100);

  let fit: Fit = 'cover';
  if (fitRaw) {
    const clean = fitRaw.trim().toLowerCase();
    if (!FITS.has(clean)) {
      throw new StorageError(
        'VALIDATION_ERROR',
        `Unsupported fit: ${clean.slice(0, 20)} (${[...FITS].join(', ')})`,
        400,
      );
    }
    fit = clean as Fit;
  }

  if (width !== undefined && height !== undefined && width * height > MAX_OUTPUT_PIXELS) {
    throw new StorageError(
      'VALIDATION_ERROR',
      `Requested image exceeds ${MAX_OUTPUT_PIXELS} pixels`,
      400,
    );
  }

  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    fit,
    ...(format ? { format } : {}),
    quality: quality ?? DEFAULT_QUALITY,
    keepMetadata: metaRaw === 'keep',
  };
}

/** The media type the transformed bytes will carry. */
export function outputMime(spec: TransformSpec, sourceMime: string): string {
  return spec.format ? OUTPUT_FORMATS[spec.format] : sourceMime;
}

/**
 * Deterministic cache key for one (object, transform) pair.
 *
 * Built from normalized values rather than the raw query string, so
 * `?width=100&format=webp` and `?format=webp&width=100` are one cache entry
 * instead of two. The object's etag is included, so replacing the object
 * invalidates every derivative of it without anything having to enumerate
 * them.
 */
export function transformCacheKey(etag: string, spec: TransformSpec): string {
  return [
    etag,
    spec.width ?? '-',
    spec.height ?? '-',
    spec.fit,
    spec.format ?? '-',
    spec.quality,
    spec.keepMetadata ? 'meta' : 'nometa',
  ].join(':');
}

export function assertTransformable(mimeType: string): void {
  if (!TRANSFORMABLE_MIME.has(mimeType)) {
    throw new StorageError(
      'VALIDATION_ERROR',
      `Cannot transform ${mimeType.slice(0, 40)}: not a supported image type`,
      400,
    );
  }
}

/**
 * sharp is loaded on first use rather than at import time. The API boots and
 * serves every non-image route without paying for a native module it may
 * never call, and a missing binary surfaces as a 400 on one request instead
 * of a process that will not start.
 */
type SharpFactory = typeof sharpTypes.default;
let sharpModule: SharpFactory | null = null;

async function loadSharp(): Promise<SharpFactory> {
  if (sharpModule) return sharpModule;
  try {
    const mod = await import('sharp');
    sharpModule = mod.default;
    return sharpModule;
  } catch {
    throw new StorageError(
      'VALIDATION_ERROR',
      'Image transformation is unavailable on this deployment',
      400,
    );
  }
}

export interface TransformedImage {
  bytes: Uint8Array;
  contentType: string;
  width: number | undefined;
  height: number | undefined;
}

/** Apply a parsed transform. The source mime must already be transformable. */
export async function applyTransform(
  source: Uint8Array,
  spec: TransformSpec,
  sourceMime: string,
): Promise<TransformedImage> {
  assertTransformable(sourceMime);
  const sharp = await loadSharp();

  let pipeline = sharp(source, {
    limitInputPixels: MAX_INPUT_PIXELS,
    // An animated source resized frame-by-frame multiplies the cost by the
    // frame count, so only the first frame is transformed.
    animated: false,
  });

  if (!spec.keepMetadata) {
    // sharp drops metadata unless withMetadata() is called; being explicit
    // documents that EXIF (which carries GPS coordinates) is deliberate.
    pipeline = pipeline.rotate(); // applies EXIF orientation before it is lost
  } else {
    pipeline = pipeline.withMetadata();
  }

  if (spec.width !== undefined || spec.height !== undefined) {
    pipeline = pipeline.resize({
      ...(spec.width !== undefined ? { width: spec.width } : {}),
      ...(spec.height !== undefined ? { height: spec.height } : {}),
      fit: spec.fit,
      // Never scale a small image up: it costs output bytes and adds nothing.
      withoutEnlargement: true,
    });
  }

  if (spec.format === 'webp') pipeline = pipeline.webp({ quality: spec.quality });
  else if (spec.format === 'avif') pipeline = pipeline.avif({ quality: spec.quality });
  else if (spec.format === 'jpeg') pipeline = pipeline.jpeg({ quality: spec.quality });
  else if (spec.format === 'png') pipeline = pipeline.png();

  let out;
  try {
    out = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (err) {
    // A corrupt upload or a decompression bomb is the caller's problem, not
    // a 500: report it as a bad request with the reason.
    throw new StorageError(
      'VALIDATION_ERROR',
      `Could not process image: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`,
      400,
    );
  }

  return {
    bytes: new Uint8Array(out.data),
    contentType: outputMime(spec, sourceMime),
    width: out.info.width,
    height: out.info.height,
  };
}
