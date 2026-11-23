import { fromProtoValue, toProtoValue } from './proto-wire.js';

const BUILTIN_TOOLS = [
  {
    name: 'Read',
    description: 'Read a file from the local workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read.' },
        offset: { type: 'integer', description: '1-based starting line number.' },
        limit: { type: 'integer', description: 'Maximum number of lines to read.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Write',
    description: 'Write full content to a file in the workspace (creates or overwrites).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write.' },
        contents: { type: 'string', description: 'Complete file content to write.' },
      },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'StrReplace',
    description: 'Perform an exact string replacement inside an existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to modify.' },
        old_string: { type: 'string', description: 'Exact existing text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences if true.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Delete',
    description: 'Delete a file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Shell',
    description: 'Execute a shell command in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        working_directory: { type: 'string', description: 'Optional working directory.' },
        description: { type: 'string', description: 'Short explanation of the command.' },
        timeout: { type: 'integer', description: 'Optional timeout in milliseconds.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Grep',
    description: 'Search files in the workspace using regular expressions.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern.' },
        path: { type: 'string', description: 'Directory or file path to search.' },
        glob: { type: 'string', description: 'Optional glob filter.' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        '-i': { type: 'boolean', description: 'Case insensitive search.' },
        '-B': { type: 'integer', description: 'Context lines before match.' },
        '-A': { type: 'integer', description: 'Context lines after match.' },
        '-C': { type: 'integer', description: 'Context lines around match.' },
        head_limit: { type: 'integer', description: 'Limit number of results.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        glob_pattern: { type: 'string', description: 'Glob pattern to match.' },
        target_directory: { type: 'string', description: 'Root directory to search.' },
      },
      required: ['glob_pattern'],
    },
  },
  {
    name: 'LS',
    description: 'List directory contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list.' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to ignore.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'ReadLints',
    description: 'Read IDE diagnostics/lints for a file path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to inspect.' },
      },
      required: ['path'],
    },
  },
];

export function normalizeToolName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseMcpParameters(definition) {
  if (definition.inputSchemaJson) {
    try {
      return JSON.parse(definition.inputSchemaJson);
    } catch {
      // Fall through to structured inputSchema.
    }
  }
  if (definition.inputSchema) {
    const converted = fromProtoValue(definition.inputSchema);
    if (converted && typeof converted === 'object') return converted;
  }
  return { type: 'object', properties: {} };
}

/** Build OpenAI `tools` definitions combining Cursor builtins and active MCP tools. */
export function buildOpenAiTools(mcpDefinitions = []) {
  const tools = BUILTIN_TOOLS.map(item => ({
    type: 'function',
    function: {
      name: item.name,
      description: item.description,
      parameters: item.parameters,
    },
  }));
  const seenNames = new Set(tools.map(item => item.function.name));
  const mcpMap = new Map();
  for (const def of mcpDefinitions) {
    if (!def?.name || seenNames.has(def.name)) continue;
    seenNames.add(def.name);
    mcpMap.set(def.name, def);
    tools.push({
      type: 'function',
      function: {
        name: def.name,
        description: def.description || `MCP tool ${def.toolName || def.name}`,
        parameters: parseMcpParameters(def),
      },
    });
  }
  return { tools, mcpMap };
}

function pickString(args, keys) {
  for (const key of keys) {
    if (typeof args[key] === 'string' && args[key].length > 0) return args[key];
  }
  return null;
}

/** Build a Cursor `ToolCall` card message for `ToolCallStartedUpdate` / `ToolCallCompletedUpdate`. */
export function renderToolCard({ callId, name, args, result = null }) {
  const norm = normalizeToolName(name);
  const toolCall = { toolCallId: callId };

  if (norm === 'shell' || norm === 'bash') {
    toolCall.shellToolCall = {
      args: {
        command: String(args.command || ''),
        workingDirectory: String(args.working_directory || ''),
        timeout: Number(args.timeout || 30000),
        toolCallId: callId,
        timeoutBehavior: 1,
        closeStdin: true,
        description: args.description,
      },
      ...(result ? { result } : {}),
    };
  } else if (norm === 'read') {
    toolCall.readToolCall = {
      args: {
        path: pickString(args, ['path', 'file_path', 'filePath']) || '',
        offset: args.offset,
        limit: args.limit,
      },
      ...(result ? { result } : {}),
    };
  } else if (norm === 'write' || norm === 'strreplace') {
    toolCall.editToolCall = {
      args: { path: pickString(args, ['path', 'file_path', 'filePath']) || '' },
      ...(result ? { result } : {}),
    };
  } else if (norm === 'delete') {
    toolCall.deleteToolCall = {
      args: { path: pickString(args, ['path', 'file_path', 'filePath']) || '', toolCallId: callId },
      ...(result ? { result } : {}),
    };
  } else if (norm === 'grep') {
    toolCall.grepToolCall = {
      args: { pattern: String(args.pattern || ''), path: args.path, toolCallId: callId },
      ...(result ? { result } : {}),
    };
  } else if (norm === 'glob') {
    toolCall.globToolCall = {
      args: { globPattern: String(args.glob_pattern || ''), targetDirectory: args.target_directory },
      ...(result ? { result } : {}),
    };
  } else if (norm === 'ls') {
    toolCall.lsToolCall = {
      args: { path: String(args.path || '.'), ignore: args.ignore || [], toolCallId: callId },
      ...(result ? { result } : {}),
    };
  } else if (norm === 'readlints') {
    const target = pickString(args, ['path', 'file_path', 'filePath']) || '';
    toolCall.readLintsToolCall = {
      args: { paths: target ? [target] : [] },
      ...(result ? { result } : {}),
    };
  } else {
    toolCall.mcpToolCall = {
      args: { name, toolCallId: callId, toolName: name },
      ...(result ? { result } : {}),
    };
  }

  return toolCall;
}

/** Build an `ExecServerMessage` requesting Cursor client execution of `call`. */
export function buildExecRequest({ execIdNum, callId, name, args, mcpDef, conversationId, workspaceDir }) {
  const norm = normalizeToolName(name);
  const base = { id: execIdNum, execId: callId, acceptHookAdditionalContexts: true };

  if (mcpDef) {
    const structArgs = {};
    for (const [key, val] of Object.entries(args || {})) {
      structArgs[key] = toProtoValue(val);
    }
    return {
      ...base,
      mcpArgs: {
        name: mcpDef.name,
        args: structArgs,
        toolCallId: callId,
        providerIdentifier: mcpDef.providerIdentifier || '',
        toolName: mcpDef.toolName || mcpDef.name,
        serverIdentifier: '',
      },
    };
  }

  if (norm === 'read') {
    const targetPath = pickString(args, ['path', 'file_path', 'filePath']);
    if (!targetPath) throw new Error('Read tool missing path');
    return {
      ...base,
      readArgs: {
        path: targetPath,
        toolCallId: callId,
        offset: Number.isInteger(args.offset) ? args.offset : undefined,
        limit: Number.isInteger(args.limit) ? args.limit : undefined,
      },
    };
  }

  if (norm === 'write' || norm === 'strreplace') {
    const targetPath = pickString(args, ['path', 'file_path', 'filePath']);
    if (!targetPath) throw new Error(`${name} tool missing path`);
    return {
      ...base,
      readArgs: { path: targetPath, toolCallId: callId },
    };
  }

  if (norm === 'delete') {
    const targetPath = pickString(args, ['path', 'file_path', 'filePath']);
    if (!targetPath) throw new Error('Delete tool missing path');
    return { ...base, deleteArgs: { path: targetPath, toolCallId: callId } };
  }

  if (norm === 'shell' || norm === 'bash') {
    if (typeof args.command !== 'string' || !args.command) throw new Error('Shell tool missing command');
    return {
      ...base,
      shellStreamArgs: {
        command: args.command,
        workingDirectory: args.working_directory || workspaceDir || '',
        timeout: Number(args.timeout || 30000),
        toolCallId: callId,
        simpleCommands: [],
        fileOutputThresholdBytes: 40000,
        timeoutBehavior: 1,
        hardTimeout: 86400000,
        description: args.description,
        closeStdin: true,
        conversationId,
      },
    };
  }

  if (norm === 'grep') {
    if (typeof args.pattern !== 'string') throw new Error('Grep tool missing pattern');
    return {
      ...base,
      grepArgs: {
        pattern: args.pattern,
        path: args.path,
        glob: args.glob,
        outputMode: args.output_mode,
        contextBefore: args['-B'],
        contextAfter: args['-A'],
        context: args['-C'],
        caseInsensitive: args['-i'],
        headLimit: args.head_limit,
        toolCallId: callId,
      },
    };
  }

  if (norm === 'glob') {
    return {
      ...base,
      grepArgs: {
        pattern: '',
        path: args.target_directory,
        glob: args.glob_pattern,
        outputMode: 'files_with_matches',
        toolCallId: callId,
      },
    };
  }

  if (norm === 'ls') {
    return {
      ...base,
      lsArgs: {
        path: args.path || workspaceDir || '.',
        ignore: Array.isArray(args.ignore) ? args.ignore : [],
        toolCallId: callId,
      },
    };
  }

  if (norm === 'readlints') {
    const targetPath = pickString(args, ['path', 'file_path', 'filePath']) || '';
    return { ...base, diagnosticsArgs: { path: targetPath, toolCallId: callId } };
  }

  throw new Error(`Unsupported tool call: ${name}`);
}

/** Apply `Write` or `StrReplace` against the `ReadResult` returned by Cursor. */
export function computeEditedContent(name, args, readResult) {
  const norm = normalizeToolName(name);
  let before = '';
  if (readResult?.success) {
    if (readResult.success.truncated) {
      throw new Error('Cannot edit truncated Read result');
    }
    if (typeof readResult.success.content === 'string') {
      before = readResult.success.content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    } else {
      throw new Error('Cannot edit binary file');
    }
  } else if (readResult?.fileNotFound) {
    if (norm !== 'write') throw new Error(`File not found: ${readResult.fileNotFound.path}`);
    before = '';
  } else if (readResult?.error) {
    throw new Error(readResult.error.error || 'Read failed');
  } else if (readResult?.rejected) {
    throw new Error(readResult.rejected.reason || 'Read rejected');
  } else if (readResult?.permissionDenied) {
    throw new Error(`Permission denied reading ${readResult.permissionDenied.path}`);
  } else {
    throw new Error('Empty ReadResult');
  }

  if (norm === 'write') {
    const raw = args.contents ?? args.content;
    if (typeof raw !== 'string') throw new Error('Write tool missing contents');
    return { before, after: raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n') };
  }

  const oldStr = typeof args.old_string === 'string' ? args.old_string.replaceAll('\r\n', '\n') : '';
  const newStr = typeof args.new_string === 'string' ? args.new_string.replaceAll('\r\n', '\n') : '';
  if (!oldStr) throw new Error('old_string must not be empty');
  const matches = before.split(oldStr).length - 1;
  if (matches === 0) throw new Error('old_string was not found in file');
  if (!args.replace_all && matches > 1) {
    throw new Error(`old_string is not unique; found ${matches} occurrences`);
  }
  const after = args.replace_all ? before.replaceAll(oldStr, newStr) : before.replace(oldStr, newStr);
  return { before, after };
}

/** Convert a terminal Cursor `ExecClientMessage` into `{ text, isError, cardResult }` for OpenAI & UI. */
export function formatExecResult(name, args, execClientMsg, editContext = null) {
  const norm = normalizeToolName(name);

  if (execClientMsg.readResult || execClientMsg.redactedReadResult) {
    const res = execClientMsg.readResult || execClientMsg.redactedReadResult;
    if (res.success) {
      const content = typeof res.success.content === 'string' ? res.success.content : `read binary bytes=${res.success.fileSize || 0}`;
      return {
        text: content,
        isError: false,
        cardResult: {
          success: {
            content,
            totalLines: res.success.totalLines || 0,
            fileSize: res.success.fileSize || 0,
            path: res.success.path || '',
          },
        },
      };
    }
    const errMsg =
      res.error?.error ||
      res.rejected?.reason ||
      (res.fileNotFound ? `file not found: ${res.fileNotFound.path}` : null) ||
      (res.permissionDenied ? `permission denied: ${res.permissionDenied.path}` : null) ||
      res.invalidFile?.reason ||
      'read failed';
    return { text: errMsg, isError: true, cardResult: { error: { message: errMsg } } };
  }

  if (execClientMsg.writeResult) {
    const res = execClientMsg.writeResult;
    if (res.success) {
      const targetPath = res.success.path || pickString(args, ['path', 'file_path', 'filePath']) || '';
      const afterText = editContext?.after ?? res.success.fileContentAfterWrite ?? '';
      const beforeText = editContext?.before ?? '';
      return {
        text: res.success.fileContentAfterWrite || `write success path=${targetPath} lines=${res.success.linesCreated || 0}`,
        isError: false,
        cardResult: {
          success: {
            path: targetPath,
            linesAdded: afterText.split('\n').length,
            linesRemoved: beforeText ? beforeText.split('\n').length : 0,
            beforeFullFileContent: beforeText,
            afterFullFileContent: afterText,
          },
        },
      };
    }
    const errMsg = res.error?.error || res.rejected?.reason || res.permissionDenied?.error || 'write failed';
    return {
      text: errMsg,
      isError: true,
      cardResult: { error: { path: pickString(args, ['path']) || '', error: errMsg, modelVisibleError: errMsg } },
    };
  }

  if (execClientMsg.deleteResult) {
    const res = execClientMsg.deleteResult;
    if (res.success) {
      return { text: `delete success path=${res.success.path}`, isError: false, cardResult: res };
    }
    const errMsg =
      res.error?.error ||
      res.rejected?.reason ||
      (res.fileNotFound ? `file not found: ${res.fileNotFound.path}` : null) ||
      'delete failed';
    return { text: errMsg, isError: true, cardResult: res };
  }

  if (execClientMsg.shellResult) {
    const res = execClientMsg.shellResult;
    if (res.success) {
      const stdout = res.success.stdout || '';
      const stderr = res.success.stderr || '';
      const out = stdout && stderr ? `${stdout}\n\n<stderr>\n${stderr}\n</stderr>` : stdout || stderr || 'shell completed without output';
      return { text: out, isError: false, cardResult: res };
    }
    const fail = res.failure;
    const errText = fail
      ? [fail.stdout, fail.stderr].filter(Boolean).join('\n') || `exit code ${fail.exitCode}`
      : res.rejected?.reason || res.permissionDenied?.error || res.spawnError?.error || 'shell failed';
    return { text: errText, isError: true, cardResult: res };
  }

  if (execClientMsg.grepResult) {
    const res = execClientMsg.grepResult;
    if (res.success) {
      const formatted = formatGrepSuccess(res.success, norm === 'glob');
      if (norm === 'glob') {
        const files = [];
        for (const wsRes of Object.values(res.success.workspaceResults || {})) {
          if (wsRes.files?.files) files.push(...wsRes.files.files);
        }
        return {
          text: formatted,
          isError: false,
          cardResult: {
            success: {
              pattern: args.glob_pattern || '',
              path: args.target_directory || '',
              files,
              totalFiles: files.length,
            },
          },
        };
      }
      return { text: formatted, isError: false, cardResult: res };
    }
    const errMsg = res.error?.message || 'grep failed';
    return { text: errMsg, isError: true, cardResult: { error: { message: errMsg } } };
  }

  if (execClientMsg.lsResult) {
    const res = execClientMsg.lsResult;
    if (res.success?.directoryTreeRoot) {
      return { text: formatDirectoryTree(res.success.directoryTreeRoot), isError: false, cardResult: res };
    }
    const errMsg = res.error?.error || res.rejected?.reason || 'ls failed';
    return { text: errMsg, isError: true, cardResult: res };
  }

  if (execClientMsg.diagnosticsResult) {
    const res = execClientMsg.diagnosticsResult;
    if (res.success) {
      const diags = res.success.diagnostics || [];
      const lines = diags.map(item => `L${item.range?.start?.line ?? 0}: ${item.message}`);
      return {
        text: lines.length ? lines.join('\n') : 'no diagnostics',
        isError: false,
        cardResult: {
          success: {
            fileDiagnostics: [{ path: res.success.path || '', diagnostics: diags, diagnosticsCount: diags.length }],
            totalFiles: 1,
            totalDiagnostics: diags.length,
          },
        },
      };
    }
    const errMsg = res.error?.error || 'diagnostics failed';
    return { text: errMsg, isError: true, cardResult: { error: { message: errMsg } } };
  }

  if (execClientMsg.mcpResult) {
    const res = execClientMsg.mcpResult;
    if (res.success) {
      const parts = (res.success.content || [])
        .map(item => item.text?.text || (item.image ? '[image]' : ''))
        .filter(Boolean);
      return { text: parts.join('\n') || 'ok', isError: Boolean(res.success.isError), cardResult: { success: res.success } };
    }
    const errMsg = res.error?.message || res.rejected?.reason || 'mcp tool failed';
    return { text: errMsg, isError: true, cardResult: { error: { error: errMsg } } };
  }

  return { text: 'unsupported tool result', isError: true, cardResult: null };
}

function formatGrepSuccess(success, filesOnly) {
  const lines = [];
  const buckets = Object.values(success.workspaceResults || {});
  if (success.activeEditorResult) buckets.push(success.activeEditorResult);
  for (const bucket of buckets) {
    if (bucket.files?.files) {
      lines.push(...bucket.files.files);
    } else if (bucket.content?.matches) {
      for (const fileMatch of bucket.content.matches) {
        if (filesOnly) {
          lines.push(fileMatch.file);
        } else {
          for (const entry of fileMatch.matches || []) {
            lines.push(`${fileMatch.file}:${entry.lineNumber}:${entry.content}`);
          }
        }
      }
    } else if (bucket.count?.counts) {
      for (const entry of bucket.count.counts) {
        lines.push(`${entry.file}: ${entry.count}`);
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'no matches found';
}

function formatDirectoryTree(node, depth = 0) {
  const indent = '  '.repeat(depth);
  const lines = [`${indent}${node.absPath || '/'}/`];
  for (const file of node.childrenFiles || []) {
    lines.push(`${indent}  ${file.name}`);
  }
  for (const childDir of node.childrenDirs || []) {
    lines.push(formatDirectoryTree(childDir, depth + 1));
  }
  return lines.join('\n');
}
