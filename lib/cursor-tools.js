import { fromProtoValue, toProtoValue } from './proto-wire.js';

const DIRECT_MCP_TOOL_LIMIT = 6;
const DIRECT_MCP_SCHEMA_CHAR_LIMIT = 4_000;
const MAX_MCP_CATALOG_CHARS = 12_000;
const MAX_GET_MCP_TOOLS_CHARS = 24_000;
const MAX_TOOL_RESULT_CHARS = 32_000;

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

const META_MCP_TOOLS = [
  {
    name: 'GetMcpTools',
    description:
      'Discover and inspect MCP tools and their input JSON schemas before calling CallMcpTool. Prefer passing {"server":"<id>"} or {"server":"<id>","toolName":"<name>"} or {"pattern":"<regex>"}.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server identifier or name to inspect.' },
        toolName: { type: 'string', description: 'Specific tool name within the server.' },
        pattern: { type: 'string', description: 'Case-insensitive regex to search servers/tools.' },
      },
    },
  },
  {
    name: 'CallMcpTool',
    description:
      'Invoke an MCP tool discovered via GetMcpTools (or listed in the MCP server catalog). Always inspect the tool schema with GetMcpTools before calling.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server identifier or name.' },
        toolName: { type: 'string', description: 'Exact MCP tool name on that server (or full tool name).' },
        arguments: {
          type: 'object',
          description: 'JSON arguments matching the tool input schema.',
          additionalProperties: true,
        },
      },
      required: ['toolName'],
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
  return null;
}

/** Collapse whitespace onto a single line and truncate to `maxChars`. */
export function compactText(text, maxChars) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function boundTextHeadTail(text, maxChars, hint = '') {
  const raw = String(text ?? '');
  if (raw.length <= maxChars) return raw;
  const tailLen = Math.min(4_000, Math.floor(maxChars * 0.25));
  const headLen = Math.max(256, maxChars - tailLen - 160);
  const omitted = raw.length - headLen - tailLen;
  const suffix = hint ? ` (${hint})` : '';
  return `${raw.slice(0, headLen)}\n\n... [${omitted} chars omitted${suffix}] ...\n\n${raw.slice(raw.length - tailLen)}`;
}

function inferServerIdentifier(def) {
  if (def.serverIdentifier) return def.serverIdentifier;
  const fullName = String(def.name || '');
  const toolName = String(def.toolName || '');
  if (toolName && fullName.endsWith(`-${toolName}`) && fullName.length > toolName.length + 1) {
    return fullName.slice(0, -(toolName.length + 1));
  }
  return def.providerIdentifier || 'mcp';
}

function buildMcpCatalog(mcpDefinitions = [], options = {}) {
  const byFullName = new Map();
  const serversMap = new Map();
  const instructionByServer = new Map();
  for (const inst of options.mcpInstructions || []) {
    if (!inst?.instructions) continue;
    const key = inst.serverIdentifier || inst.serverName;
    if (key) instructionByServer.set(key, String(inst.instructions).trim());
  }

  const ensureServer = (serverIdentifier, serverName, instructions = '') => {
    const id = serverIdentifier || serverName || 'mcp';
    let server = serversMap.get(id);
    if (!server) {
      server = {
        serverIdentifier: id,
        serverName: serverName || id,
        instructions: instructions || instructionByServer.get(id) || instructionByServer.get(serverName) || '',
        tools: [],
        toolByName: new Map(),
      };
      serversMap.set(id, server);
    } else {
      if (serverName && server.serverName === server.serverIdentifier) server.serverName = serverName;
      if (instructions && !server.instructions) server.instructions = instructions;
    }
    return server;
  };

  const upsertTool = entry => {
    const fullName = entry.name;
    if (!fullName) return;
    const existing = byFullName.get(fullName);
    if (existing) {
      if (!existing.description && entry.description) existing.description = entry.description;
      if (!existing.parameters && entry.parameters) existing.parameters = entry.parameters;
      if (!existing.definitionPath && entry.definitionPath) existing.definitionPath = entry.definitionPath;
      if (!existing.providerIdentifier && entry.providerIdentifier) existing.providerIdentifier = entry.providerIdentifier;
      if (!existing.serverIdentifier && entry.serverIdentifier) existing.serverIdentifier = entry.serverIdentifier;
      return;
    }
    byFullName.set(fullName, entry);
    const server = ensureServer(entry.serverIdentifier, entry.providerIdentifier);
    if (!server.toolByName.has(entry.toolName)) {
      server.toolByName.set(entry.toolName, entry);
      server.tools.push(entry);
    }
  };

  for (const def of mcpDefinitions) {
    if (!def?.name) continue;
    const toolName = def.toolName || def.name;
    const serverIdentifier = inferServerIdentifier(def);
    const providerIdentifier = def.providerIdentifier || serverIdentifier;
    upsertTool({
      name: def.name,
      toolName,
      serverIdentifier,
      providerIdentifier,
      description: def.description || '',
      parameters: parseMcpParameters(def),
      inputSchema: def.inputSchema,
      inputSchemaJson: def.inputSchemaJson,
      definitionPath: def.definitionPath || '',
    });
  }

  const descriptors = [
    ...(options.mcpMetaToolOptions?.mcpDescriptors || []),
    ...(options.mcpFileSystemOptions?.mcpDescriptors || []),
  ];
  for (const desc of descriptors) {
    if (!desc) continue;
    const serverId = desc.serverIdentifier || desc.serverName || 'mcp';
    const serverName = desc.serverName || serverId;
    ensureServer(serverId, serverName, desc.serverUseInstructions || '');
    for (const toolDesc of desc.tools || []) {
      if (!toolDesc?.toolName) continue;
      const fullName = `${serverId}-${toolDesc.toolName}`;
      upsertTool({
        name: fullName,
        toolName: toolDesc.toolName,
        serverIdentifier: serverId,
        providerIdentifier: serverName,
        description: toolDesc.description || '',
        parameters: parseMcpParameters(toolDesc),
        inputSchema: toolDesc.inputSchema,
        inputSchemaJson: toolDesc.inputSchemaJson,
        definitionPath: toolDesc.definitionPath || '',
      });
    }
  }

  const tools = Array.from(byFullName.values());
  const servers = Array.from(serversMap.values()).filter(server => server.tools.length > 0);
  return { tools, servers, byFullName };
}

function formatMcpServerCatalog(catalog) {
  if (!catalog || catalog.servers.length === 0) return '';
  const header = [
    '<dynamic_tools>',
    'You have access to MCP server tools via `GetMcpTools` and `CallMcpTool`.',
    'Inspect a server or tool schema with `GetMcpTools` (`{"server":"<id>"}` or `{"server":"<id>","toolName":"<name>"}` or `{"pattern":"<regex>"}`) before invoking with `CallMcpTool`.',
    '',
    'Available MCP servers:',
  ].join('\n');
  const lines = [];
  let usedChars = header.length + 24;
  for (const server of catalog.servers) {
    const toolNames = server.tools.map(t => t.toolName).join(', ');
    const instNote = server.instructions ? ` | note: ${compactText(server.instructions, 160)}` : '';
    const line = `- server="${server.serverIdentifier}" (${server.serverName}): tools=[${toolNames}]${instNote}`;
    if (lines.length > 0 && usedChars + line.length + 1 > MAX_MCP_CATALOG_CHARS) {
      const omitted = catalog.servers.length - lines.length;
      lines.push(`... (${omitted} additional MCP servers omitted; use GetMcpTools with pattern or no args)`);
      break;
    }
    lines.push(line.length > MAX_MCP_CATALOG_CHARS ? `${line.slice(0, MAX_MCP_CATALOG_CHARS - 1)}…` : line);
    usedChars += line.length + 1;
  }
  return `${header}\n${lines.join('\n')}\n</dynamic_tools>`;
}

/** Build OpenAI `tools` definitions combining Cursor builtins and active MCP tools. */
export function buildOpenAiTools(mcpDefinitions = [], options = {}) {
  const tools = BUILTIN_TOOLS.map(item => ({
    type: 'function',
    function: {
      name: item.name,
      description: item.description,
      parameters: item.parameters,
    },
  }));
  const seenNames = new Set(tools.map(item => item.function.name));
  const mcpCatalog = buildMcpCatalog(mcpDefinitions, options);
  const mcpMap = new Map();
  const directFunctions = [];
  let directSchemaChars = 0;

  for (const entry of mcpCatalog.tools) {
    if (!entry?.name || seenNames.has(entry.name)) continue;
    seenNames.add(entry.name);
    mcpMap.set(entry.name, entry);
    const params = entry.parameters || { type: 'object', properties: {} };
    const fnDef = {
      type: 'function',
      function: {
        name: entry.name,
        description: entry.description || `MCP tool ${entry.toolName || entry.name}`,
        parameters: params,
      },
    };
    directFunctions.push(fnDef);
    directSchemaChars += JSON.stringify(fnDef).length;
  }

  const useMetaTools =
    directFunctions.length > 0 &&
    (Boolean(options.mcpMetaToolOptions?.enabled) ||
      directFunctions.length > DIRECT_MCP_TOOL_LIMIT ||
      directSchemaChars > DIRECT_MCP_SCHEMA_CHAR_LIMIT);

  if (useMetaTools) {
    for (const meta of META_MCP_TOOLS) {
      tools.push({
        type: 'function',
        function: {
          name: meta.name,
          description: meta.description,
          parameters: meta.parameters,
        },
      });
    }
    return {
      tools,
      mcpMap,
      mcpCatalog,
      useMetaTools: true,
      mcpCatalogPrompt: formatMcpServerCatalog(mcpCatalog),
    };
  }

  tools.push(...directFunctions);
  return {
    tools,
    mcpMap,
    mcpCatalog,
    useMetaTools: false,
    mcpCatalogPrompt: '',
  };
}

function findCatalogServer(catalog, serverQuery) {
  if (!serverQuery) return null;
  const needle = String(serverQuery).trim().toLowerCase();
  return (
    catalog.servers.find(s => s.serverIdentifier.toLowerCase() === needle) ||
    catalog.servers.find(s => s.serverName.toLowerCase() === needle) ||
    null
  );
}

function resolveToolFromServer(server, toolQuery) {
  if (!server || !toolQuery) return null;
  const lower = toolQuery.toLowerCase();
  const stripped = toolQuery.startsWith(`${server.serverIdentifier}-`)
    ? toolQuery.slice(server.serverIdentifier.length + 1)
    : toolQuery.startsWith(`${server.serverName}-`)
      ? toolQuery.slice(server.serverName.length + 1)
      : '';
  return (
    server.tools.find(t => t.toolName === toolQuery) ||
    server.tools.find(t => t.toolName.toLowerCase() === lower) ||
    server.tools.find(t => t.name === toolQuery) ||
    server.tools.find(t => t.name.toLowerCase() === lower) ||
    (stripped
      ? server.tools.find(t => t.toolName.toLowerCase() === stripped.toLowerCase())
      : null) ||
    null
  );
}

/** Execute progressive MCP tool schema discovery against the session's MCP catalog. */
export function executeGetMcpTools(args = {}, catalog = { servers: [], tools: [] }) {
  const servers = catalog.servers || [];
  if (servers.length === 0) {
    return { text: 'No MCP servers are currently available.', isError: false };
  }
  const serverQuery = typeof args.server === 'string' ? args.server.trim() : '';
  const toolQuery = typeof args.toolName === 'string' ? args.toolName.trim() : '';
  const patternQuery = typeof args.pattern === 'string' ? args.pattern.trim() : '';

  let regex = null;
  if (patternQuery) {
    try {
      regex = new RegExp(patternQuery, 'i');
    } catch {
      const escaped = patternQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, 'i');
    }
  }

  let targetServers = servers;
  if (serverQuery) {
    const found = findCatalogServer(catalog, serverQuery);
    if (!found) {
      const available = servers.map(s => s.serverIdentifier).join(', ');
      return {
        text: `MCP server "${serverQuery}" not found. Available servers: ${available}`,
        isError: true,
      };
    }
    targetServers = [found];
  }

  if (serverQuery && toolQuery) {
    const server = targetServers[0];
    const tool = resolveToolFromServer(server, toolQuery);
    if (!tool) {
      return {
        text: `Tool "${toolQuery}" not found on server "${server.serverIdentifier}". Available tools: ${server.tools.map(t => t.toolName).join(', ')}`,
        isError: true,
      };
    }
    return {
      text: boundTextHeadTail(
        JSON.stringify(
          {
            server: server.serverIdentifier,
            serverName: server.serverName,
            toolName: tool.toolName,
            fullName: tool.name,
            description: tool.description || '',
            inputSchema: tool.parameters || { type: 'object', properties: {} },
            ...(tool.definitionPath ? { definitionPath: tool.definitionPath } : {}),
          },
          null,
          2
        ),
        MAX_GET_MCP_TOOLS_CHARS
      ),
      isError: false,
    };
  }

  const includeFullSchemas = Boolean(serverQuery && !regex);
  const payload = [];
  for (const server of targetServers) {
    const matchedTools = regex
      ? server.tools.filter(
          t =>
            regex.test(server.serverIdentifier) ||
            regex.test(server.serverName) ||
            regex.test(t.toolName) ||
            regex.test(t.description || '')
        )
      : server.tools;
    if (matchedTools.length === 0) continue;
    payload.push({
      server: server.serverIdentifier,
      serverName: server.serverName,
      ...(server.instructions ? { instructions: compactText(server.instructions, 400) } : {}),
      tools: matchedTools.map(t =>
        includeFullSchemas
          ? {
              toolName: t.toolName,
              description: t.description || '',
              inputSchema: t.parameters || { type: 'object', properties: {} },
              ...(t.definitionPath ? { definitionPath: t.definitionPath } : {}),
            }
          : {
              toolName: t.toolName,
              description: compactText(t.description || '', 200),
            }
      ),
    });
  }

  if (payload.length === 0) {
    return { text: `No MCP tools matched${patternQuery ? ` pattern "${patternQuery}"` : ''}.`, isError: false };
  }
  return {
    text: boundTextHeadTail(JSON.stringify(payload, null, 2), MAX_GET_MCP_TOOLS_CHARS, 'narrow with server or toolName'),
    isError: false,
  };
}

/** Resolve a `CallMcpTool` invocation to its underlying MCP tool definition and parsed arguments. */
export function resolveCallMcpTool(args = {}, catalog = { servers: [], tools: [], byFullName: new Map() }) {
  const serverQuery = typeof args.server === 'string' ? args.server.trim() : '';
  const toolQuery = typeof args.toolName === 'string' ? args.toolName.trim() : '';
  if (!toolQuery) {
    throw new Error('CallMcpTool missing toolName');
  }

  let toolArgs = args.arguments;
  if (typeof toolArgs === 'string') {
    try {
      toolArgs = JSON.parse(toolArgs);
    } catch {
      throw new Error('CallMcpTool arguments string is not valid JSON');
    }
  }
  if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
    toolArgs = {};
  }

  let mcpDef = null;
  if (serverQuery) {
    const server = findCatalogServer(catalog, serverQuery);
    if (!server) {
      const available = (catalog.servers || []).map(s => s.serverIdentifier).join(', ');
      throw new Error(`Unknown MCP server "${serverQuery}". Available servers: ${available || 'none'}`);
    }
    mcpDef = resolveToolFromServer(server, toolQuery);
    if (!mcpDef) {
      throw new Error(`Unknown tool "${toolQuery}" on server "${server.serverIdentifier}"`);
    }
  } else {
    mcpDef = catalog.byFullName?.get(toolQuery) || null;
    if (!mcpDef) {
      const matches = (catalog.tools || []).filter(
        t =>
          t.toolName === toolQuery ||
          t.toolName.toLowerCase() === toolQuery.toLowerCase() ||
          t.name.toLowerCase() === toolQuery.toLowerCase()
      );
      if (matches.length === 1) {
        mcpDef = matches[0];
      } else if (matches.length > 1) {
        throw new Error(
          `Ambiguous toolName "${toolQuery}" across servers (${matches.map(m => m.serverIdentifier).join(', ')}); pass "server"`
        );
      }
    }
    if (!mcpDef) {
      throw new Error(`Unknown MCP tool "${toolQuery}". Inspect available tools with GetMcpTools first.`);
    }
  }

  return { mcpDef, toolArgs };
}

function pickString(args, keys) {
  for (const key of keys) {
    if (typeof args[key] === 'string' && args[key].length > 0) return args[key];
  }
  return null;
}

/** Build a Cursor `ToolCall` card message for `ToolCallStartedUpdate` / `ToolCallCompletedUpdate`. */
export function renderToolCard({ callId, name, args, result = null, mcpDef = null }) {
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
  } else if (norm === 'getmcptools') {
    toolCall.getMcpToolsToolCall = {
      args: {
        ...(args.server ? { server: String(args.server) } : {}),
        ...(args.toolName ? { toolName: String(args.toolName) } : {}),
        ...(args.pattern ? { pattern: String(args.pattern) } : {}),
        toolCallId: callId,
      },
      ...(result ? { result } : {}),
    };
  } else {
    toolCall.mcpToolCall = {
      args: {
        name: mcpDef?.name || name,
        toolCallId: callId,
        toolName: mcpDef?.toolName || name,
        ...(mcpDef?.providerIdentifier ? { providerIdentifier: mcpDef.providerIdentifier } : {}),
        ...(mcpDef?.serverIdentifier ? { serverIdentifier: mcpDef.serverIdentifier } : {}),
      },
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
        serverIdentifier: mcpDef.serverIdentifier || '',
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
  const outcome = formatRawExecResult(name, args, execClientMsg, editContext);
  return {
    ...outcome,
    text: boundTextHeadTail(
      outcome.text,
      MAX_TOOL_RESULT_CHARS,
      'use narrower range/pattern or offset/limit'
    ),
  };
}

function formatRawExecResult(name, args, execClientMsg, editContext = null) {
  if (!execClientMsg) {
    return { text: 'empty exec response', isError: true, cardResult: null };
  }
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
