/**
 * Zero-dependency surgical JSONC parser and top-level property editor.
 * Preserves comments, indentation, EOL style, and unrelated formatting.
 */

function tokenize(text) {
  const tokens = [];
  let cursor = 0;
  const length = text.length;

  while (cursor < length) {
    const char = text[cursor];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      cursor += 1;
      continue;
    }

    if (char === '/' && text[cursor + 1] === '/') {
      cursor += 2;
      while (cursor < length && text[cursor] !== '\n' && text[cursor] !== '\r') {
        cursor += 1;
      }
      continue;
    }

    if (char === '/' && text[cursor + 1] === '*') {
      const start = cursor;
      cursor += 2;
      let closed = false;
      while (cursor < length) {
        if (text[cursor] === '*' && text[cursor + 1] === '/') {
          cursor += 2;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) {
        throw new Error(`Unterminated block comment at offset ${start}`);
      }
      continue;
    }

    if ('{}[]:,'.includes(char)) {
      tokens.push({ type: char, start: cursor, end: cursor + 1, raw: char });
      cursor += 1;
      continue;
    }

    if (char === '"') {
      const start = cursor;
      cursor += 1;
      let closed = false;
      while (cursor < length) {
        const current = text[cursor];
        if (current === '\\') {
          cursor += 2;
          continue;
        }
        if (current === '"') {
          cursor += 1;
          closed = true;
          break;
        }
        if (current.charCodeAt(0) < 0x20) {
          throw new Error(`Unescaped control character in string at offset ${cursor}`);
        }
        cursor += 1;
      }
      if (!closed) {
        throw new Error(`Unterminated string literal at offset ${start}`);
      }
      const raw = text.slice(start, cursor);
      tokens.push({ type: 'string', start, end: cursor, raw, value: JSON.parse(raw) });
      continue;
    }

    if (char === '-' || (char >= '0' && char <= '9')) {
      const slice = text.slice(cursor);
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(slice);
      if (!match) {
        throw new Error(`Invalid number token at offset ${cursor}`);
      }
      const raw = match[0];
      const end = cursor + raw.length;
      tokens.push({ type: 'number', start: cursor, end, raw, value: Number(raw) });
      cursor = end;
      continue;
    }

    if (text.startsWith('true', cursor)) {
      tokens.push({ type: 'literal', start: cursor, end: cursor + 4, raw: 'true', value: true });
      cursor += 4;
      continue;
    }
    if (text.startsWith('false', cursor)) {
      tokens.push({ type: 'literal', start: cursor, end: cursor + 5, raw: 'false', value: false });
      cursor += 5;
      continue;
    }
    if (text.startsWith('null', cursor)) {
      tokens.push({ type: 'literal', start: cursor, end: cursor + 4, raw: 'null', value: null });
      cursor += 4;
      continue;
    }

    throw new Error(`Unexpected token '${char}' at offset ${cursor}`);
  }

  return tokens;
}

function parseValue(tokens, state) {
  const token = tokens[state.index];
  if (!token) {
    throw new Error('Unexpected end of JSONC input');
  }

  if (token.type === 'string' || token.type === 'number' || token.type === 'literal') {
    state.index += 1;
    return { value: token.value, start: token.start, end: token.end, properties: null };
  }

  if (token.type === '[') {
    const start = token.start;
    state.index += 1;
    const items = [];
    while (state.index < tokens.length && tokens[state.index].type !== ']') {
      items.push(parseValue(tokens, state).value);
      if (tokens[state.index]?.type === ',') {
        state.index += 1;
        if (tokens[state.index]?.type === ']') break;
      } else if (tokens[state.index]?.type !== ']') {
        throw new Error(`Expected ',' or ']' in array at offset ${tokens[state.index]?.start ?? start}`);
      }
    }
    if (tokens[state.index]?.type !== ']') {
      throw new Error(`Unterminated array starting at offset ${start}`);
    }
    const end = tokens[state.index].end;
    state.index += 1;
    return { value: items, start, end, properties: null };
  }

  if (token.type === '{') {
    const start = token.start;
    state.index += 1;
    const result = {};
    const properties = [];

    while (state.index < tokens.length && tokens[state.index].type !== '}') {
      const keyToken = tokens[state.index];
      if (!keyToken || keyToken.type !== 'string') {
        throw new Error(`Expected string property key at offset ${keyToken?.start ?? start}`);
      }
      state.index += 1;

      const colonToken = tokens[state.index];
      if (!colonToken || colonToken.type !== ':') {
        throw new Error(`Expected ':' after key at offset ${colonToken?.start ?? keyToken.end}`);
      }
      state.index += 1;

      const parsedVal = parseValue(tokens, state);
      result[keyToken.value] = parsedVal.value;

      let commaToken = null;
      if (tokens[state.index]?.type === ',') {
        commaToken = tokens[state.index];
        state.index += 1;
      } else if (tokens[state.index]?.type !== '}') {
        throw new Error(`Expected ',' or '}' in object at offset ${tokens[state.index]?.start ?? parsedVal.end}`);
      }

      properties.push({
        key: keyToken.value,
        keyStart: keyToken.start,
        keyEnd: keyToken.end,
        valueStart: parsedVal.start,
        valueEnd: parsedVal.end,
        commaStart: commaToken ? commaToken.start : null,
        commaEnd: commaToken ? commaToken.end : null,
      });

      if (commaToken && tokens[state.index]?.type === '}') {
        break;
      }
    }

    if (tokens[state.index]?.type !== '}') {
      throw new Error(`Unterminated object starting at offset ${start}`);
    }
    const end = tokens[state.index].end;
    state.index += 1;
    return { value: result, start, end, properties };
  }

  throw new Error(`Unexpected token '${token.raw}' at offset ${token.start}`);
}

/** Parse a JSONC string and return the parsed value along with top-level spans. */
export function parseJsoncWithMeta(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    throw new Error('Empty JSONC document');
  }
  const state = { index: 0 };
  const root = parseValue(tokens, state);
  if (state.index !== tokens.length) {
    const trailing = tokens[state.index];
    throw new Error(`Unexpected trailing token '${trailing.raw}' at offset ${trailing.start}`);
  }
  return root;
}

/** Parse a JSONC string into a plain JavaScript value. */
export function parseJsonc(text) {
  return parseJsoncWithMeta(text).value;
}

function detectIndent(text, properties, objectStart) {
  if (properties.length > 0) {
    const firstStart = properties[0].keyStart;
    const lineStart = text.lastIndexOf('\n', firstStart - 1) + 1;
    const prefix = text.slice(lineStart, firstStart);
    if (/^[ \t]+$/.test(prefix)) {
      return prefix;
    }
  }
  const afterBrace = text.slice(objectStart + 1);
  const match = /^\r?\n([ \t]+)/.exec(afterBrace);
  return match ? match[1] : '  ';
}

function expandRemovalLine(text, removeStart, removeEnd) {
  let lineStart = text.lastIndexOf('\n', removeStart - 1);
  lineStart = lineStart === -1 ? 0 : lineStart + 1;
  const beforeOnLine = text.slice(lineStart, removeStart);

  let afterEnd = removeEnd;
  while (afterEnd < text.length && (text[afterEnd] === ' ' || text[afterEnd] === '\t')) {
    afterEnd += 1;
  }

  if (/^[ \t]*$/.test(beforeOnLine)) {
    if (text[afterEnd] === '\r' && text[afterEnd + 1] === '\n') {
      return { start: lineStart, end: afterEnd + 2 };
    }
    if (text[afterEnd] === '\n') {
      return { start: lineStart, end: afterEnd + 1 };
    }
  }
  return { start: removeStart, end: removeEnd };
}

/**
 * Surgically set or remove a top-level property on a JSONC object document.
 * Pass `exists: false` (or `value === undefined`) to delete the property.
 */
function removePropertyAt(text, properties, matchIndex) {
  const prop = properties[matchIndex];
  const removeEnd = prop.commaEnd !== null ? prop.commaEnd : prop.valueEnd;
  let updated;

  if (prop.commaEnd === null && matchIndex > 0) {
    const prev = properties[matchIndex - 1];
    const { start: expandedStart, end: expandedEnd } = expandRemovalLine(text, prop.keyStart, removeEnd);
    if (prev.commaStart !== null && prev.commaEnd !== null && expandedStart >= prev.commaEnd) {
      updated =
        text.slice(0, prev.commaStart) +
        text.slice(prev.commaEnd, expandedStart) +
        text.slice(expandedEnd);
    } else {
      updated = text.slice(0, expandedStart) + text.slice(expandedEnd);
    }
  } else {
    const { start: expandedStart, end: expandedEnd } = expandRemovalLine(text, prop.keyStart, removeEnd);
    let finalEnd = expandedEnd;
    if (expandedStart === prop.keyStart && text[finalEnd] === ' ') {
      finalEnd += 1;
    }
    updated = text.slice(0, expandedStart) + text.slice(finalEnd);
  }
  parseJsoncWithMeta(updated);
  return updated;
}

export function setJsoncProperty(text, key, value, exists = value !== undefined) {
  const root = parseJsoncWithMeta(text);
  if (!root.properties || Array.isArray(root.value) || typeof root.value !== 'object' || root.value === null) {
    throw new Error('Root JSONC value must be an object');
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const properties = root.properties;
  const matchIndex = properties.findLastIndex(prop => prop.key === key);

  if (!exists) {
    if (matchIndex === -1) {
      return text;
    }
    let updated = text;
    let currentRoot = root;
    let idx = matchIndex;
    while (idx !== -1) {
      updated = removePropertyAt(updated, currentRoot.properties, idx);
      currentRoot = parseJsoncWithMeta(updated);
      idx = currentRoot.properties.findLastIndex(prop => prop.key === key);
    }
    return updated;
  }

  const serializedValue = JSON.stringify(value);

  if (matchIndex !== -1) {
    const prop = properties[matchIndex];
    const updated = text.slice(0, prop.valueStart) + serializedValue + text.slice(prop.valueEnd);
    parseJsoncWithMeta(updated);
    return updated;
  }

  const indent = detectIndent(text, properties, root.start);
  const entryText = `${JSON.stringify(key)}: ${serializedValue}`;

  if (properties.length === 0) {
    const inner = text.slice(root.start + 1, root.end - 1);
    const multiline = inner.includes('\n') || text.includes('\n');
    let updated;
    if (!multiline) {
      updated = `${text.slice(0, root.start + 1)}${eol}${indent}${entryText}${eol}${text.slice(root.end - 1)}`;
    } else {
      const closingLineStart = text.lastIndexOf('\n', root.end - 1) + 1;
      const closingPrefix = text.slice(closingLineStart, root.end - 1);
      if (/^[ \t]*$/.test(closingPrefix)) {
        updated = `${text.slice(0, closingLineStart)}${indent}${entryText}${eol}${closingPrefix}${text.slice(root.end - 1)}`;
      } else {
        updated = `${text.slice(0, root.end - 1)}${eol}${indent}${entryText}${eol}${text.slice(root.end - 1)}`;
      }
    }
    parseJsoncWithMeta(updated);
    return updated;
  }

  const last = properties[properties.length - 1];
  const lastLineStart = text.lastIndexOf('\n', last.keyStart - 1) + 1;
  const lastSameLine = lastLineStart === text.lastIndexOf('\n', root.end - 1) + 1;

  let updated;
  if (lastSameLine) {
    const needsComma = last.commaEnd === null;
    const insertAt = needsComma ? last.valueEnd : last.commaEnd;
    const commaPrefix = needsComma ? ',' : '';
    updated = `${text.slice(0, insertAt)}${commaPrefix} ${entryText}${text.slice(insertAt)}`;
  } else if (last.commaEnd !== null) {
    const afterComma = text.slice(last.commaEnd);
    const eolMatch = /^\r?\n/.exec(afterComma);
    if (!eolMatch) {
      updated = `${text.slice(0, last.commaEnd)}${eol}${indent}${entryText}${eol}${text.slice(last.commaEnd)}`;
    } else {
      const insertAt = last.commaEnd + eolMatch[0].length;
      updated = `${text.slice(0, insertAt)}${indent}${entryText}${eol}${text.slice(insertAt)}`;
    }
  } else {
    updated = `${text.slice(0, last.valueEnd)},${eol}${indent}${entryText}${text.slice(last.valueEnd)}`;
  }

  parseJsoncWithMeta(updated);
  return updated;
}
