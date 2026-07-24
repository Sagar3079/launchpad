/**
 * Minimal Kiro API client (native protocol).
 *
 * Kiro (kiro.dev) ksk_ API keys authenticate against the CodeWhisperer
 * streaming service. There is no public OpenAI/Anthropic-compatible HTTP
 * endpoint, so we speak the native protocol:
 *   POST https://q.us-east-1.amazonaws.com/
 *   Authorization: Bearer <ksk_...>, tokentype: API_KEY,
 *   X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
 * The response is an AWS event stream; JSON events ({"content": "..."}) are
 * embedded in the binary framing, so we pattern-scan the decoded text —
 * same approach as the MIT-licensed pi-kiro / kiro-gateway clients.
 *
 * Exposes: generateText({ system, user, model, apiKey }) -> { text } | throws.
 */

'use strict';

const crypto = require('crypto');

const KIRO_ENDPOINT = 'https://q.us-east-1.amazonaws.com/';
const REQUEST_TIMEOUT_MS = 120_000;

/** Wire-format model ids accepted by Kiro (dot form). */
const KIRO_WIRE_MODELS = new Set([
  'auto',
  'claude-haiku-4.5',
  'claude-sonnet-4',
  'claude-sonnet-4.5',
  'claude-sonnet-4.6',
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.7',
  'claude-opus-4.8',
  'deepseek-3.2',
  'qwen3-coder-next',
]);

/**
 * Normalize a model id ("kiro/claude-haiku-4.5" or "claude-haiku-4-5")
 * to Kiro wire form ("claude-haiku-4.5"). Throws on unknown ids.
 * @param {string} modelId
 * @returns {string}
 */
function resolveKiroModel(modelId) {
  const bare = String(modelId || '').replace(/^kiro\//, '');
  const wire = bare.replace(/(\d)-(\d)/g, '$1.$2');
  if (!KIRO_WIRE_MODELS.has(wire)) {
    throw new Error(`Unknown Kiro model id: ${modelId}`);
  }
  return wire;
}

/** Find the matching `}` for the `{` at `start`; -1 if incomplete. */
function findJsonEnd(text, start) {
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }
  return -1;
}

/** JSON prefixes that start a Kiro event we care about. */
const EVENT_PATTERNS = ['{"content":', '{"error":', '{"Error":', '{"message":'];

function findNextEventStart(buffer, from) {
  let earliest = -1;
  for (const pattern of EVENT_PATTERNS) {
    const idx = buffer.indexOf(pattern, from);
    if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

/**
 * Extract content/error events from a decoded stream chunk buffer.
 * @param {string} buffer
 * @returns {{content: string, error: string|null, remaining: string}}
 */
function drainEvents(buffer) {
  let content = '';
  let error = null;
  let pos = 0;

  while (pos < buffer.length) {
    const jsonStart = findNextEventStart(buffer, pos);
    if (jsonStart < 0) break;
    const jsonEnd = findJsonEnd(buffer, jsonStart);
    if (jsonEnd < 0) {
      return { content, error, remaining: buffer.substring(jsonStart) };
    }
    try {
      const parsed = JSON.parse(buffer.substring(jsonStart, jsonEnd + 1));
      if (typeof parsed.content === 'string') {
        content += parsed.content;
      } else if (parsed.error !== undefined || parsed.Error !== undefined) {
        const err = parsed.error || parsed.Error;
        error = typeof err === 'string' ? err : JSON.stringify(err);
        if (parsed.message) error += `: ${parsed.message}`;
      }
    } catch (_e) {
      /* brace-balanced but not JSON — framing noise, skip */
    }
    pos = jsonEnd + 1;
  }
  return { content, error, remaining: '' };
}

/**
 * One-shot text generation against Kiro.
 * @param {{system?: string, user: string, model?: string, apiKey: string}} opts
 * @returns {Promise<{text: string, model: string}>}
 */
async function generateText(opts) {
  const { system, user, model, apiKey } = opts || {};
  if (!apiKey) throw new Error('KIRO_API_KEY not set');
  if (!user || typeof user !== 'string') throw new Error('user prompt required');

  const wireModel = resolveKiroModel(model || 'claude-haiku-4.5');
  const content = system ? `${system}\n\n${user}` : user;

  const request = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      agentTaskType: 'vibe',
      conversationId: crypto.randomUUID(),
      currentMessage: {
        userInputMessage: {
          content,
          modelId: wireModel,
          origin: 'AI_EDITOR',
        },
      },
    },
    agentMode: 'vibe',
  };

  const mid = crypto.randomUUID().replace(/-/g, '');
  const ua = `aws-sdk-rust/1.0.0 ua/2.1 os/other lang/rust api/codewhispererstreaming#1.28.3 m/E app/AmazonQ-For-CLI md/appVersion-1.28.3-${mid}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(KIRO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.0',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        tokentype: 'API_KEY',
        'X-Amz-Target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
        'x-amzn-codewhisperer-optout': 'true',
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': ua,
        'user-agent': ua,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      let errText = '';
      try { errText = await response.text(); } catch { /* ignore */ }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Kiro API key rejected (${response.status}) — check KIRO_API_KEY`);
      }
      throw new Error(`Kiro API error ${response.status}: ${errText.slice(0, 300)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let streamError = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { content: chunk, error, remaining } = drainEvents(buffer);
      text += chunk;
      if (error && !streamError) streamError = error;
      buffer = remaining;
    }
    buffer += decoder.decode();
    const tail = drainEvents(buffer);
    text += tail.content;
    if (tail.error && !streamError) streamError = tail.error;

    if (!text && streamError) {
      throw new Error(`Kiro stream error: ${streamError}`);
    }
    return { text, model: wireModel };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateText, resolveKiroModel, KIRO_WIRE_MODELS };
