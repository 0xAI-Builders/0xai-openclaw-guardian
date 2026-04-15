#!/usr/bin/env node
/**
 * openclaw-obs CLI — entry point.
 *
 * Usage:
 *   openclaw-obs [start]                 start server (default)
 *   openclaw-obs init [--yes]            detect ~/.openclaw, patch providers, install LaunchAgent
 *   openclaw-obs status                  proxy + guards health snapshot
 *   openclaw-obs limits get|set <field> [value]
 *   openclaw-obs help
 *
 * Env vars honored: OPENCLAW_DIR, OBS_PORT, OBS_HOST, OBS_BILLING_PROXY_PORT.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2] || 'start';
const args = process.argv.slice(3);

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(homedir(), '.openclaw');
const PROXY_PORT = process.env.OBS_BILLING_PROXY_PORT || 18801;
const PROXY_HOST = '127.0.0.1';
const DASHBOARD_PORT = process.env.OBS_PORT || 3847;
const PROXY_BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;

// --- Provider → URL routes through the proxy --------------------------------
// Keys are the providers the multi-provider router knows about. When `init`
// patches openclaw.json, each listed provider gets its baseUrl rewritten.
const PROVIDER_ROUTES = {
  anthropic:  `${PROXY_BASE}`,                 // root path handles Anthropic
  openai:     `${PROXY_BASE}/openai/v1`,
  google:     `${PROXY_BASE}/google`,
  openrouter: `${PROXY_BASE}/openrouter/v1`,
  groq:       `${PROXY_BASE}/groq/openai/v1`,
  cerebras:   `${PROXY_BASE}/cerebras/v1`,
  xai:        `${PROXY_BASE}/xai/v1`,
  ollama:     `${PROXY_BASE}/ollama`,
  huggingface:`${PROXY_BASE}/huggingface`,
};

function log(...m) { console.log('[openclaw-obs]', ...m); }
function warn(...m) { console.warn('[openclaw-obs] ⚠️ ', ...m); }
function die(msg, code = 1) { console.error('[openclaw-obs] ✗', msg); process.exit(code); }

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return null; }
}
function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

async function ask(q, defYes = false) {
  if (args.includes('--yes') || args.includes('-y')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(`${q} ${defYes ? '[Y/n]' : '[y/N]'} `, a => {
    rl.close();
    const s = a.trim().toLowerCase();
    if (!s) r(defYes);
    else r(s === 'y' || s === 'yes' || s === 's' || s === 'si');
  }));
}

// ---------------------------------------------------------------------------
// start (default)
// ---------------------------------------------------------------------------
async function cmdStart() {
  await import(join(__dirname, '..', 'src', 'server.mjs'));
}

// ---------------------------------------------------------------------------
// init — auto-configure openclaw.json and optionally install LaunchAgent
// ---------------------------------------------------------------------------
async function cmdInit() {
  log(`Setting up openclaw-observability in ${OPENCLAW_DIR}`);

  const configPath = join(OPENCLAW_DIR, 'openclaw.json');
  if (!existsSync(configPath)) {
    die(`openclaw.json not found at ${configPath}. Install openclaw first.`);
  }

  // ---- 1. Backup ----
  const backup = `${configPath}.bak.pre-obs-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(configPath, backup);
  log(`✓ backed up openclaw.json → ${backup}`);

  // ---- 2. Patch provider baseUrls ----
  const cfg = readJson(configPath);
  if (!cfg) die(`openclaw.json at ${configPath} is not valid JSON`);
  cfg.models = cfg.models || {};
  cfg.models.providers = cfg.models.providers || {};

  const touched = [];
  for (const [prov, url] of Object.entries(PROVIDER_ROUTES)) {
    const block = cfg.models.providers[prov];
    if (!block) continue; // user doesn't use this provider — skip
    const before = block.baseUrl;
    if (before === url) continue; // already patched
    block.baseUrl = url;
    touched.push({ prov, before: before || '(unset)', after: url });
  }

  if (touched.length === 0) {
    log('✓ all providers already point at the proxy — nothing to patch');
  } else {
    for (const t of touched) log(`  • ${t.prov}: ${t.before} → ${t.after}`);
    if (!(await ask(`Write ${touched.length} baseUrl change(s) to openclaw.json?`, true))) {
      log('✗ aborted. Backup preserved, no changes written.');
      return;
    }
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    log('✓ openclaw.json updated — restart the OpenClaw gateway for changes to take effect');
  }

  // ---- 3. Seed limits.json if missing ----
  const obsDir = join(OPENCLAW_DIR, 'observability');
  const limitsPath = join(obsDir, 'limits.json');
  const exampleLimits = join(__dirname, '..', 'config', 'limits.example.json');
  if (!existsSync(limitsPath)) {
    mkdirSync(obsDir, { recursive: true });
    if (existsSync(exampleLimits)) {
      copyFileSync(exampleLimits, limitsPath);
      log(`✓ seeded ${limitsPath} from example`);
    } else {
      writeFileSync(limitsPath, JSON.stringify({
        enabled: true, paused: false,
        global: { dailyUsd: 10, weeklyUsd: 50, monthlyUsd: 200 },
        loopDetector: { enabled: true, windowSec: 60, maxCalls: 30 },
        rateLimits: { perProvider: { ollama: { callsPerMinute: 120, callsPerHour: 2000, tokensPerDay: 50_000_000 } } },
      }, null, 2));
      log(`✓ created minimal ${limitsPath}`);
    }
  }

  // ---- 4. Offer LaunchAgent (macOS only) ----
  if (process.platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'ai.openclaw-obs.plist');
    if (!existsSync(plistPath) && await ask('Install macOS LaunchAgent so the dashboard autostarts on login?', true)) {
      const nodeBin = process.execPath;
      const cliPath = join(__dirname, 'cli.mjs');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.openclaw-obs</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProgramArguments</key><array>
    <string>${nodeBin}</string>
    <string>${cliPath}</string>
    <string>start</string>
  </array>
  <key>StandardOutPath</key><string>${join(OPENCLAW_DIR, 'logs', 'openclaw-obs.log')}</string>
  <key>StandardErrorPath</key><string>${join(OPENCLAW_DIR, 'logs', 'openclaw-obs.err.log')}</string>
  <key>EnvironmentVariables</key><dict>
    <key>OPENCLAW_DIR</key><string>${OPENCLAW_DIR}</string>
  </dict>
</dict></plist>`;
      writeFileSync(plistPath, plist);
      try {
        execSync(`launchctl load ${plistPath}`, { stdio: 'ignore' });
        log(`✓ LaunchAgent installed at ${plistPath} and loaded`);
      } catch {
        warn(`LaunchAgent written to ${plistPath} but failed to load — try: launchctl load "${plistPath}"`);
      }
    }
  }

  // ---- 5. Final report ----
  log('');
  log('🎉 Done. Next steps:');
  log(`   1. Dashboard:   http://localhost:${DASHBOARD_PORT}`);
  log(`   2. Proxy:       ${PROXY_BASE}`);
  log(`   3. Restart OpenClaw gateway so the new baseUrls apply`);
  log(`   4. Tail calls:  sqlite3 ~/.openclaw/observability/calls.db 'select * from calls order by ts desc limit 5'`);
  log('');
}

// ---------------------------------------------------------------------------
// status — proxy health + guards snapshot
// ---------------------------------------------------------------------------
async function cmdStatus() {
  try {
    const proxy = await fetchJson(`http://127.0.0.1:${PROXY_PORT}/health`);
    log(`proxy       ${PROXY_BASE}  •  status=${proxy.status}  •  served=${proxy.requestsServed}  •  blocked=${proxy.blockedCount}`);
    if (proxy.guards?.spend) {
      const s = proxy.guards.spend;
      log(`spend       today=$${s.today?.toFixed(4)}  week=$${s.week?.toFixed(4)}  month=$${s.month?.toFixed(4)}`);
    }
    if (proxy.guards?.paused) log('⛔ EMERGENCY PAUSE IS ON — all requests blocked');
  } catch {
    warn(`proxy NOT RUNNING on ${PROXY_BASE} — run \`openclaw-obs start\` to launch`);
  }
  try {
    const dash = await fetchJson(`http://127.0.0.1:${DASHBOARD_PORT}/api/calls?limit=1`);
    log(`dashboard   http://localhost:${DASHBOARD_PORT}  •  calls logged=${dash.total}`);
  } catch {
    warn(`dashboard NOT RUNNING on :${DASHBOARD_PORT}`);
  }
}

// ---------------------------------------------------------------------------
// limits — quick get/set from CLI
// ---------------------------------------------------------------------------
async function cmdLimits() {
  const sub = args[0];
  if (!sub || sub === 'get') {
    try {
      const l = await fetchJson(`http://127.0.0.1:${DASHBOARD_PORT}/api/limits`);
      console.log(JSON.stringify(l, null, 2));
    } catch {
      die('dashboard not running');
    }
    return;
  }
  if (sub === 'pause') {
    const body = JSON.stringify({ enabled: true, paused: true });
    await postJson(`http://127.0.0.1:${DASHBOARD_PORT}/api/limits`, body);
    log('🛑 emergency pause ON');
    return;
  }
  if (sub === 'resume' || sub === 'unpause') {
    const cur = await fetchJson(`http://127.0.0.1:${DASHBOARD_PORT}/api/limits`);
    const next = { ...(cur.limits || {}), paused: false, enabled: true };
    await postJson(`http://127.0.0.1:${DASHBOARD_PORT}/api/limits`, JSON.stringify(next));
    log('✓ emergency pause OFF');
    return;
  }
  die(`unknown limits subcommand: ${sub}. try: get | pause | resume`);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function cmdHelp() {
  console.log(`openclaw-obs — observability, kill-switches, and cost tracking for OpenClaw

Usage:
  openclaw-obs                         Start dashboard + proxy (same as 'start')
  openclaw-obs start                   Start dashboard + proxy
  openclaw-obs init [--yes]            Auto-configure ~/.openclaw/openclaw.json
                                       to route every provider through the proxy,
                                       seed limits.json, and optionally install
                                       a LaunchAgent (macOS) for autostart.
  openclaw-obs status                  Print proxy + dashboard health snapshot
  openclaw-obs limits get              Dump current limits + spend JSON
  openclaw-obs limits pause            Turn emergency kill-switch ON
  openclaw-obs limits resume           Turn emergency kill-switch OFF
  openclaw-obs help                    This message

Environment:
  OPENCLAW_DIR     ${OPENCLAW_DIR}
  OBS_PORT         ${DASHBOARD_PORT}
  OBS_BILLING_PROXY_PORT  ${PROXY_PORT}

Proxy routes (providers):
  ${Object.entries(PROVIDER_ROUTES).map(([p, u]) => `${p.padEnd(12)} → ${u}`).join('\n  ')}
`);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------
(async () => {
  switch (cmd) {
    case 'start': await cmdStart(); break;
    case 'init':  await cmdInit();  break;
    case 'status': await cmdStatus(); break;
    case 'limits': await cmdLimits(); break;
    case 'help':
    case '--help':
    case '-h': cmdHelp(); break;
    default: cmdHelp(); process.exit(1);
  }
})();
