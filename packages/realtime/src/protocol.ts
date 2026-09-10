import { createHash } from 'node:crypto';

/**
 * RFC 6455 WebSocket codec — dependency-free, framework-free (repo convention:
 * raw `node:http` + `node:crypto`, no `ws` package).
 *
 * Covers exactly what the gateway needs: opening handshake accept-key,
 * masked client text frames (browsers always mask), server text frames,
 * ping/pong, close handshake, and fragmented message reassembly with a
 * bounded buffer. Control frames are never fragmented per spec.
 */

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(`${clientKey.trim()}${WS_GUID}`).digest('base64');
}

export type WsOpcode = 'text' | 'binary' | 'continuation' | 'close' | 'ping' | 'pong';

export interface WsFrame {
  opcode: WsOpcode;
  payload: Buffer;
  fin: boolean;
}

export class WsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsProtocolError';
  }
}

function opcodeOf(byte: number): WsOpcode {
  switch (byte & 0x0f) {
    case 0x0:
      return 'continuation';
    case 0x1:
      return 'text';
    case 0x2:
      return 'binary';
    case 0x8:
      return 'close';
    case 0x9:
      return 'ping';
    case 0xa:
      return 'pong';
    default:
      throw new WsProtocolError(`Unsupported opcode ${byte & 0x0f}`);
  }
}

function opcodeByte(opcode: WsOpcode): number {
  switch (opcode) {
    case 'text':
      return 0x1;
    case 'continuation':
      return 0x0;
    case 'binary':
      return 0x2;
    case 'close':
      return 0x8;
    case 'ping':
      return 0x9;
    case 'pong':
      return 0xa;
  }
}

/** Encode one server frame (servers never mask). */
export function encodeFrame(opcode: WsOpcode, payload: Buffer | string, fin = true): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(2);
  head[0] = (fin ? 0x80 : 0x00) | opcodeByte(opcode);
  head[1] = body.length < 126 ? body.length : body.length < 65536 ? 126 : 127;
  if (body.length < 126) return Buffer.concat([head, body]);
  const ext = Buffer.alloc(body.length < 65536 ? 2 : 8);
  if (body.length < 65536) ext.writeUInt16BE(body.length);
  else {
    ext.writeUInt32BE(0, 0);
    ext.writeUInt32BE(body.length, 4);
  }
  return Buffer.concat([head, ext, body]);
}

export interface Decoded {
  frames: WsFrame[];
  /** Unconsumed tail (incomplete frame) to prepend to the next chunk. */
  rest: Buffer;
  /** Total buffered bytes reassembled so far (for size caps upstream). */
  buffered: number;
}

/**
 * Decode client bytes. `maxPayload` aborts oversized messages/pings before
 * they consume memory (DoS guard). Throws WsProtocolError on violations.
 */
export function decodeFrames(chunk: Buffer, maxPayload: number): Decoded {
  const frames: WsFrame[] = [];
  let offset = 0;
  let buffered = 0;
  while (offset < chunk.length) {
    if (chunk.length - offset < 2) break;
    const b0 = chunk[offset] as number;
    const b1 = chunk[offset + 1] as number;
    const fin = (b0 & 0x80) !== 0;
    const opcode = opcodeOf(b0);
    const isControl = opcode === 'close' || opcode === 'ping' || opcode === 'pong';
    if (isControl && !fin) throw new WsProtocolError('Fragmented control frame');
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let header = 2;
    if (length === 126) {
      if (chunk.length - offset < 4) break;
      length = chunk.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (chunk.length - offset < 10) break;
      const hi = chunk.readUInt32BE(offset + 2);
      const lo = chunk.readUInt32BE(offset + 6);
      if (hi !== 0 || lo > 64 * 1024 * 1024) {
        throw new WsProtocolError('Frame too large');
      }
      length = lo;
      header = 10;
    }
    const maskOffset = masked ? 4 : 0;
    if (chunk.length - offset < header + maskOffset + length) break;
    if (length > maxPayload) throw new WsProtocolError('Payload exceeds limit');
    if (isControl && length > 125) throw new WsProtocolError('Control payload too large');
    let payload = chunk.subarray(offset + header + maskOffset, offset + header + maskOffset + length);
    if (masked) {
      const mask = chunk.subarray(offset + header, offset + header + 4);
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) {
        out[i] = (payload[i] as number) ^ (mask[i % 4] as number);
      }
      payload = out;
    }
    buffered += length;
    if (buffered > maxPayload) throw new WsProtocolError('Message exceeds limit');
    frames.push({ opcode, payload: Buffer.from(payload), fin });
    offset += header + maskOffset + length;
  }
  return { frames, rest: chunk.subarray(offset), buffered };
}

/** Encode a masked client frame (tests + SDK shims; browsers mask natively). */
export function encodeMaskedFrame(opcode: WsOpcode, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const head = Buffer.alloc(2);
  head[0] = 0x80 | opcodeByte(opcode);
  if (body.length >= 126) throw new WsProtocolError('Test helper supports small frames only');
  head[1] = 0x80 | body.length;
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) {
    masked[i] = (body[i] as number) ^ (mask[i % 4] as number);
  }
  return Buffer.concat([head, mask, masked]);
}
