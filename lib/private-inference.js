import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const PRIVATE_INFERENCE_ENV_VAR = 'CURSOR_PRIVATE_INFERENCE_CONFIG';
export const PRIVATE_INFERENCE_FILENAME = 'private-inference.toml';
export const DEFAULT_TEAM_ID = 900001;
export const DEFAULT_TEAM_NAME = 'Magpie';

export const CURSOR_PRIVATE_INFERENCE_SCHEMAS = {
  Team: [
    [1, 'name', 'string'],
    [2, 'id', 'int32'],
    [3, 'role', 'enum'],
    [4, 'seats', 'int32'],
    [5, 'hasBilling', 'bool'],
    [6, 'requestQuotaPerSeat', 'int32'],
    [7, 'privacyModeForced', 'bool'],
    [8, 'allowSso', 'bool'],
    [9, 'adminOnlyUsagePricing', 'bool'],
    [10, 'subscriptionStatus', 'string'],
    [12, 'verified', 'bool'],
    [13, 'isEnterprise', 'bool'],
    [16, 'membershipType', 'string'],
    [36, 'isDirectMember', 'bool'],
    [37, 'teamSlug', 'string'],
    [38, 'privateInferenceEnablement', 'enum'],
    [40, 'privateInferenceModeSwitchAllowed', 'bool'],
    [41, 'privateInferenceAvailable', 'bool'],
    [46, 'privateInferenceBugReportsAllowed', 'bool'],
  ],
  GetTeamsRequest: [[1, 'activeOnly', 'bool', { optional: true }]],
  GetTeamsResponse: [[1, 'teams', 'message:Team', { repeated: true }]],
  RunInferenceFlagValue: [
    [1, 'boolValue', 'bool', { oneof: 'value' }],
    [2, 'numberValue', 'double', { oneof: 'value' }],
    [3, 'stringValue', 'string', { oneof: 'value' }],
  ],
  RunInferenceAskQuestionConfig: [
    [1, 'toolName', 'string'],
    [2, 'autoRejectFirst', 'bool'],
  ],
  RunInferenceAgentModeConfig: [
    [1, 'modeId', 'string'],
    [2, 'enableAskQuestionTool', 'bool'],
  ],
  RunInferencePromptModelMetadata: [
    [1, 'vendor', 'string'],
    [2, 'promptVersion', 'string'],
    [3, 'isSonnet45', 'bool'],
    [4, 'isGemini3', 'bool'],
    [5, 'isGpt51', 'bool'],
    [6, 'isGpt52', 'bool'],
    [7, 'isGpt5', 'bool'],
    [8, 'isGpt55', 'bool'],
    [9, 'isGpt56', 'bool'],
    [10, 'isSonnet4', 'bool'],
    [11, 'isCodexFamily', 'bool'],
    [12, 'isGpt54', 'bool'],
    [13, 'isGpt52Codex', 'bool'],
    [14, 'isGpt53Codex', 'bool'],
    [15, 'isGpt53CodexSpark', 'bool'],
    [16, 'isClaude4x', 'bool'],
    [17, 'isOpus45', 'bool'],
    [18, 'isOpus46', 'bool'],
    [19, 'isOpus48', 'bool'],
    [20, 'isOpus5', 'bool'],
    [23, 'isGpt5Family', 'bool'],
    [28, 'isGrok45ProductPrompt', 'bool'],
    [30, 'reasoningEffort', 'string', { optional: true }],
    [31, 'useDsv3Harness', 'bool'],
    [32, 'agentTokenLimit', 'int32', { optional: true }],
    [33, 'estimatedCacheTtlMs', 'int32', { optional: true }],
    [34, 'isGrok46ProductPrompt', 'bool'],
    [35, 'persona', 'string'],
    [36, 'featureFlags', 'map:string:message:RunInferenceFlagValue'],
    [40, 'supportsAssistantMessagePrefill', 'bool'],
    [41, 'enableLineNumbers', 'bool'],
    [42, 'useSparseReadLineNumbers', 'bool'],
    [44, 'selfIdentityName', 'string'],
    [45, 'dsv3IsThinking', 'bool', { optional: true }],
    [46, 'agentModeConfigs', 'message:RunInferenceAgentModeConfig', { repeated: true }],
    [47, 'useNewPlanModePrompts', 'bool', { optional: true }],
    [48, 'askQuestionConfig', 'message:RunInferenceAskQuestionConfig', { optional: true }],
    [50, 'isOpus55', 'bool'],
    [52, 'enableSemanticSearch', 'bool', { optional: true }],
    [54, 'smartModeClassifierMode', 'bool', { optional: true }],
    [55, 'smartModeClassifierShadowMode', 'bool', { optional: true }],
    [59, 'smartModeClassifierInvokedFiles', 'bool', { optional: true }],
  ],
};

const PRIVATE_INFERENCE_ENABLEMENT_ENABLED = 1;
const PRIVATE_INFERENCE_ENABLEMENT_DISABLED = 2;

const AGENT_MODE_IDS = ['agent', 'chat', 'plan', 'debug', 'triage', 'multitask'];

const DEFAULT_FEATURE_FLAGS = Object.freeze({
  aliasSkillCatalogPathPrefixes: { boolValue: true },
  askQuestionSystemPromptGuidance: { boolValue: true },
  cloudAgentProactiveTokenLimitError: { boolValue: true },
  compactShellDescription: { boolValue: true },
  dynamicToolProfile: { stringValue: 'final' },
  enableHookAdditionalContext: { boolValue: true },
  enablePromptMessageReadCache: { boolValue: true },
  enableSandboxSharedBuildCache: { boolValue: true },
  hideAsyncSubagentTaskNotifications: { boolValue: true },
  localAgentMarkdownImages: { boolValue: true },
  projectCoordinatorWorkerFileLinks: { boolValue: true },
  rerenderUserInfoOnSummarization: { boolValue: true },
  sendMessagePrivateAssistantText: { boolValue: true },
});

function stripProviderPrefix(modelId) {
  const raw = String(modelId || '').trim();
  const slash = raw.indexOf('/');
  const bare = slash >= 0 ? raw.slice(slash + 1) : raw;
  const at = bare.indexOf('@');
  return (at >= 0 ? bare.slice(0, at) : bare).trim();
}

function classifyModelFamily(modelName) {
  const bare = stripProviderPrefix(modelName).toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(bare)) {
    const flags = {
      vendor: 'anthropic',
      isClaude4x: true,
      supportsAssistantMessagePrefill: false,
      estimatedCacheTtlMs: 300_000,
    };
    if (/opus[-_.]?5[-_.]?5/.test(bare)) flags.isOpus55 = true;
    else if (/opus[-_.]?5/.test(bare)) flags.isOpus5 = true;
    else if (/opus[-_.]?4[-_.]?8/.test(bare)) flags.isOpus48 = true;
    else if (/opus[-_.]?4[-_.]?6/.test(bare)) flags.isOpus46 = true;
    else if (/opus[-_.]?4[-_.]?5/.test(bare)) flags.isOpus45 = true;
    else if (/sonnet[-_.]?4[-_.]?5|sonnet[-_.]?4[-_.]?6|sonnet[-_.]?5/.test(bare)) {
      flags.isSonnet45 = true;
    } else if (/sonnet[-_.]?4/.test(bare)) flags.isSonnet4 = true;
    return flags;
  }
  if (/\bgpt[-_.]|\bcodex\b|^o[134](?:[-_.]|$)/.test(bare)) {
    const flags = {
      vendor: 'openai',
      isGpt5Family: true,
      supportsAssistantMessagePrefill: false,
      estimatedCacheTtlMs: 300_000,
    };
    if (/codex/.test(bare)) flags.isCodexFamily = true;
    if (/gpt[-_.]?(?:5[-_.]?6|6)/.test(bare)) flags.isGpt56 = true;
    else if (/gpt[-_.]?5[-_.]?5/.test(bare)) flags.isGpt55 = true;
    else if (/gpt[-_.]?5[-_.]?4/.test(bare)) flags.isGpt54 = true;
    else if (/gpt[-_.]?5[-_.]?2/.test(bare)) flags.isGpt52 = true;
    else if (/gpt[-_.]?5[-_.]?1/.test(bare)) flags.isGpt51 = true;
    else flags.isGpt5 = true;
    return flags;
  }
  if (/gemini/.test(bare)) {
    return {
      vendor: 'google',
      isGemini3: true,
      supportsAssistantMessagePrefill: false,
      estimatedCacheTtlMs: 300_000,
    };
  }
  if (/grok/.test(bare)) {
    const is46Plus = /grok[-_.]?4[-_.]?[6789]|grok[-_.]?[5-9]/.test(bare);
    return {
      vendor: 'xai',
      isGrok46ProductPrompt: is46Plus,
      isGrok45ProductPrompt: !is46Plus,
      supportsAssistantMessagePrefill: false,
      estimatedCacheTtlMs: 3_600_000,
    };
  }
  return {
    vendor: 'unknown',
    supportsAssistantMessagePrefill: false,
    estimatedCacheTtlMs: 300_000,
  };
}

/** Build the synthetic `GetTeamsResponse` payload that unlocks Cursor Private Inference. */
export function buildGetTeamsData({
  enabled = false,
  teamId = DEFAULT_TEAM_ID,
  teamName = DEFAULT_TEAM_NAME,
} = {}) {
  return {
    teams: [
      {
        name: teamName,
        id: teamId,
        role: 1,
        seats: 100,
        hasBilling: true,
        subscriptionStatus: 'active',
        verified: true,
        isEnterprise: true,
        membershipType: 'enterprise',
        isDirectMember: true,
        teamSlug: 'magpie',
        privateInferenceEnablement: enabled
          ? PRIVATE_INFERENCE_ENABLEMENT_ENABLED
          : PRIVATE_INFERENCE_ENABLEMENT_DISABLED,
        privateInferenceModeSwitchAllowed: false,
        privateInferenceAvailable: Boolean(enabled),
        privateInferenceBugReportsAllowed: false,
      },
    ],
  };
}

/** Build Connect-JSON representation for `DashboardService/GetTeams`. */
export function buildGetTeamsJson(options = {}) {
  const data = buildGetTeamsData(options);
  return {
    teams: data.teams.map(team => ({
      ...team,
      privateInferenceEnablement:
        team.privateInferenceEnablement === PRIVATE_INFERENCE_ENABLEMENT_ENABLED
          ? 'PRIVATE_INFERENCE_ENABLEMENT_ENABLED'
          : 'PRIVATE_INFERENCE_ENABLEMENT_DISABLED',
    })),
  };
}

/** Build `RunInferencePromptModelMetadata` matching the requested model for local `AdmitRun`. */
export function buildPromptModelMetadata(
  modelName,
  { reasoningEffort = '', contextWindow = 0 } = {}
) {
  const family = classifyModelFamily(modelName);
  const metadata = {
    vendor: family.vendor,
    promptVersion: 'latest',
    persona: 'anonymous',
    selfIdentityName: String(modelName || 'Cursor').trim() || 'Cursor',
    enableLineNumbers: true,
    useSparseReadLineNumbers: true,
    enableSemanticSearch: true,
    smartModeClassifierMode: true,
    smartModeClassifierShadowMode: false,
    smartModeClassifierInvokedFiles: false,
    dsv3IsThinking: false,
    useDsv3Harness: false,
    useNewPlanModePrompts: false,
    supportsAssistantMessagePrefill: Boolean(family.supportsAssistantMessagePrefill),
    estimatedCacheTtlMs: family.estimatedCacheTtlMs || 300_000,
    askQuestionConfig: {
      toolName: 'AskQuestion',
      autoRejectFirst: false,
    },
    agentModeConfigs: AGENT_MODE_IDS.map(modeId => ({
      modeId,
      enableAskQuestionTool: true,
    })),
    featureFlags: { ...DEFAULT_FEATURE_FLAGS },
    ...family,
  };
  if (reasoningEffort) {
    metadata.reasoningEffort = String(reasoningEffort).trim();
  }
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
    metadata.agentTokenLimit = contextWindow;
  }
  return metadata;
}

/** Compute canonical `private-inference.toml` path for cleanup. */
export function privateInferenceConfigPath(rootDir) {
  return path.join(rootDir, PRIVATE_INFERENCE_FILENAME);
}

function defaultExecCommand(cmd, args) {
  execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 });
}

/** Clear `CURSOR_PRIVATE_INFERENCE_CONFIG` from the desktop session environment. */
export function clearPrivateInferenceEnv({ platform = process.platform, exec = defaultExecCommand } = {}) {
  try {
    if (platform === 'darwin') {
      exec('/bin/launchctl', ['unsetenv', PRIVATE_INFERENCE_ENV_VAR]);
      return true;
    }
    if (platform === 'linux') {
      exec('systemctl', ['--user', 'unset-environment', PRIVATE_INFERENCE_ENV_VAR]);
      return true;
    }
  } catch {
    // Ignore when session manager is unavailable.
  }
  return false;
}

/**
 * Determine whether OS-session env sync should run for `rootDir`.
 * Avoids mutating the real user launchd environment during isolated tests.
 */
export function shouldSyncSessionEnv(rootDir, { homeDir = os.homedir(), env = process.env } = {}) {
  if (env.CURSOR_BRIDGE_SKIP_ENV_SYNC === '1') return false;
  if (env.CURSOR_BRIDGE_FORCE_ENV_SYNC === '1') return true;
  const defaultRoot = path.join(homeDir, '.config', 'magpie-cursor-bridge');
  return path.resolve(rootDir) === path.resolve(defaultRoot);
}

/** Remove stale `<rootDir>/private-inference.toml` and unset desktop env variable. */
export function clearPrivateInferenceConfig({
  rootDir,
  syncEnv = shouldSyncSessionEnv(rootDir),
  platform = process.platform,
  exec = defaultExecCommand,
}) {
  const tomlPath = privateInferenceConfigPath(rootDir);
  let removed = false;
  try {
    if (fs.existsSync(tomlPath)) {
      fs.unlinkSync(tomlPath);
      removed = true;
    }
  } catch {
    // Ignore missing file races.
  }
  if (syncEnv) {
    clearPrivateInferenceEnv({ platform, exec });
  }
  return { path: tomlPath, removed };
}
