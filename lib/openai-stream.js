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
  signal,
  onEvent,
}) {
  validateConfig(config);
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
        dataLines.push(rawLine.slice(5).trimStart());
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
      usage = {
        inputTokens: parsed.usage.prompt_tokens ?? null,
        outputTokens: parsed.usage.completion_tokens ?? null,
        cacheReadTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? null,
        reasoningTokens: parsed.usage.completion_tokens_details?.reasoning_tokens ?? null,
      };
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
        if (!entry) {
          entry = {
            index: idx,
            id: tc.id || `call_${idx}_${Date.now()}`,
            name: '',
            argumentsText: '',
          };
          toolAccumulator.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') {
          entry.argumentsText += tc.function.arguments;
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
      let boundaryIndex = buffer.search(/\r?\n\r?\n/);
      while (boundaryIndex !== -1) {
        const separatorMatch = /\r?\n\r?\n/.exec(buffer.slice(boundaryIndex));
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + separatorMatch[0].length);
        await processEventBlock(block);
        boundaryIndex = buffer.search(/\r?\n\r?\n/);
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
  signal,
}) {
  let collected = '';
  await streamOpenAiChat({
    config,
    modelId,
    messages,
    reasoningEffort,
    signal,
    onEvent: event => {
      if (event.type === 'text_delta') {
        collected += event.text;
      }
    },
  });
  return collected;
}
