import { decodeMessage, encodeMessage } from './proto-wire.js';
import { CURSOR_CATALOG_SCHEMAS } from './cursor-catalog-schemas.js';
import { CURSOR_AGENT_SCHEMAS } from './cursor-agent-schemas.js';
import { CURSOR_EXEC_SCHEMAS } from './cursor-exec-schemas.js';

export const CONNECT_DATA_FLAG = 0x00;
export const CONNECT_END_STREAM_FLAG = 0x02;

export const CURSOR_SCHEMAS = {
  ...CURSOR_CATALOG_SCHEMAS,
  ...CURSOR_AGENT_SCHEMAS,
  ...CURSOR_EXEC_SCHEMAS,
};

/** Frame a payload with Connect streaming 5-byte envelope: `[flags:1][bigEndianLen:4][bytes]`. */
export function encodeConnectFrame(payload, flags = CONNECT_DATA_FLAG) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

/** Encode a terminal Connect EndStream frame (`{}` or `{"error":{...}}`). */
export function encodeConnectEndStream(errorObj = null) {
  const json = errorObj ? JSON.stringify({ error: errorObj }) : '{}';
  return encodeConnectFrame(Buffer.from(json, 'utf8'), CONNECT_END_STREAM_FLAG);
}

/** Decode one or more Connect streaming frames from a complete buffer. */
export function decodeConnectFrames(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf.readUInt8(offset);
    const length = buf.readUInt32BE(offset + 1);
    const end = offset + 5 + length;
    if (end > buf.length) break;
    frames.push({ flags, payload: buf.subarray(offset + 5, end) });
    offset = end;
  }
  return { frames, remaining: buf.subarray(offset) };
}

/** Decode a unary Connect or bare protobuf payload. */
export function decodeUnaryPayload(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length >= 5) {
    const flags = buf.readUInt8(0);
    const length = buf.readUInt32BE(1);
    if (length === buf.length - 5) {
      if (flags !== 0) {
        throw new Error(`Unsupported Connect unary flags: ${flags}`);
      }
      return { framed: true, payload: buf.subarray(5) };
    }
  }
  return { framed: false, payload: buf };
}

/** Encode a registered Cursor protobuf message to a Buffer. */
export function encodeCursor(typeName, value) {
  return encodeMessage(typeName, value, CURSOR_SCHEMAS);
}

/** Decode a Buffer into a registered Cursor protobuf message. */
export function decodeCursor(typeName, buffer) {
  return decodeMessage(typeName, buffer, CURSOR_SCHEMAS);
}
