/**
 * Multi-provider pass-through proxy + usage extraction.
 *
 * Each provider has its own:
 *  - upstream host / protocol
 *  - response shape (where tokens live, streaming format)
 *  - pricing table (per million tokens; zero for local)
 *
 * This module exports a `handleProviderRequest(provider, req, res, ctx)`
 * function used by billing-proxy.mjs when the URL starts with /openai,
 * /google, /openrouter, /ollama, /huggingface.
 */
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

// --- Provider registry -----------------------------------------------------
export const PROVIDERS = {
  openai:     { host: 'api.openai.com',                 port: 443, protocol: 'https', transport: https },
  openrouter: { host: 'openrouter.ai',                  port: 443, protocol: 'https', transport: https },
  google:     { host: 'generativelanguage.googleapis.com', port: 443, protocol: 'https', transport: https },
  huggingface:{ host: 'api-inference.huggingface.co',   port: 443, protocol: 'https', transport: https },
  groq:       { host: 'api.groq.com',                   port: 443, protocol: 'https', transport: https },
  cerebras:   { host: 'api.cerebras.ai',                port: 443, protocol: 'https', transport: https },
  xai:        { host: 'api.x.ai',                       port: 443, protocol: 'https', transport: https },
  ollama:     { host: '127.0.0.1',                      port: 11434, protocol: 'http', transport: http, local: true },
};

// --- Pricing tables (USD per million tokens) -------------------------------
// Intentionally minimal — noosphere has the full catalog; we just cover the
// most common models so the dashboard shows real $ instead of 0. Ollama and
// local providers are priced at 0 by design.
export const PRICING = Object.freeze({
  // OpenAI
  'gpt-4o':               { input: 2.5,  output: 10 },
  'gpt-4o-mini':          { input: 0.15, output: 0.6 },
  'gpt-4.1':              { input: 2.0,  output: 8 },
  'gpt-4.1-mini':         { input: 0.4,  output: 1.6 },
  'gpt-5':                { input: 1.25, output: 10 },
  'gpt-5-mini':           { input: 0.25, output: 2 },
  'o1':                   { input: 15,   output: 60 },
  'o3':                   { input: 10,   output: 40 },
  'o3-mini':              { input: 1.1,  output: 4.4 },
  // Google
  'gemini-2.5-pro':       { input: 1.25, output: 10 },
  'gemini-2.5-flash':     { input: 0.075,output: 0.3 },
  'gemini-3.1-pro':       { input: 2.0,  output: 8 },
  'gemini-3.1-pro-preview':{input: 2.0,  output: 8 },
  // Anthropic already handled in usage-parser.mjs ANTHROPIC_PRICING
  // Groq / Cerebras / OpenRouter — passthrough, rely on pricing table fallback
  'llama-3.3-70b':        { input: 0.59, output: 0.79 },
  'llama-3.1-8b':         { input: 0.05, output: 0.08 },
  'mixtral-8x7b':         { input: 0.24, output: 0.24 },
  // xAI
  'grok-4':               { input: 5,    output: 15 },
  'grok-3':               { input: 3,    output: 15 },
});

export function priceFor(provider, model) {
  if (provider === 'ollama') return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!model) return null;
  return PRICING[model] || PRICING[model.toLowerCase()] || null;
}

// --- Usage parsing per provider --------------------------------------------
/**
 * Non-streaming body → usage.
 * Returns {input_tokens, output_tokens, cache_read, cache_write, model}.
 */
export function parseUsageNonStream(provider, bodyStr) {
  try {
    const d = JSON.parse(bodyStr);
    const m = d.model || null;
    switch (provider) {
      case 'openai':
      case 'openrouter':
      case 'groq':
      case 'cerebras':
      case 'xai': {
        const u = d.usage || {};
        return {
          input_tokens: u.prompt_tokens || 0,
          output_tokens: u.completion_tokens || 0,
          cache_read: u.prompt_tokens_details?.cached_tokens || 0,
          cache_write: 0,
          model: m,
        };
      }
      case 'google': {
        const u = d.usageMetadata || {};
        return {
          input_tokens: u.promptTokenCount || 0,
          output_tokens: u.candidatesTokenCount || 0,
          cache_read: u.cachedContentTokenCount || 0,
          cache_write: 0,
          model: m,
        };
      }
      case 'ollama': {
        return {
          input_tokens: d.prompt_eval_count || 0,
          output_tokens: d.eval_count || 0,
          cache_read: 0,
          cache_write: 0,
          model: m || d.model || null,
        };
      }
      case 'huggingface':
      default:
        return { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, model: m };
    }
  } catch { return null; }
}

/**
 * Stream chunk → accumulate usage into `acc`.
 * Each chunk handler parses one data payload (line after `data: ` for SSE or
 * one JSON line for NDJSON ollama).
 */
export function parseUsageStreamChunk(provider, payload, acc) {
  try {
    const d = JSON.parse(payload);
    switch (provider) {
      case 'openai':
      case 'openrouter':
      case 'groq':
      case 'cerebras':
      case 'xai': {
        // OpenAI streaming only emits usage on last chunk when stream_options.include_usage=true
        if (d.usage) {
          acc.input_tokens = d.usage.prompt_tokens || acc.input_tokens || 0;
          acc.output_tokens = d.usage.completion_tokens || acc.output_tokens || 0;
          acc.cache_read = d.usage.prompt_tokens_details?.cached_tokens || acc.cache_read || 0;
        }
        if (d.model) acc.model = d.model;
        break;
      }
      case 'google': {
        // Gemini emits usageMetadata on the final chunk.
        if (d.usageMetadata) {
          const u = d.usageMetadata;
          acc.input_tokens = u.promptTokenCount || acc.input_tokens || 0;
          acc.output_tokens = u.candidatesTokenCount || acc.output_tokens || 0;
          acc.cache_read = u.cachedContentTokenCount || acc.cache_read || 0;
        }
        if (d.modelVersion && !acc.model) acc.model = d.modelVersion;
        break;
      }
      case 'ollama': {
        if (d.done) {
          acc.input_tokens = d.prompt_eval_count || acc.input_tokens || 0;
          acc.output_tokens = d.eval_count || acc.output_tokens || 0;
        }
        if (d.model) acc.model = d.model;
        break;
      }
    }
  } catch {}
  return acc;
}

// --- Request peek (model + query) — uniform across providers ---------------
export function peekProviderRequest(provider, bodyStr) {
  try {
    const d = JSON.parse(bodyStr);
    const out = { model: d.model || null, stream: !!d.stream, user_query: null, system_snippet: null };
    // OpenAI/OR/Groq/xAI: messages=[{role,content}], last user
    if (Array.isArray(d.messages)) {
      for (let i = d.messages.length - 1; i >= 0; i--) {
        if (d.messages[i]?.role === 'user') {
          out.user_query = flattenMessage(d.messages[i].content);
          break;
        }
      }
      const sys = d.messages.find(m => m?.role === 'system');
      if (sys) out.system_snippet = flattenMessage(sys.content)?.slice(0, 500) || null;
    }
    // Gemini: contents=[{role:'user'|'model', parts:[{text}]}]
    if (Array.isArray(d.contents)) {
      for (let i = d.contents.length - 1; i >= 0; i--) {
        const c = d.contents[i];
        if (c?.role !== 'model' && Array.isArray(c?.parts)) {
          const t = c.parts.map(p => p.text).filter(Boolean).join(' ').trim();
          if (t) { out.user_query = t; break; }
        }
      }
      if (d.systemInstruction?.parts) {
        out.system_snippet = d.systemInstruction.parts.map(p => p.text).filter(Boolean).join(' ').slice(0, 500);
      }
    }
    // Ollama /api/chat: messages same as OpenAI; /api/generate: prompt field
    if (d.prompt && !out.user_query) out.user_query = String(d.prompt).slice(0, 2000);
    return out;
  } catch { return { model: null, stream: false, user_query: null, system_snippet: null }; }
}

function flattenMessage(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return null;
  return content
    .map(c => (typeof c === 'string' ? c : c?.text || ''))
    .filter(Boolean).join(' ').trim() || null;
}

// --- Generic pass-through handler ------------------------------------------
/**
 * Forwards an inbound request to the upstream provider.
 * Auth strategy: pass through whatever Authorization / x-api-key / x-goog-*
 * headers the client sent. This keeps the proxy credential-free.
 *
 * opts:
 *   - providerKey: string (matches PROVIDERS)
 *   - subPath: string, the path after /providerKey (e.g. "/v1/chat/completions")
 *   - logger: console-like object for warnings
 *   - onDone: ({ model, usage, status, latencyMs, requestBytes, responseBytes, isStream }) => void
 */
export function forwardToProvider({ providerKey, subPath, req, res, body, logger, onDone }) {
  const provider = PROVIDERS[providerKey];
  if (!provider) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown provider ${providerKey}` }));
    return;
  }

  const startedAt = Date.now();
  const bodyStr = body.toString('utf8');
  const requestBytes = body.length;

  // Headers: remove hop-by-hop and inbound auth we can forward intact
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
    headers[k] = v;
  }
  headers.host = provider.host;
  headers['content-length'] = requestBytes;
  headers['accept-encoding'] = 'identity';

  const upstream = provider.transport.request({
    hostname: provider.host,
    port: provider.port,
    path: subPath,
    method: req.method,
    headers,
  }, (upRes) => {
    const ct = upRes.headers['content-type'] || '';
    const isSSE = ct.includes('text/event-stream');
    const isNDJSON = providerKey === 'ollama' && ct.includes('application/');

    if (isSSE || isNDJSON) {
      // Stream pass-through + accumulate usage.
      const nextHeaders = { ...upRes.headers };
      delete nextHeaders['content-length'];
      delete nextHeaders['transfer-encoding'];
      res.writeHead(upRes.statusCode || 200, nextHeaders);

      const decoder = new StringDecoder('utf8');
      let pending = '';
      const acc = {};
      let respBytes = 0;

      upRes.on('data', (chunk) => {
        respBytes += chunk.length;
        res.write(chunk);
        pending += decoder.write(chunk);
        if (isSSE) {
          let idx;
          while ((idx = pending.indexOf('\n\n')) !== -1) {
            const event = pending.slice(0, idx + 2);
            pending = pending.slice(idx + 2);
            for (const line of event.split('\n')) {
              if (line.startsWith('data: ')) {
                const payload = line.slice(6).trim();
                if (payload && payload !== '[DONE]') parseUsageStreamChunk(providerKey, payload, acc);
              }
            }
          }
        } else {
          // NDJSON (ollama): each line is a JSON object
          let nl;
          while ((nl = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, nl).trim();
            pending = pending.slice(nl + 1);
            if (line) parseUsageStreamChunk(providerKey, line, acc);
          }
        }
      });

      upRes.on('end', () => {
        pending += decoder.end();
        if (pending.trim()) {
          if (isSSE) {
            for (const line of pending.split('\n')) {
              if (line.startsWith('data: ')) {
                const payload = line.slice(6).trim();
                if (payload && payload !== '[DONE]') parseUsageStreamChunk(providerKey, payload, acc);
              }
            }
          } else {
            parseUsageStreamChunk(providerKey, pending.trim(), acc);
          }
        }
        res.end();
        onDone?.({
          model: acc.model, usage: acc, status: upRes.statusCode || 200,
          latencyMs: Date.now() - startedAt, requestBytes, responseBytes: respBytes,
          isStream: true, requestId: upRes.headers['x-request-id'] || upRes.headers['request-id'] || null,
        });
      });
      return;
    }

    // Non-streaming — buffer and parse once
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', () => {
      const respBody = Buffer.concat(chunks).toString();
      const nextHeaders = { ...upRes.headers };
      delete nextHeaders['transfer-encoding'];
      nextHeaders['content-length'] = Buffer.byteLength(respBody);
      res.writeHead(upRes.statusCode || 200, nextHeaders);
      res.end(respBody);
      const usage = parseUsageNonStream(providerKey, respBody) || {};
      onDone?.({
        model: usage.model, usage, status: upRes.statusCode || 200,
        latencyMs: Date.now() - startedAt, requestBytes, responseBytes: Buffer.byteLength(respBody),
        isStream: false, requestId: upRes.headers['x-request-id'] || upRes.headers['request-id'] || null,
      });
    });
  });

  upstream.on('error', (err) => {
    logger?.warn?.(`[${providerKey}] upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_error', message: err.message, provider: providerKey }));
    }
  });

  upstream.write(body);
  upstream.end();
}
