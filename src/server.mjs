#!/usr/bin/env node
/**
 * OpenClaw Observability Dashboard Server
 *
 * Reads OpenClaw session JSONL files, calculates real API costs,
 * and serves a Tailwind CSS dashboard with Spend / Settings / Security tabs.
 *
 * Configuration (env vars):
 *   OPENCLAW_DIR  - path to .openclaw directory     (default: ~/.openclaw)
 *   OBS_PORT      - HTTP server port                (default: 3847)
 *   OBS_HOST      - bind address                    (default: 0.0.0.0)
 *   All providers metered — subscription and API costs are always tracked.
 *   TZ            - timezone for dashboard display   (default: America/Mexico_City)
 */

import { createServer } from 'node:http';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { initPricing, calcCost, AVAILABLE_MODELS } from './pricing.mjs';
import { createBillingProxyManager } from './billing-proxy.mjs';

// ---------------------------------------------------------------------------
// Configuration — all paths derived from OPENCLAW_DIR
// ---------------------------------------------------------------------------
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(homedir(), '.openclaw');
const PORT         = parseInt(process.env.OBS_PORT || '3847', 10);
const HOST         = process.env.OBS_HOST || '0.0.0.0';
const AGENTS_DIR   = join(OPENCLAW_DIR, 'agents');
const CONFIG_FILE  = join(OPENCLAW_DIR, 'openclaw.json');
const LIMITS_FILE  = process.env.OBS_LIMITS_FILE || join(OPENCLAW_DIR, 'observability', 'limits.json');
const __dirname    = dirname(fileURLToPath(import.meta.url));

console.log(`[observability] OPENCLAW_DIR = ${OPENCLAW_DIR}`);
console.log(`[observability] AGENTS_DIR   = ${AGENTS_DIR}`);

// ---------------------------------------------------------------------------
// Initialize pricing engine
// ---------------------------------------------------------------------------
await initPricing();

// ---------------------------------------------------------------------------
// Billing proxy manager
// ---------------------------------------------------------------------------
const billingProxy = createBillingProxyManager({
  openclawDir: OPENCLAW_DIR,
  logger: console,
});

try {
  const proxyConfig = billingProxy.loadConfig();
  if (proxyConfig.autoStart) {
    billingProxy.start().catch((error) => {
      console.log('[observability] billing proxy start skipped:', error.message);
    });
  }
} catch (error) {
  console.log('[observability] billing proxy config unavailable:', error.message);
}

// ---------------------------------------------------------------------------
// Resolve gateway token (for cron list auth)
// ---------------------------------------------------------------------------
function resolveGatewayToken() {
  const resolveScript = join(OPENCLAW_DIR, 'resolve-secret.sh');
  if (!existsSync(resolveScript)) return '';
  try {
    return execSync(`"${resolveScript}" GATEWAY_AUTH_TOKEN`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Cron loader
// ---------------------------------------------------------------------------
let CRONS = {};
try {
  const gwToken = resolveGatewayToken();
  const cronEnv = gwToken ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: gwToken } : process.env;
  const out = execSync('openclaw cron list --json', { encoding: 'utf-8', timeout: 8000, env: cronEnv });
  const data = JSON.parse(out);
  for (const c of data.jobs || data) {
    CRONS[c.id] = {
      name: c.name,
      agent: c.agentId,
      enabled: c.enabled,
      schedule: typeof c.schedule === 'object'
        ? c.schedule.expr || c.schedule.expression || c.schedule.cron || ''
        : c.schedule || '',
      lastRun: c.state?.lastRunAt || c.state?.lastRunAtMs,
      lastStatus: c.state?.lastRunStatus,
    };
  }
} catch (e) {
  console.log('[observability] cron list failed:', e.message);
}
console.log(`[observability] ${Object.keys(CRONS).length} crons loaded`);

// ---------------------------------------------------------------------------
// Session parsing helpers
// ---------------------------------------------------------------------------
function getSourceType(k) {
  if (k.includes(':cron:'))     return 'cron';
  if (k.includes(':subagent:')) return 'subagent';
  if (k.includes(':telegram:')) return 'telegram';
  if (k.includes(':whatsapp:')) return 'whatsapp';
  if (k.includes(':main'))      return 'direct';
  return 'other';
}

function getCronId(k) {
  const m = k.match(/:cron:([a-f0-9-]{36})/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Load all events from JSONL session files
// ---------------------------------------------------------------------------
function loadAllEvents() {
  const events = [];
  const SKIP = new Set(['delivery-mirror', 'gateway-injected', '']);

  if (!existsSync(AGENTS_DIR)) return events;

  for (const agentId of readdirSync(AGENTS_DIR).filter(d => existsSync(join(AGENTS_DIR, d, 'sessions')))) {
    const sessDir = join(AGENTS_DIR, agentId, 'sessions');
    const keyMap = {};

    // Build session key map from sessions.json index
    try {
      const idx = JSON.parse(readFileSync(join(sessDir, 'sessions.json'), 'utf-8'));
      for (const [key, val] of Object.entries(idx)) {
        if (val?.sessionId) keyMap[val.sessionId] = key;
      }
    } catch {}

    for (const file of readdirSync(sessDir).filter(f => f.endsWith('.jsonl'))) {
      try {
        const sid = file.replace('.jsonl', '');
        const skey = keyMap[sid] || '';
        const source = getSourceType(skey);
        const cronId = getCronId(skey);
        const isSubagent = source === 'subagent';
        let subagentFirstMsg = '';

        for (const line of readFileSync(join(sessDir, file), 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const msg = entry?.message;

            // Capture first user message for subagent context
            if (isSubagent && !subagentFirstMsg && msg?.role === 'user') {
              const c = msg.content;
              if (Array.isArray(c)) {
                const t = c.find(x => x.type === 'text');
                if (t) subagentFirstMsg = t.text?.slice(0, 100) || '';
              } else if (typeof c === 'string') {
                subagentFirstMsg = c.slice(0, 100);
              }
            }

            if (!msg?.usage?.cost || SKIP.has(msg.model || '')) continue;

            const tokens = {
              input:     msg.usage.input      || 0,
              output:    msg.usage.output     || 0,
              cacheRead: msg.usage.cacheRead  || 0,
              total:     msg.usage.totalTokens || 0,
            };

            events.push({
              ts: entry.timestamp,
              provider: msg.provider || '?',
              model: msg.model || '?',
              tokens,
              cost: calcCost(msg.provider, msg.model, tokens),
              agentId,
              source,
              cronId,
              subagentId: isSubagent ? sid : null,
              subagentCtx: isSubagent ? subagentFirstMsg : null,
            });
          } catch {}
        }
      } catch {}
    }
  }

  events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return events;
}

// ---------------------------------------------------------------------------
// Scan: aggregate events within a time range
// ---------------------------------------------------------------------------
function scan(from, to, filters = {}) {
  const events = loadAllEvents();
  const byAgent = {}, byModel = {}, bySource = {}, byDay = {}, byCron = {}, bySubagent = {};
  let totalCost = 0, totalTokens = 0, totalRequests = 0;
  const recent = [];

  for (const ev of events) {
    const t = new Date(ev.ts).getTime();
    if (from && t < from) continue;
    if (to && t > to)     continue;
    if (filters.agent  && ev.agentId !== filters.agent) continue;
    if (filters.model  && ev.model   !== filters.model) continue;
    if (filters.source && ev.source  !== filters.source) continue;

    totalCost    += ev.cost;
    totalTokens  += ev.tokens.total;
    totalRequests++;

    const add = (o, k) => {
      if (!k) return;
      if (!o[k]) o[k] = { cost: 0, calls: 0, tok: 0 };
      o[k].cost += ev.cost;
      o[k].calls++;
      o[k].tok += ev.tokens.total;
    };

    add(byAgent,  ev.agentId);
    add(byModel,  ev.model);
    add(bySource, ev.source);
    if (ev.cronId) add(byCron, ev.cronId);

    if (ev.subagentId) {
      if (!bySubagent[ev.subagentId]) {
        bySubagent[ev.subagentId] = {
          cost: 0, calls: 0, tok: 0,
          agent: ev.agentId, model: ev.model,
          ctx: ev.subagentCtx || '', firstTs: ev.ts,
        };
      }
      bySubagent[ev.subagentId].cost  += ev.cost;
      bySubagent[ev.subagentId].calls++;
      bySubagent[ev.subagentId].tok   += ev.tokens.total;
      if (!bySubagent[ev.subagentId].model || ev.model !== '?') {
        bySubagent[ev.subagentId].model = ev.model;
      }
    }

    const day = ev.ts?.slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + ev.cost;

    recent.push(ev);
  }

  recent.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return {
    totalCost, totalTokens, totalRequests,
    byAgent, byModel, bySource, byDay, byCron, bySubagent,
    crons: CRONS,
    recent: recent.slice(0, 80),
    ts: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Security scan
// ---------------------------------------------------------------------------
function securityScan() {
  const findings = [];
  const sevOrder = (s) => ({ critical: 0, high: 1, medium: 2, low: 3, ok: 4 }[s] ?? 5);
  const home = homedir();

  // File permission checks — paths are relative to OPENCLAW_DIR and home
  const checks = [
    [join(home, 'Library/LaunchAgents/ai.openclaw.gateway.plist'), 'LaunchAgent plist (contains API keys in env vars)'],
    [CONFIG_FILE, 'Main config (all secrets)'],
    [join(OPENCLAW_DIR, 'credentials/whatsapp'), 'WhatsApp credentials directory'],
    [join(OPENCLAW_DIR, 'identity'), 'Device identity directory'],
    [join(OPENCLAW_DIR, 'identity/device.json'), 'Device Ed25519 private key'],
  ];

  for (const [filePath, label] of checks) {
    try {
      const st = statSync(filePath);
      const mode = st.mode;
      const worldRead = !!(mode & 0o004);
      const worldExec = !!(mode & 0o001);
      const groupRead = !!(mode & 0o040);
      const isDir = st.isDirectory();
      const perms = '0' + (mode & 0o777).toString(8);

      let severity = 'ok';
      if (worldRead && (label.includes('plist') || label.includes('key'))) severity = 'critical';
      else if (worldRead || (isDir && worldExec)) severity = 'high';
      else if (groupRead) severity = 'medium';

      // Display path relative to home for privacy
      const displayPath = filePath.replace(home + '/', '~/');
      findings.push({ type: 'permissions', path: displayPath, label, perms, worldReadable: worldRead, severity });
    } catch {}
  }

  // Analyse openclaw.json config for exposed secrets
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));

    const telegramAccounts = cfg?.channels?.telegram?.accounts || {};
    const tgPlaintext = Object.values(telegramAccounts).filter(a => typeof a.botToken === 'string').length;
    const tgSecretRef = Object.values(telegramAccounts).filter(a => typeof a.botToken === 'object' && a.botToken?.source).length;
    const anthropicProfiles = Object.keys(cfg?.auth?.profiles || {}).length;

    // API key storage checks
    const googleKey = cfg?.models?.providers?.google?.apiKey;
    const gatewayToken = cfg?.gateway?.auth?.token;
    const googleIsRef = typeof googleKey === 'object' && googleKey?.source;
    const gatewayIsRef = typeof gatewayToken === 'object' && gatewayToken?.source;
    const envKeys = cfg?.env || {};
    const envPlaintext = Object.values(envKeys).filter(v => typeof v === 'string' && v.length > 10 && !v.startsWith('MANAGED')).length;

    if (tgPlaintext > 0)  findings.push({ type: 'secrets', label: 'Telegram bot tokens in plaintext',  count: tgPlaintext, severity: 'critical', detail: tgPlaintext + ' tokens exposed. Any leak allows full bot hijacking' });
    if (tgSecretRef > 0)  findings.push({ type: 'secrets', label: 'Telegram bot tokens via SecretRef', count: tgSecretRef, severity: 'ok',       detail: tgSecretRef + ' tokens secured via dotenvx encrypted storage' });
    if (!googleIsRef)     findings.push({ type: 'secrets', label: 'Google API key in plaintext',        severity: 'critical', detail: 'models.providers.google.apiKey is not a SecretRef' });
    else                  findings.push({ type: 'secrets', label: 'Google API key via SecretRef',        severity: 'ok',       detail: 'Secured via dotenvx encrypted storage' });
    if (!gatewayIsRef)    findings.push({ type: 'secrets', label: 'Gateway auth token in plaintext',    severity: 'high',     detail: 'gateway.auth.token is not a SecretRef' });
    else                  findings.push({ type: 'secrets', label: 'Gateway auth token via SecretRef',    severity: 'ok',       detail: 'Secured via dotenvx encrypted storage' });
    if (envPlaintext > 0) findings.push({ type: 'secrets', label: 'Plaintext keys in env block',        count: envPlaintext, severity: 'medium', detail: envPlaintext + ' env values look like API keys' });
    else                  findings.push({ type: 'secrets', label: 'Env block clean',                    severity: 'ok',       detail: 'No plaintext API keys in env' });

    // Dotenvx encryption status
    const dotenvExists = existsSync(join(OPENCLAW_DIR, '.env'));
    const dotenvKeysGone = !existsSync(join(OPENCLAW_DIR, '.env.keys'));
    if (dotenvExists && dotenvKeysGone) {
      findings.push({ type: 'secrets', label: 'dotenvx encryption active', severity: 'ok', detail: '.env encrypted, private key in Keychain only (no file on disk)' });
    } else if (dotenvExists && !dotenvKeysGone) {
      findings.push({ type: 'secrets', label: '.env.keys file exists on disk', severity: 'high', detail: 'Private decryption key is stored as plaintext file. Move to Keychain and delete.' });
    } else {
      findings.push({ type: 'secrets', label: 'No dotenvx encryption', severity: 'medium', detail: 'Secrets not encrypted at rest' });
    }

    findings.push({ type: 'secrets', label: 'Auth profiles (Anthropic/OAuth tokens)', count: anthropicProfiles, severity: 'high', detail: 'Shared across multiple agents — one compromise = all compromised' });

    // Network checks
    findings.push({ type: 'network', label: 'Gateway binding', value: cfg?.gateway?.bind || 'unknown', severity: cfg?.gateway?.bind === 'loopback' ? 'ok' : 'critical', detail: 'loopback = localhost only' });
    findings.push({ type: 'network', label: 'Gateway auth',    value: cfg?.gateway?.auth?.mode || 'none', severity: cfg?.gateway?.auth?.mode === 'token' ? 'ok' : 'high', detail: 'Token auth enabled' });
    findings.push({ type: 'network', label: 'Tailscale exposure', value: cfg?.gateway?.tailscale?.mode || 'off', severity: 'ok', detail: 'Not exposed via Tailscale' });

    // Channel allowlists
    const waAllow = cfg?.channels?.whatsapp?.allowFrom || [];
    const tgAllow = cfg?.channels?.telegram?.accounts?.default?.allowFrom || [];
    findings.push({ type: 'access', label: 'WhatsApp allowlist', value: waAllow.length + ' numbers', severity: waAllow.length <= 2 ? 'ok' : 'medium', detail: waAllow.join(', ') });
    findings.push({ type: 'access', label: 'Telegram allowlist', value: tgAllow.length + ' users',   severity: tgAllow.length <= 2 ? 'ok' : 'medium', detail: tgAllow.join(', ') });

    // Expired auth tokens
    try {
      const agentDirs = readdirSync(AGENTS_DIR);
      for (const agent of agentDirs) {
        try {
          const ap = JSON.parse(readFileSync(join(AGENTS_DIR, agent, 'agent/auth-profiles.json'), 'utf-8'));
          for (const [pid, prof] of Object.entries(ap.profiles || {})) {
            if (prof.expires && prof.expires < Date.now()) {
              findings.push({ type: 'tokens', label: 'Expired token: ' + pid, value: agent, severity: 'medium', detail: 'Expired ' + new Date(prof.expires).toISOString().slice(0, 10) });
            }
          }
        } catch {}
      }
    } catch {}

    // WhatsApp session files
    try {
      const waDir = join(OPENCLAW_DIR, 'credentials/whatsapp/default');
      const waFiles = readdirSync(waDir).length;
      findings.push({ type: 'data', label: 'WhatsApp session files', value: waFiles + ' files', severity: 'high', detail: 'Contains private keys for message decryption + session clone' });
    } catch {}
  } catch {}

  findings.sort((a, b) => sevOrder(a.severity) - sevOrder(b.severity));

  const score = Math.max(0,
    100
    - findings.filter(f => f.severity === 'critical').length * 25
    - findings.filter(f => f.severity === 'high').length * 10
    - findings.filter(f => f.severity === 'medium').length * 5
  );

  return { findings, score, ts: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Config API — read/write agents, models, crons
// ---------------------------------------------------------------------------
function getConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));

  const agents = (cfg.agents?.list || []).map((a, i) => ({
    index: i,
    id: a.id,
    name: a.name || a.id,
    model: a.model || cfg.agents?.defaults?.model?.primary || '?',
    enabled: a.enabled !== false,
  }));

  const defaultModel = cfg.agents?.defaults?.model?.primary || '?';

  // Refresh cron status
  let cronStatus = {};
  try {
    const gwToken = resolveGatewayToken();
    const cronEnv = gwToken ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: gwToken } : process.env;
    const out = execSync('openclaw cron list --json', { encoding: 'utf-8', timeout: 8000, env: cronEnv });
    const data = JSON.parse(out);
    for (const c of data.jobs || data) {
      cronStatus[c.id] = {
        name: c.name,
        agent: c.agentId,
        enabled: c.enabled,
        schedule: typeof c.schedule === 'object' ? c.schedule.expr || '' : c.schedule || '',
      };
    }
  } catch {}

  return {
    agents,
    defaultModel,
    crons: cronStatus,
    models: AVAILABLE_MODELS,
    billingProxy: billingProxy.getStatus(),
  };
}

function setAgentModel(agentIndex, model) {
  try {
    // 1. Update openclaw.json
    execSync(`openclaw config set "agents.list[${agentIndex}].model" "${model}"`, { encoding: 'utf-8', timeout: 5000 });

    // 2. Update the agent's models.json so the runtime uses the right model
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    const agent = cfg.agents?.list?.[agentIndex];
    if (agent) {
      const modelId = model.split('/').slice(1).join('/'); // "google/gemini-2.5-pro" -> "gemini-2.5-pro"
      const provider = model.split('/')[0]; // "google"
      const modelsFile = join(AGENTS_DIR, agent.id, 'agent', 'models.json');
      try {
        const agentModels = JSON.parse(readFileSync(modelsFile, 'utf-8'));
        const providerKey = provider === 'anthropic' ? 'anthropic-vertex' : provider;
        // Find the matching provider in models.json, or use 'google'
        const targetKey = agentModels.providers?.[provider] ? provider : providerKey;
        if (agentModels.providers?.[targetKey]) {
          agentModels.providers[targetKey].models = [{
            id: modelId,
            name: modelId,
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 1048576,
            maxTokens: 65536,
          }];
          writeFileSync(modelsFile, JSON.stringify(agentModels, null, 2));
        }
      } catch {} // models.json might not exist for all agents

      // 3. Clean session overrides that conflict
      const sessFile = join(AGENTS_DIR, agent.id, 'sessions', 'sessions.json');
      try {
        const sessions = JSON.parse(readFileSync(sessFile, 'utf-8'));
        let changed = false;
        for (const key of Object.keys(sessions)) {
          const s = sessions[key];
          if (s.modelOverride) { delete s.modelOverride; changed = true; }
          if (s.authProfileOverride) {
            const overrideProv = s.authProfileOverride.split(':')[0];
            if (overrideProv !== provider) {
              delete s.authProfileOverride;
              delete s.authProfileOverrideSource;
              delete s.authProfileOverrideCompactionCount;
              changed = true;
            }
          }
        }
        if (changed) writeFileSync(sessFile, JSON.stringify(sessions, null, 2));
      } catch {}
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function setDefaultModel(model) {
  try {
    execSync(`openclaw config set agents.defaults.model.primary "${model}"`, { encoding: 'utf-8', timeout: 5000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function toggleCron(cronId, enabled) {
  try {
    const gwToken = resolveGatewayToken();
    const cronEnv = gwToken ? { ...process.env, OPENCLAW_GATEWAY_TOKEN: gwToken } : process.env;
    const cmd = enabled ? `openclaw cron enable ${cronId}` : `openclaw cron disable ${cronId}`;
    execSync(cmd, { encoding: 'utf-8', timeout: 8000, env: cronEnv });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function restartGateway() {
  try {
    execSync('openclaw gateway restart', { encoding: 'utf-8', timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleConfigAction(data) {
  if (data.action === 'setAgentModel') return setAgentModel(data.agentIndex, data.model);
  if (data.action === 'setDefaultModel') return setDefaultModel(data.model);
  if (data.action === 'toggleCron') return toggleCron(data.cronId, data.enabled);
  if (data.action === 'restart') return restartGateway();
  if (data.action === 'startBillingProxy') {
    await billingProxy.start();
    return { ok: true, billingProxy: billingProxy.getStatus() };
  }
  if (data.action === 'stopBillingProxy') {
    await billingProxy.stop();
    return { ok: true, billingProxy: billingProxy.getStatus() };
  }
  if (data.action === 'restartBillingProxy') {
    await billingProxy.restart();
    return { ok: true, billingProxy: billingProxy.getStatus() };
  }
  if (data.action === 'setBillingProxyRouting') {
    return { ok: true, billingProxy: billingProxy.setOpenClawRouting(Boolean(data.enabled)) };
  }
  return { ok: false, error: 'Unknown action' };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------
function parseReq(url) {
  const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')).getTime() : null;
  const to   = url.searchParams.get('to')   ? new Date(url.searchParams.get('to') + 'T23:59:59').getTime() : null;
  const filters = {};
  for (const k of ['agent', 'model', 'source']) {
    const v = url.searchParams.get(k);
    if (v) filters[k] = v;
  }
  return { from, to, filters };
}

// ---------------------------------------------------------------------------
// HTML — served from dashboard.html (or inline fallback)
// ---------------------------------------------------------------------------
let htmlCache = null;

function getHTML() {
  if (htmlCache) return htmlCache;
  try {
    htmlCache = readFileSync(join(__dirname, 'dashboard.html'), 'utf-8');
  } catch {
    htmlCache = '<html><body><h1>dashboard.html not found</h1><p>Place dashboard.html next to server.mjs</p></body></html>';
  }
  return htmlCache;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS headers for all API responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (url.pathname === '/api/dashboard') {
    const { from, to, filters } = parseReq(url);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify(scan(from, to, filters)));

  } else if (url.pathname === '/api/security') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify(securityScan()));

  } else if (url.pathname === '/api/billing-proxy' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify(billingProxy.getStatus()));

  } else if (url.pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify(getConfig()));

  } else if (url.pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const result = await handleConfigAction(data);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;

  } else {
    // Serve dashboard HTML (bust cache in dev)
    htmlCache = null;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHTML());
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[observability] Dashboard: http://localhost:${PORT}`);
});
