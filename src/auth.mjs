/**
 * Dashboard auth — reuses the OpenClaw gateway token so the dashboard is
 * protected by the same credential that protects the gateway itself.
 *
 * Resolution order (first match wins):
 *   1. process.env.GATEWAY_AUTH_TOKEN           (if dashboard inherits from dotenvx)
 *   2. process.env.OBS_DASHBOARD_TOKEN          (explicit override)
 *   3. ~/.openclaw/.env via dotenvx decrypt     (primary path)
 *   4. Generated local token at                 (last resort for users
 *      ~/.openclaw/observability/dashboard.token     without a gateway)
 *
 * Once resolved, the token is cached in-memory and the middleware compares
 * against the constant-time equal. Set OBS_DISABLE_AUTH=1 to opt out in
 * dev environments.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execSync } from 'node:child_process';

// Auth is OPT-IN. Set OBS_ENABLE_AUTH=1 to turn it on. Default: open.
// (We inverted the polarity vs. the first draft — turning auth on by default
// friction-locked every local dev without clear upside.)
const ENABLED = process.env.OBS_ENABLE_AUTH === '1';
const DISABLED = !ENABLED;

let cachedToken = null;
let source = 'unknown';

export function resolveToken(openclawDir) {
  if (DISABLED) return null;
  if (cachedToken) return cachedToken;

  // 1. Already injected into env
  if (process.env.GATEWAY_AUTH_TOKEN) {
    cachedToken = process.env.GATEWAY_AUTH_TOKEN.trim();
    source = 'env:GATEWAY_AUTH_TOKEN';
    return cachedToken;
  }
  if (process.env.OBS_DASHBOARD_TOKEN) {
    cachedToken = process.env.OBS_DASHBOARD_TOKEN.trim();
    source = 'env:OBS_DASHBOARD_TOKEN';
    return cachedToken;
  }

  // 2. Decrypt from ~/.openclaw/.env via dotenvx + keychain
  const envFile = join(openclawDir, '.env');
  if (existsSync(envFile)) {
    try {
      // Grab the private key from Keychain (macOS) and let dotenvx decrypt.
      const pk = execSync('security find-generic-password -a "$(whoami)" -s "dotenvx-openclaw" -w 2>/dev/null', { encoding: 'utf8' }).trim();
      if (pk) {
        const out = execSync(
          `DOTENV_PRIVATE_KEY='${pk}' npx --no dotenvx get GATEWAY_AUTH_TOKEN --env-file ${envFile}`,
          { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
        if (out && out !== 'undefined' && !out.startsWith('encrypted:')) {
          cachedToken = out;
          source = 'dotenvx:.env';
          return cachedToken;
        }
      }
    } catch {
      // Keychain unavailable or dotenvx failed — fall through to generated token.
    }
  }

  // 3. Generate local token (persisted) so non-openclaw users still get auth
  const tokenFile = join(openclawDir, 'observability', 'dashboard.token');
  if (existsSync(tokenFile)) {
    cachedToken = readFileSync(tokenFile, 'utf8').trim();
    source = 'generated:' + tokenFile;
    return cachedToken;
  }
  mkdirSync(dirname(tokenFile), { recursive: true });
  cachedToken = randomBytes(32).toString('hex');
  writeFileSync(tokenFile, cachedToken + '\n', { mode: 0o600 });
  source = 'generated (new):' + tokenFile;
  return cachedToken;
}

export function tokenSource() { return DISABLED ? 'DISABLED' : source; }
export function isEnabled() { return !DISABLED; }

/** Extract the presented token from a request. */
function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const h = req.headers['x-openclaw-token'] || req.headers['x-gateway-token'];
  if (h) return String(h).trim();
  // URL query fallback (useful for first-time bookmark so user can paste
  // ?token=... once and the dashboard stores it in localStorage)
  const q = req.url?.split('?')[1];
  if (q) {
    for (const pair of q.split('&')) {
      const [k, v] = pair.split('=');
      if (k === 'token' && v) return decodeURIComponent(v);
    }
  }
  return null;
}

/** Constant-time compare. */
function safeEqual(a, b) {
  if (!a || !b) return false;
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch { return false; }
}

/**
 * Node http-style middleware.
 * Allows /health, /login, and static dashboard HTML through unauthenticated;
 * protects every /api/* and /auth/* path.
 */
export function makeAuthChecker(openclawDir) {
  const expected = resolveToken(openclawDir);
  if (!expected) {
    return { check: () => true, source: 'DISABLED' };
  }
  return {
    expected,
    source,
    /** Returns { ok, presented } — presented = what the client sent, if any. */
    check(req) {
      const presented = extractToken(req);
      return { ok: safeEqual(expected, presented), presented };
    },
    /** Subset of paths that bypass auth (loadbalancer probe, HTML shell). */
    isPublicPath(pathname) {
      if (pathname === '/health') return true;
      if (pathname === '/api/_auth/bootstrap') return true;
      if (pathname === '/' || pathname === '/index.html') return true;
      if (pathname.startsWith('/static/')) return true;
      return false;
    },
  };
}
