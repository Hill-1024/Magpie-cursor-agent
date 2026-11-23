/**
 * Zero-dependency Protobuf wire codec supporting varints, fixed32/64, floats/doubles,
 * length-delimited strings/bytes, nested messages, repeated fields, and maps.
 */

export function encodeVarint(value) {
  let big = typeof value === 'bigint' ? value : BigInt(value);
  if (big < 0n) {
    big = BigInt.asUintN(64, big);
  }
  const bytes = [];
  while (big >= 0x80n) {
    bytes.push(Number(big & 0x7fn) | 0x80);
    big >>= 7n;
  }
  bytes.push(Number(big));
  return Buffer.from(bytes);
}

export function decodeVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, offset: cursor };
    }
    shift += 7n;
    if (shift > 63n) {
      throw new Error('Malformed protobuf varint (> 64 bits)');
    }
  }
  throw new Error('Truncated protobuf varint');
}

export function skipField(buffer, offset, wireType) {
  if (wireType === 0) {
    return decodeVarint(buffer, offset).offset;
  }
  if (wireType === 1) {
    if (offset + 8 > buffer.length) throw new Error('Truncated 64-bit field');
    return offset + 8;
  }
  if (wireType === 2) {
    const lenRes = decodeVarint(buffer, offset);
    const len = Number(lenRes.value);
    const end = lenRes.offset + len;
    if (end > buffer.length) throw new Error('Truncated length-delimited field');
    return end;
  }
  if (wireType === 5) {
    if (offset + 4 > buffer.length) throw new Error('Truncated 32-bit field');
    return offset + 4;
  }
  throw new Error(`Unsupported protobuf wire type: ${wireType}`);
}

function encodeScalar(kind, value) {
  if (kind === 'string') {
    const buf = Buffer.from(String(value), 'utf8');
    return { wireType: 2, payload: Buffer.concat([encodeVarint(buf.length), buf]) };
  }
  if (kind === 'bytes') {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return { wireType: 2, payload: Buffer.concat([encodeVarint(buf.length), buf]) };
  }
  if (kind === 'bool') {
    return { wireType: 0, payload: encodeVarint(value ? 1 : 0) };
  }
  if (kind === 'int32' || kind === 'enum') {
    return { wireType: 0, payload: encodeVarint(BigInt.asIntN(32, BigInt(value))) };
  }
  if (kind === 'uint32') {
    return { wireType: 0, payload: encodeVarint(BigInt.asUintN(32, BigInt(value))) };
  }
  if (kind === 'int64') {
    return { wireType: 0, payload: encodeVarint(BigInt.asIntN(64, BigInt(value))) };
  }
  if (kind === 'uint64') {
    return { wireType: 0, payload: encodeVarint(BigInt.asUintN(64, BigInt(value))) };
  }
  if (kind === 'double') {
    const buf = Buffer.allocUnsafe(8);
    buf.writeDoubleLE(Number(value), 0);
    return { wireType: 1, payload: buf };
  }
  if (kind === 'float') {
    const buf = Buffer.allocUnsafe(4);
    buf.writeFloatLE(Number(value), 0);
    return { wireType: 5, payload: buf };
  }
  throw new Error(`Unknown protobuf scalar kind: ${kind}`);
}

function decodeScalar(kind, wireType, buffer, offset) {
  if (kind === 'string') {
    if (wireType !== 2) throw new Error(`Expected wireType 2 for string, got ${wireType}`);
    const lenRes = decodeVarint(buffer, offset);
    const end = lenRes.offset + Number(lenRes.value);
    return { value: buffer.subarray(lenRes.offset, end).toString('utf8'), offset: end };
  }
  if (kind === 'bytes') {
    if (wireType !== 2) throw new Error(`Expected wireType 2 for bytes, got ${wireType}`);
    const lenRes = decodeVarint(buffer, offset);
    const end = lenRes.offset + Number(lenRes.value);
    return { value: Buffer.from(buffer.subarray(lenRes.offset, end)), offset: end };
  }
  if (kind === 'bool') {
    if (wireType !== 0) throw new Error(`Expected wireType 0 for bool, got ${wireType}`);
    const res = decodeVarint(buffer, offset);
    return { value: res.value !== 0n, offset: res.offset };
  }
  if (kind === 'int32' || kind === 'enum') {
    if (wireType !== 0) throw new Error(`Expected wireType 0 for ${kind}, got ${wireType}`);
    const res = decodeVarint(buffer, offset);
    return { value: Number(BigInt.asIntN(32, res.value)), offset: res.offset };
  }
  if (kind === 'uint32') {
    if (wireType !== 0) throw new Error(`Expected wireType 0 for uint32, got ${wireType}`);
    const res = decodeVarint(buffer, offset);
    return { value: Number(BigInt.asUintN(32, res.value)), offset: res.offset };
  }
  if (kind === 'int64') {
    if (wireType !== 0) throw new Error(`Expected wireType 0 for int64, got ${wireType}`);
    const res = decodeVarint(buffer, offset);
    return { value: Number(BigInt.asIntN(64, res.value)), offset: res.offset };
  }
  if (kind === 'uint64') {
    if (wireType !== 0) throw new Error(`Expected wireType 0 for uint64, got ${wireType}`);
    const res = decodeVarint(buffer, offset);
    return { value: Number(BigInt.asUintN(64, res.value)), offset: res.offset };
  }
  if (kind === 'double') {
    if (wireType !== 1) throw new Error(`Expected wireType 1 for double, got ${wireType}`);
    return { value: buffer.readDoubleLE(offset), offset: offset + 8 };
  }
  if (kind === 'float') {
    if (wireType !== 5) throw new Error(`Expected wireType 5 for float, got ${wireType}`);
    return { value: buffer.readFloatLE(offset), offset: offset + 4 };
  }
  throw new Error(`Unknown protobuf scalar kind: ${kind}`);
}

function isZeroDefault(kind, value, fieldOpts) {
  if (fieldOpts?.optional || fieldOpts?.oneof) return false;
  if (kind === 'string') return value === '';
  if (kind === 'bytes') return !value || value.length === 0;
  if (kind === 'bool') return value === false;
  if (kind === 'int32' || kind === 'uint32' || kind === 'int64' || kind === 'uint64' || kind === 'enum' || kind === 'double' || kind === 'float') {
    return Number(value) === 0;
  }
  return false;
}

function encodeFieldEntry(fieldNumber, kind, value, registry) {
  if (kind.startsWith('message:')) {
    const nestedName = kind.slice('message:'.length);
    const encoded = encodeMessage(nestedName, value || {}, registry);
    const tag = encodeVarint((fieldNumber << 3) | 2);
    return Buffer.concat([tag, encodeVarint(encoded.length), encoded]);
  }
  if (kind.startsWith('map:')) {
    const [, keyKind, valKind] = kind.split(':');
    const chunks = [];
    const entries = value instanceof Map ? value.entries() : Object.entries(value || {});
    for (const [mapKey, mapVal] of entries) {
      const keyChunk = encodeFieldEntry(1, keyKind, mapKey, registry);
      const valChunk = encodeFieldEntry(2, valKind, mapVal, registry);
      const pair = Buffer.concat([keyChunk, valChunk]);
      chunks.push(Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(pair.length), pair]));
    }
    return Buffer.concat(chunks);
  }
  const { wireType, payload } = encodeScalar(kind, value);
  const tag = encodeVarint((fieldNumber << 3) | wireType);
  return Buffer.concat([tag, payload]);
}

/** Encode a plain JS object into Protobuf wire bytes according to `schemaName`. */
export function encodeMessage(schemaName, value, registry) {
  const schema = registry[schemaName];
  if (!schema) throw new Error(`Unknown protobuf schema: ${schemaName}`);
  if (!value) return Buffer.alloc(0);

  const chunks = [];
  for (const field of schema) {
    const [fieldNumber, propName, kind, opts = {}] = field;
    const propVal = value[propName];
    if (propVal === undefined || propVal === null) continue;

    if (opts.repeated) {
      for (const item of propVal) {
        chunks.push(encodeFieldEntry(fieldNumber, kind, item, registry));
      }
      continue;
    }

    if (kind.startsWith('map:')) {
      chunks.push(encodeFieldEntry(fieldNumber, kind, propVal, registry));
      continue;
    }

    if (isZeroDefault(kind, propVal, opts)) continue;
    chunks.push(encodeFieldEntry(fieldNumber, kind, propVal, registry));
  }
  return Buffer.concat(chunks);
}

function decodeEntry(kind, wireType, buffer, offset, registry) {
  if (kind.startsWith('message:')) {
    if (wireType !== 2) throw new Error(`Expected wireType 2 for ${kind}, got ${wireType}`);
    const lenRes = decodeVarint(buffer, offset);
    const end = lenRes.offset + Number(lenRes.value);
    const nestedName = kind.slice('message:'.length);
    const decoded = decodeMessage(nestedName, buffer.subarray(lenRes.offset, end), registry);
    return { value: decoded, offset: end };
  }
  return decodeScalar(kind, wireType, buffer, offset);
}

/** Decode Protobuf wire bytes into a plain JS object according to `schemaName`. */
export function decodeMessage(schemaName, buffer, registry) {
  const schema = registry[schemaName];
  if (!schema) throw new Error(`Unknown protobuf schema: ${schemaName}`);

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const byTag = new Map(schema.map(field => [field[0], field]));
  const result = {};
  for (const field of schema) {
    const [, propName, kind, opts = {}] = field;
    if (opts.repeated) {
      result[propName] = [];
    } else if (kind.startsWith('map:')) {
      result[propName] = {};
    } else if (!opts.optional && !opts.oneof && !kind.startsWith('message:')) {
      if (kind === 'string') result[propName] = '';
      else if (kind === 'bool') result[propName] = false;
      else if (kind === 'bytes') result[propName] = Buffer.alloc(0);
      else result[propName] = 0;
    }
  }

  let cursor = 0;
  while (cursor < buf.length) {
    const tagRes = decodeVarint(buf, cursor);
    const tag = Number(tagRes.value);
    cursor = tagRes.offset;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    const field = byTag.get(fieldNumber);

    if (!field) {
      cursor = skipField(buf, cursor, wireType);
      continue;
    }

    const [, propName, kind, opts = {}] = field;
    if (kind.startsWith('map:')) {
      if (wireType !== 2) {
        cursor = skipField(buf, cursor, wireType);
        continue;
      }
      const [, keyKind, valKind] = kind.split(':');
      const lenRes = decodeVarint(buf, cursor);
      const entryEnd = lenRes.offset + Number(lenRes.value);
      const entrySlice = buf.subarray(lenRes.offset, entryEnd);
      const entrySchema = [
        [1, 'key', keyKind],
        [2, 'value', valKind],
      ];
      const pair = decodeMessage('__entry__', entrySlice, { ...registry, __entry__: entrySchema });
      if (pair.key !== undefined) {
        result[propName][String(pair.key)] = pair.value;
      }
      cursor = entryEnd;
      continue;
    }

    if (opts.repeated && wireType === 2 && !kind.startsWith('message:') && kind !== 'string' && kind !== 'bytes') {
      const lenRes = decodeVarint(buf, cursor);
      const packedEnd = lenRes.offset + Number(lenRes.value);
      let packedCursor = lenRes.offset;
      const scalarWire = kind === 'double' ? 1 : kind === 'float' ? 5 : 0;
      while (packedCursor < packedEnd) {
        const item = decodeScalar(kind, scalarWire, buf, packedCursor);
        result[propName].push(item.value);
        packedCursor = item.offset;
      }
      cursor = packedEnd;
      continue;
    }

    const decoded = decodeEntry(kind, wireType, buf, cursor, registry);
    cursor = decoded.offset;
    if (opts.repeated) {
      result[propName].push(decoded.value);
    } else {
      result[propName] = decoded.value;
    }
  }
  return result;
}

/** Convert a plain JS value into a `google.protobuf.Value` representation. */
export function toProtoValue(val) {
  if (val === null || val === undefined) return { nullValue: 0 };
  if (typeof val === 'boolean') return { boolValue: val };
  if (typeof val === 'number') return { numberValue: val };
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { listValue: { values: val.map(toProtoValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [key, item] of Object.entries(val)) {
      fields[key] = toProtoValue(item);
    }
    return { structValue: { fields } };
  }
  return { stringValue: String(val) };
}

/** Convert a `google.protobuf.Value` object back to a plain JS value. */
export function fromProtoValue(protoVal) {
  if (!protoVal || typeof protoVal !== 'object') return null;
  if (Object.hasOwn(protoVal, 'nullValue')) return null;
  if (Object.hasOwn(protoVal, 'numberValue')) return protoVal.numberValue;
  if (Object.hasOwn(protoVal, 'stringValue')) return protoVal.stringValue;
  if (Object.hasOwn(protoVal, 'boolValue')) return protoVal.boolValue;
  if (Object.hasOwn(protoVal, 'structValue')) {
    const out = {};
    for (const [key, item] of Object.entries(protoVal.structValue?.fields || {})) {
      out[key] = fromProtoValue(item);
    }
    return out;
  }
  if (Object.hasOwn(protoVal, 'listValue')) {
    return (protoVal.listValue?.values || []).map(fromProtoValue);
  }
  return null;
}
