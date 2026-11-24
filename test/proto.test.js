import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeConnectFrames,
  decodeCursor,
  encodeConnectEndStream,
  encodeConnectFrame,
  encodeCursor,
} from '../lib/cursor-schemas.js';
import { fromProtoValue, toProtoValue } from '../lib/proto-wire.js';

test('AvailableModelsAddition hides Auto using exact Cursor wire bytes', () => {
  const bytes = encodeCursor('AvailableModelsAddition', {
    displayConfiguration: {
      routedModelViewConfig: { hideRoutedModelView: true },
      namedModelsViewConfig: { namedViewToRoutedModelViewNoButton: {} },
    },
  });
  assert.deepEqual(Array.from(bytes), [0x7a, 8, 0x0a, 2, 0x28, 1, 0x12, 2, 0x1a, 0]);
  const decoded = decodeCursor('AvailableModelsAddition', bytes);
  assert.equal(decoded.displayConfiguration.routedModelViewConfig.hideRoutedModelView, true);
  assert.ok(decoded.displayConfiguration.namedModelsViewConfig.namedViewToRoutedModelViewNoButton);
});

test('AvailableModelsAddition Auto toggle configuration and InteractionUpdate.routedModel round-trip', () => {
  const bytes = encodeCursor('AvailableModelsAddition', {
    displayConfiguration: {
      routedModelViewConfig: {
        routedModelViewToNamedViewToggle: {
          titleMarkdown: 'Auto',
          subtitle: 'Balanced quality and speed, recommended for most tasks',
          setToLastNamedModel: true,
        },
        hideSearchBar: false,
      },
      namedModelsViewConfig: {
        namedViewToRoutedModelViewToggle: { markdown: 'Auto' },
      },
    },
  });
  const decoded = decodeCursor('AvailableModelsAddition', bytes);
  assert.equal(
    decoded.displayConfiguration.routedModelViewConfig.routedModelViewToNamedViewToggle.titleMarkdown,
    'Auto'
  );
  assert.equal(
    decoded.displayConfiguration.routedModelViewConfig.routedModelViewToNamedViewToggle.setToLastNamedModel,
    true
  );
  assert.equal(
    decoded.displayConfiguration.namedModelsViewConfig.namedViewToRoutedModelViewToggle.markdown,
    'Auto'
  );

  const routedFrame = encodeCursor('AgentServerMessage', {
    interactionUpdate: {
      routedModel: { displayName: 'Claude Opus · anthropic/claude-opus' },
    },
  });
  const decodedSrv = decodeCursor('AgentServerMessage', routedFrame);
  assert.equal(decodedSrv.interactionUpdate.routedModel.displayName, 'Claude Opus · anthropic/claude-opus');
});

test('AgentClientMessage, AgentServerMessage, and BidiAppendRequest round-trip cleanly', () => {
  const clientMsg = {
    runRequest: {
      conversationId: 'conv-1',
      runId: 'run-1',
      requestedModel: { modelId: 'deepseek/deepseek-chat', maxMode: false },
      action: {
        userMessageAction: {
          userMessage: { text: 'hello bridge', messageId: 'msg-1', mode: 1 },
        },
      },
    },
  };
  const rawClient = encodeCursor('AgentClientMessage', clientMsg);
  const appendReq = encodeCursor('BidiAppendRequest', {
    data: rawClient.toString('hex'),
    requestId: { requestId: 'req-1' },
    appendSeqno: 0,
  });
  const decodedAppend = decodeCursor('BidiAppendRequest', appendReq);
  assert.equal(decodedAppend.requestId.requestId, 'req-1');
  assert.equal(decodedAppend.appendSeqno, 0);
  const decodedClient = decodeCursor('AgentClientMessage', Buffer.from(decodedAppend.data, 'hex'));
  assert.equal(decodedClient.runRequest.action.userMessageAction.userMessage.text, 'hello bridge');

  const serverMsg = encodeCursor('AgentServerMessage', {
    interactionUpdate: { textDelta: { text: 'MAGPIE_OK', isServerNotice: false } },
  });
  const framed = Buffer.concat([encodeConnectFrame(serverMsg), encodeConnectEndStream()]);
  const { frames, remaining } = decodeConnectFrames(framed);
  assert.equal(remaining.length, 0);
  assert.equal(frames.length, 2);
  assert.equal(
    decodeCursor('AgentServerMessage', frames[0].payload).interactionUpdate.textDelta.text,
    'MAGPIE_OK'
  );
  assert.deepEqual(JSON.parse(frames[1].payload.toString('utf8')), {});
});

test('toProtoValue and fromProtoValue round-trip nested JSON structs', () => {
  const sample = { path: 'a.ts', count: 3, dryRun: true, tags: ['x', 'y'], meta: { nested: null } };
  const roundTripped = fromProtoValue(toProtoValue(sample));
  assert.deepEqual(roundTripped, sample);
});

test('AvailableModelsAddition subagentModelConfigs map and role auxiliary messages round-trip', () => {
  const catalogBytes = encodeCursor('AvailableModelsAddition', {
    availableModels: [{ modelId: 'group/auto', displayName: 'Auto' }],
    subagentModelConfigs: {
      explore: { defaultModel: 'magpie/flash', fallbackModels: ['magpie/mini'] },
      shell: { defaultModel: 'magpie/fast' },
    },
  });
  const decodedCatalog = decodeCursor('AvailableModelsAddition', catalogBytes);
  assert.equal(decodedCatalog.subagentModelConfigs.explore.defaultModel, 'magpie/flash');
  assert.deepEqual(decodedCatalog.subagentModelConfigs.explore.fallbackModels, ['magpie/mini']);
  assert.equal(decodedCatalog.subagentModelConfigs.shell.defaultModel, 'magpie/fast');

  const bugBytes = encodeCursor('StreamBugBotResponse', {
    bugReports: {
      bugReports: [
        {
          description: 'Null pointer risk',
          confidence: 0.9,
          locations: [{ file: 'src/index.ts', startLine: 10, endLine: 14, codeLines: ['if (x)'] }],
        },
      ],
    },
  });
  const decodedBug = decodeCursor('StreamBugBotResponse', bugBytes);
  assert.equal(decodedBug.bugReports.bugReports[0].description, 'Null pointer risk');
  assert.equal(decodedBug.bugReports.bugReports[0].locations[0].file, 'src/index.ts');

  const nameBytes = encodeCursor('NameAgentRequest', {
    userMessage: 'Refactor router',
  });
  assert.equal(decodeCursor('NameAgentRequest', nameBytes).userMessage, 'Refactor router');

  const memBytes = encodeCursor('PotentiallyGenerateMemoryResponse', {
    savedMemory: 'Use strict mode',
    knowledgeId: 'kid-1',
    title: 'Prefers TypeScript',
  });
  const decodedMem = decodeCursor('PotentiallyGenerateMemoryResponse', memBytes);
  assert.equal(decodedMem.savedMemory, 'Use strict mode');
  assert.equal(decodedMem.knowledgeId, 'kid-1');
  assert.equal(decodedMem.title, 'Prefers TypeScript');
});

test('decodeMessage rejects oversized or truncated length-delimited varints', () => {
  // Field 1 (wireType 2 -> tag 0x0a), length = 2^64 - 1 (10 bytes varint)
  const hugeLen = Buffer.from([
    0x0a,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
  ]);
  assert.throws(() => decodeCursor('BidiRequestId', hugeLen), /exceeds safe bounds|Truncated/);

  // Field 1 (wireType 2 -> tag 0x0a), length = 2^32 (exceeds buffer length)
  const overflowLen = Buffer.from([0x0a, 0x80, 0x80, 0x80, 0x80, 0x10]);
  assert.throws(() => decodeCursor('BidiRequestId', overflowLen), /Truncated length-delimited/);
});

test('progressive-disclosure RunRequest, McpMetaToolOptions, SkillOptions, and GetMcpToolsToolCall round-trip', () => {
  const runBytes = encodeCursor('AgentRunRequest', {
    conversationId: 'conv-pd',
    excludeWorkspaceContext: true,
    systemPromptSpec: { append: 'Keep concise' },
    skillOptions: {
      skillDescriptors: [
        {
          name: 'demo',
          description: 'Demo skill',
          folderPath: '/tmp/.agents/skills/demo',
          enabled: true,
          readmeFilePath: '/tmp/.agents/skills/demo/SKILL.md',
        },
      ],
    },
    action: {
      userMessageAction: {
        userMessage: {
          text: '',
          textBlobId: Buffer.from('blob-text-1'),
          messageId: 'm-1',
          mode: 1,
          selectedContext: {
            cursorRules: [{ rule: { fullPath: '/tmp/ws/.cursor/rules/manual.mdc', content: 'Manual body' } }],
          },
        },
        requestContext: {
          mcpMetaToolOptions: {
            enabled: true,
            mcpDescriptors: [
              {
                serverName: 'Playwright',
                serverIdentifier: 'playwright',
                tools: [{ toolName: 'browser_navigate', description: 'Navigate' }],
              },
            ],
          },
        },
      },
    },
  });
  const decodedRun = decodeCursor('AgentRunRequest', runBytes);
  assert.equal(decodedRun.excludeWorkspaceContext, true);
  assert.equal(decodedRun.systemPromptSpec.append, 'Keep concise');
  assert.equal(decodedRun.skillOptions.skillDescriptors[0].readmeFilePath, '/tmp/.agents/skills/demo/SKILL.md');
  assert.equal(
    Buffer.from(decodedRun.action.userMessageAction.userMessage.textBlobId).toString('utf8'),
    'blob-text-1'
  );
  assert.equal(
    decodedRun.action.userMessageAction.userMessage.selectedContext.cursorRules[0].rule.content,
    'Manual body'
  );
  assert.equal(
    decodedRun.action.userMessageAction.requestContext.mcpMetaToolOptions.mcpDescriptors[0].serverIdentifier,
    'playwright'
  );

  const cardBytes = encodeCursor('AgentServerMessage', {
    interactionUpdate: {
      toolCallCompleted: {
        callId: 'tc-1',
        modelCallId: 'mc-1',
        toolCall: {
          toolCallId: 'tc-1',
          getMcpToolsToolCall: {
            args: { server: 'playwright', toolCallId: 'tc-1' },
            result: { success: { content: '[{"toolName":"browser_navigate"}]' } },
          },
        },
      },
    },
  });
  const decodedCard = decodeCursor('AgentServerMessage', cardBytes);
  assert.equal(decodedCard.interactionUpdate.toolCallCompleted.toolCall.getMcpToolsToolCall.args.server, 'playwright');
  assert.equal(
    decodedCard.interactionUpdate.toolCallCompleted.toolCall.getMcpToolsToolCall.result.success.content,
    '[{"toolName":"browser_navigate"}]'
  );

  const resumeBytes = encodeCursor('AgentRunRequest', {
    action: {
      resumeAction: {
        requestContext: {
          gitRepos: [{ path: '/tmp/repo', branchName: 'main' }],
        },
      },
    },
  });
  const decodedResume = decodeCursor('AgentRunRequest', resumeBytes);
  assert.equal(decodedResume.action.resumeAction.requestContext.gitRepos[0].path, '/tmp/repo');
});
