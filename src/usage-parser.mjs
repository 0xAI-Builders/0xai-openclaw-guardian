/**
 * Usage parser — extract token counts from provider responses.
 * Each provider uses a different shape; this centralises the logic.
 *
 * Returns { input_tokens, output_tokens, cache_read, cache_write, model?, stop_reason? }
 * or null if the body is unparseable.
 */

export function parseAnthropicNonStream(bodyStr) {
  try {
    const d = JSON.parse(bodyStr);
    const u = d.usage || {};
    return {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_write: u.cache_creation_input_tokens || 0,
      model: d.model || null,
      stop_reason: d.stop_reason || null,
    };
  } catch { return null; }
}

/**
 * Anthropic SSE emits:
 *   event: message_start  { message: { usage: { input_tokens, cache_* } } }
 *   event: message_delta  { usage: { output_tokens } }  (final)
 *   event: message_stop
 *
 * Call parseAnthropicSseEvent() per parsed `data: { ... }` payload.
 */
export function parseAnthropicSseChunk(jsonStr, acc = {}) {
  try {
    const d = JSON.parse(jsonStr);
    if (d.type === 'message_start' && d.message) {
      const u = d.message.usage || {};
      acc.input_tokens = u.input_tokens || acc.input_tokens || 0;
      acc.cache_read = u.cache_read_input_tokens || acc.cache_read || 0;
      acc.cache_write = u.cache_creation_input_tokens || acc.cache_write || 0;
      acc.model = d.message.model || acc.model;
    } else if (d.type === 'message_delta') {
      const u = d.usage || {};
      if (u.output_tokens != null) acc.output_tokens = u.output_tokens;
      if (d.delta?.stop_reason) acc.stop_reason = d.delta.stop_reason;
    }
  } catch {}
  return acc;
}

/** Extract SSE data lines from a buffered chunk; yields JSON payloads. */
export function* sseData(text) {
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const payload = line.slice(6);
      if (payload && payload !== '[DONE]') yield payload;
    }
  }
}

/** Request-side: pull model, session hints, user query and system snippet. */
export function peekRequest(bodyStr) {
  try {
    const d = JSON.parse(bodyStr);
    const out = {
      model: d.model || null,
      stream: !!d.stream,
      max_tokens: d.max_tokens || null,
      agent_id: null,
      session_id: null,
      user_query: null,
      system_snippet: null,
    };
    const meta = d.metadata;
    if (meta && typeof meta === 'object') {
      out.agent_id = meta.agent_id || meta.agentId || meta.user_id || null;
      out.session_id = meta.session_id || meta.sessionId || null;
    }
    // Last user message — the "query" the agent just received.
    if (Array.isArray(d.messages)) {
      for (let i = d.messages.length - 1; i >= 0; i--) {
        const m = d.messages[i];
        if (m?.role !== 'user') continue;
        out.user_query = flattenContent(m.content);
        break;
      }
    }
    // System prompt first line (identity hint).
    if (typeof d.system === 'string') {
      out.system_snippet = d.system.split('\n').find(l => l.trim()) || null;
    } else if (Array.isArray(d.system)) {
      for (const s of d.system) {
        if (typeof s === 'string') {
          out.system_snippet = s.split('\n').find(l => l.trim()) || null;
          break;
        }
        if (s?.text) {
          out.system_snippet = String(s.text).split('\n').find(l => l.trim()) || null;
          break;
        }
      }
    }
    return out;
  } catch { return { model: null, stream: false }; }
}

function flattenContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return null;
  // Collect text blocks, skip tool_result / image / thinking.
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) parts.push(String(c.text));
    else if (c.type === 'tool_result' && c.content) {
      if (typeof c.content === 'string') parts.push(`[tool_result] ${c.content.slice(0, 200)}`);
      else if (Array.isArray(c.content)) {
        const tr = c.content.find(x => x?.type === 'text');
        if (tr?.text) parts.push(`[tool_result] ${String(tr.text).slice(0, 200)}`);
      }
    } else if (c.type === 'tool_use') {
      parts.push(`[tool_use:${c.name || '?'}]`);
    }
  }
  return parts.join(' ').trim() || null;
}

// Cost calculation lives in pricing.mjs (noosphere-backed).
// billing-proxy imports calcCost directly; this module is parsing-only.
