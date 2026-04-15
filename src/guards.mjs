/**
 * Guards — pre-request kill-switches and anti-loop protection.
 *
 * Reads ~/.openclaw/observability/limits.json (hot-reloaded on mtime change).
 *
 * Checks, in order (cheapest first):
 *   1. Hard pause switch (limits.paused = true)
 *   2. Global daily / weekly / monthly caps
 *   3. Per-agent caps
 *   4. Per-model caps
 *   5. Per-provider caps
 *   6. Loop detector: same session_id has >N calls in last X seconds
 *
 * Returns { allowed: bool, reason?: string, code?: 'paused'|'daily_cap'|'loop'|..., limit?, spend? }.
 *
 * Fails OPEN (allow) if limits.json is missing or malformed — we never want
 * a misconfig to kill production traffic. Caller should log warning.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEEK_MS = 7 * 24 * 3600_000;
const MONTH_MS = 30 * 24 * 3600_000;

const DEFAULTS = Object.freeze({
  enabled: true,
  paused: false,
  global: { dailyUsd: null, weeklyUsd: null, monthlyUsd: null },
  perAgent: {},
  perModel: {},
  perProvider: {},
  loopDetector: { enabled: true, windowSec: 60, maxCalls: 30 },
  warningThreshold: 0.8,
});

export class Guards {
  constructor({ limitsPath, logger_ = console, callLogger } = {}) {
    this.limitsPath = limitsPath;
    this.logger = logger_;
    this.callLogger = callLogger;
    this._cache = null;
    this._mtime = 0;
    this._loadCount = 0;
  }

  _load() {
    try {
      const st = statSync(this.limitsPath);
      if (st.mtimeMs === this._mtime && this._cache) return this._cache;
      const raw = readFileSync(this.limitsPath, 'utf8');
      const parsed = JSON.parse(raw);
      this._cache = normalizeLimits({ ...DEFAULTS, ...parsed });
      this._mtime = st.mtimeMs;
      this._loadCount++;
      return this._cache;
    } catch (err) {
      if (err.code !== 'ENOENT' && !this._cache) {
        this.logger.warn?.(`[guards] limits load failed: ${err.message}`);
      }
      return this._cache || DEFAULTS;
    }
  }

  getLimits() { return this._load(); }

  /**
   * Check if a request should be allowed.
   * @param {{provider, model, agent_id, session_id}} ctx
   * @returns {{allowed: boolean, reason?: string, code?: string, spend?: number, limit?: number}}
   */
  check(ctx = {}) {
    const L = this._load();
    if (!L.enabled) return { allowed: true };
    if (L.paused) {
      return { allowed: false, code: 'paused', reason: 'Observability is in paused state' };
    }
    if (!this.callLogger) return { allowed: true };

    // 1. Global daily/weekly/monthly
    if (L.global?.dailyUsd != null) {
      const spend = this.callLogger.spendToday();
      if (spend >= L.global.dailyUsd) {
        return { allowed: false, code: 'global_daily_cap', reason: `Daily global cap $${L.global.dailyUsd} reached (spent $${spend.toFixed(2)})`, spend, limit: L.global.dailyUsd };
      }
    }
    if (L.global?.weeklyUsd != null) {
      const spend = this.callLogger.spendWindow(WEEK_MS);
      if (spend >= L.global.weeklyUsd) {
        return { allowed: false, code: 'global_weekly_cap', reason: `Weekly global cap $${L.global.weeklyUsd} reached`, spend, limit: L.global.weeklyUsd };
      }
    }
    if (L.global?.monthlyUsd != null) {
      const spend = this.callLogger.spendWindow(MONTH_MS);
      if (spend >= L.global.monthlyUsd) {
        return { allowed: false, code: 'global_monthly_cap', reason: `Monthly global cap $${L.global.monthlyUsd} reached`, spend, limit: L.global.monthlyUsd };
      }
    }

    // 2. Per-agent
    const perAgentCap = ctx.agent_id ? L.perAgent?.[ctx.agent_id] : null;
    if (perAgentCap?.dailyUsd != null && this.callLogger.db) {
      const spend = this._spendByColumn('agent_id', ctx.agent_id, 'today');
      if (spend >= perAgentCap.dailyUsd) {
        return { allowed: false, code: 'agent_daily_cap', reason: `Agent '${ctx.agent_id}' daily cap $${perAgentCap.dailyUsd} reached`, spend, limit: perAgentCap.dailyUsd };
      }
    }

    // 3. Per-model
    const perModelCap = ctx.model ? L.perModel?.[ctx.model] : null;
    if (perModelCap?.dailyUsd != null && this.callLogger.db) {
      const spend = this._spendByColumn('model', ctx.model, 'today');
      if (spend >= perModelCap.dailyUsd) {
        return { allowed: false, code: 'model_daily_cap', reason: `Model '${ctx.model}' daily cap $${perModelCap.dailyUsd} reached`, spend, limit: perModelCap.dailyUsd };
      }
    }

    // 4. Per-provider
    const perProvCap = ctx.provider ? L.perProvider?.[ctx.provider] : null;
    if (perProvCap?.dailyUsd != null && this.callLogger.db) {
      const spend = this._spendByColumn('provider', ctx.provider, 'today');
      if (spend >= perProvCap.dailyUsd) {
        return { allowed: false, code: 'provider_daily_cap', reason: `Provider '${ctx.provider}' daily cap $${perProvCap.dailyUsd} reached`, spend, limit: perProvCap.dailyUsd };
      }
    }

    // 5. Loop detector
    if (L.loopDetector?.enabled && ctx.session_id) {
      const { windowSec = 60, maxCalls = 30 } = L.loopDetector;
      const count = this.callLogger.recentSessionCalls(ctx.session_id, windowSec * 1000);
      if (count >= maxCalls) {
        return { allowed: false, code: 'loop_detected', reason: `Session '${ctx.session_id}' exceeded ${maxCalls} calls/${windowSec}s (got ${count})`, spend: count, limit: maxCalls };
      }
    }

    return { allowed: true };
  }

  _spendByColumn(col, val, window) {
    if (!this.callLogger?.db) return 0;
    const allowed = new Set(['provider', 'model', 'agent_id', 'session_id']);
    if (!allowed.has(col)) return 0;
    const start = new Date();
    if (window === 'today') start.setHours(0, 0, 0, 0);
    const row = this.callLogger.db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE ${col} = ? AND ts >= ?`
    ).get(val, start.getTime());
    return row?.s || 0;
  }

  /** Quick snapshot for dashboard. */
  snapshot() {
    const L = this._load();
    const s = { enabled: L.enabled, paused: L.paused };
    if (!this.callLogger) return s;
    s.spend = {
      today: this.callLogger.spendToday(),
      week: this.callLogger.spendWindow(WEEK_MS),
      month: this.callLogger.spendWindow(MONTH_MS),
    };
    s.limits = L;
    if (L.global?.dailyUsd) s.pctDaily = Math.min(1, s.spend.today / L.global.dailyUsd);
    return s;
  }
}

export function defaultLimitsPath(openclawDir) {
  return join(openclawDir, 'observability', 'limits.json');
}

/**
 * Accept legacy keys (`dailyLimit`, `weeklyLimit`, `monthlyLimit`) as aliases
 * for the new explicit USD keys. Per-agent / per-model cap blocks are also
 * normalised in the same way.
 */
function normalizeLimits(cfg) {
  const remap = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = { ...obj };
    if (out.dailyLimit != null && out.dailyUsd == null) out.dailyUsd = out.dailyLimit;
    if (out.weeklyLimit != null && out.weeklyUsd == null) out.weeklyUsd = out.weeklyLimit;
    if (out.monthlyLimit != null && out.monthlyUsd == null) out.monthlyUsd = out.monthlyLimit;
    return out;
  };
  const out = { ...cfg };
  out.global = remap(cfg.global);
  for (const k of ['perAgent', 'perModel', 'perProvider']) {
    if (cfg[k]) {
      out[k] = {};
      for (const [id, block] of Object.entries(cfg[k])) {
        out[k][id] = remap(block);
      }
    }
  }
  return out;
}
