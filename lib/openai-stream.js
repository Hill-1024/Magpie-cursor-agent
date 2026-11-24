import { validateConfig } from './config.js';

const USER_AGENT = 'cursor-magpie-bridge/0.4.0';

function chatCompletionsEndpoint(gatewayUrl) {
  const base = gatewayUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/**
 * Stream an OpenAI-compatible `/chat/completions` request against the validated
 * loopback Magpie gateway and invoke `onEvent` for text, thinking, tool calls, and usage.
 */
export async function streamOpenAiChat({
  config,
  modelId,
  messages,
  tools = [],
  reasoningEffort = null,
  serviceTier = null,
  signal,
  onEvent,
}) {
  validateConfig(config, { fallbackMissingModel: true });
  const endpoint = chatCompletionsEndpoint(config.gateway);
  const body = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length > 0) {
    body.tools = tools;
  }
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }
  if (serviceTier) {
    body.service_tier = serviceTier;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.key}`,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(body),
    signal,
    redirect: 'error',
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Magpie gateway HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }
  if (!response.body) {
    throw new Error('Magpie gateway returned an empty stream body');
  }

  const decoder = new TextDecoder();
  const toolAccumulator = new Map();
  let buffer = '';
  let finishReason = null;
  let usage = null;

  const processEventBlock = async block => {
    const dataLines = [];
    for (const rawLine of block.split(/\r?\n/)) {
      if (rawLine.startsWith('data:')) {
        dataLines.push(rawLine.startsWith('data: ') ? rawLine.slice(6) : rawLine.slice(5));
      }
    }
    if (dataLines.length === 0) return;
    const payloadText = dataLines.join('\n').trim();
    if (!payloadText || payloadText === '[DONE]') return;

    let parsed;
    try {
      parsed = JSON.parse(payloadText);
    } catch {
      return;
    }
    if (parsed.error) {
      const msg = parsed.error.message || JSON.stringify(parsed.error);
      throw new Error(`Gateway stream error: ${msg}`);
    }
    if (parsed.usage) {
      const nextInput = parsed.usage.prompt_tokens;
      const nextOutput = parsed.usage.completion_tokens;
      const nextCacheRead = parsed.usage.prompt_tokens_details?.cached_tokens;
      const nextReasoning = parsed.usage.completion_tokens_details?.reasoning_tokens;
      const hasNumericUsage = [nextInput, nextOutput, nextCacheRead, nextReasoning].some(
        val => typeof val === 'number' && Number.isFinite(val)
      );
      if (hasNumericUsage) {
        usage = {
          inputTokens: typeof nextInput === 'number' && Number.isFinite(nextInput) ? nextInput : (usage?.inputTokens ?? null),
          outputTokens: typeof nextOutput === 'number' && Number.isFinite(nextOutput) ? nextOutput : (usage?.outputTokens ?? null),
          cacheReadTokens:
            typeof nextCacheRead === 'number' && Number.isFinite(nextCacheRead)
              ? nextCacheRead
              : (usage?.cacheReadTokens ?? null),
          reasoningTokens:
            typeof nextReasoning === 'number' && Number.isFinite(nextReasoning)
              ? nextReasoning
              : (usage?.reasoningTokens ?? null),
        };
      }
    }
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (!delta) return;

    const thinkingText = delta.reasoning_content ?? delta.reasoning;
    if (typeof thinkingText === 'string' && thinkingText.length > 0) {
      await onEvent({ type: 'thinking_delta', text: thinkingText });
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      await onEvent({ type: 'text_delta', text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = Number.isInteger(tc.index) ? tc.index : 0;
        let entry = toolAccumulator.get(idx);
        const isNew = !entry;
        if (!entry) {
          entry = {
            index: idx,
            id: tc.id || `call_${idx}_${Date.now()}`,
            name: '',
            argumentsText: '',
            started: false,
          };
          toolAccumulator.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (!entry.started && entry.name) {
          entry.started = true;
          await onEvent({ type: 'tool_call_start', index: idx, id: entry.id, name: entry.name });
        }
        if (typeof tc.function?.arguments === 'string') {
          entry.argumentsText += tc.function.arguments;
          if (entry.started && tc.function.arguments.length > 0) {
            await onEvent({
              type: 'tool_call_delta',
              index: idx,
              id: entry.id,
              argsDelta: tc.function.arguments,
            });
          }
        } else if (isNew && entry.started && entry.argumentsText.length > 0) {
          await onEvent({
            type: 'tool_call_delta',
            index: idx,
            id: entry.id,
            argsDelta: entry.argumentsText,
          });
        }
      }
    }
  };

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sepMatch;
      while ((sepMatch = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const block = buffer.slice(0, sepMatch.index);
        buffer = buffer.slice(sepMatch.index + sepMatch[0].length);
        await processEventBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      await processEventBlock(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = Array.from(toolAccumulator.values()).sort((left, right) => left.index - right.index);
  return { toolCalls, finishReason, usage };
}

/** Execute a streaming OpenAI chat completion and collect full response text. */
export async function completeOpenAiText({
  config,
  modelId,
  messages,
  reasoningEffort = null,
  serviceTier = null,
  signal,
}) {
  let collected = '';
  await streamOpenAiChat({
    config,
    modelId,
    messages,
    reasoningEffort,
    serviceTier,
    signal,
    onEvent: event => {
      if (event.type === 'text_delta') {
        collected += event.text;
      }
    },
  });
  return collected;
}
