/**
 * Call Logger — SQLite-backed persistent log of every proxy request.
 *
 * Schema:
 *   calls(id, ts, provider, model, agent_id, session_id, request_id,
 *         input_tokens, output_tokens, cache_read, cache_write,
 *         cost_usd, latency_ms, status, error, request_bytes, response_bytes)
 *
 * Why SQLite (not JSONL):
 *   - range queries / filters / aggregates without a reader pass
 *   - concurrency-safe across proxy + dashboard + cli
 *   - single file, portable, ~100 KB per 1k rows
 *
 * Fallback: if better-sqlite3 is missing, we append JSONL to calls.jsonl
 * and still work (degraded — no aggregations via SQL).
 */
import { mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

let Database = null;
try {
  const mod = await import('better-sqlite3');
  Database = mod.default;
} catch {
  // fallback to JSONL
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS calls (
  id             TEXT PRIMARY KEY,
  ts             INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT,
  agent_id       TEXT,
  session_id     TEXT,
  request_id     TEXT,
  input_tokens   INTEGER DEFAULT 0,
  output_tokens  INTEGER DEFAULT 0,
  cache_read     INTEGER DEFAULT 0,
  cache_write    INTEGER DEFAULT 0,
  cost_usd       REAL DEFAULT 0,
  latency_ms     INTEGER DEFAULT 0,
  status         TEXT,
  error          TEXT,
  request_bytes  INTEGER DEFAULT 0,
  response_bytes INTEGER DEFAULT 0,
  endpoint       TEXT,
  method         TEXT,
  stream         INTEGER DEFAULT 0,
  is_subscription INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ts ON calls(ts DESC);
CREATE INDEX IF NOT EXISTS idx_provider_model ON calls(provider, model);
CREATE INDEX IF NOT EXISTS idx_agent ON calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_session ON calls(session_id);
`;

export class CallLogger {
  constructor({ dbPath, logger = console } = {}) {
    this.dbPath = dbPath;
    this.logger = logger;
    this.db = null;
    this.jsonlPath = dbPath.replace(/\.db$/, '.jsonl');
    this._init();
  }

  _init() {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    if (Database) {
      try {
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(SCHEMA_SQL);
        // ALTER TABLE to add is_subscription if missing (migration for existing dbs).
        try {
          this.db.exec(`ALTER TABLE calls ADD COLUMN is_subscription INTEGER DEFAULT 0`);
        } catch (e) {
          // column already exists — ignore
        }
        this._insertStmt = this.db.prepare(`
          INSERT INTO calls (
            id, ts, provider, model, agent_id, session_id, request_id,
            input_tokens, output_tokens, cache_read, cache_write,
            cost_usd, latency_ms, status, error,
            request_bytes, response_bytes, endpoint, method, stream, is_subscription
          ) VALUES (
            @id, @ts, @provider, @model, @agent_id, @session_id, @request_id,
            @input_tokens, @output_tokens, @cache_read, @cache_write,
            @cost_usd, @latency_ms, @status, @error,
            @request_bytes, @response_bytes, @endpoint, @method, @stream, @is_subscription
          )
        `);
        return;
      } catch (err) {
        this.logger.warn?.(`[logger] sqlite init failed: ${err.message}, falling back to JSONL`);
        this.db = null;
      }
    }
  }

  /**
   * Record one call. All fields optional except provider + ts.
   * Safe to call in hot path (INSERT w/ prepared statement, <1ms typical).
   */
  record(entry) {
    const full = {
      id: entry.id || crypto.randomUUID(),
      ts: entry.ts ?? Date.now(),
      provider: entry.provider || 'unknown',
      model: entry.model || null,
      agent_id: entry.agent_id || null,
      session_id: entry.session_id || null,
      request_id: entry.request_id || null,
      input_tokens: entry.input_tokens || 0,
      output_tokens: entry.output_tokens || 0,
      cache_read: entry.cache_read || 0,
      cache_write: entry.cache_write || 0,
      cost_usd: entry.cost_usd || 0,
      latency_ms: entry.latency_ms || 0,
      status: entry.status || null,
      error: entry.error || null,
      request_bytes: entry.request_bytes || 0,
      response_bytes: entry.response_bytes || 0,
      endpoint: entry.endpoint || null,
      method: entry.method || 'POST',
      stream: entry.stream ? 1 : 0,
      is_subscription: entry.is_subscription ? 1 : 0,
    };

    if (this.db && this._insertStmt) {
      try {
        this._insertStmt.run(full);
        return full;
      } catch (err) {
        this.logger.warn?.(`[logger] insert failed: ${err.message}`);
      }
    }
    // JSONL fallback
    try {
      appendFileSync(this.jsonlPath, JSON.stringify(full) + '\n');
    } catch (err) {
      this.logger.warn?.(`[logger] jsonl append failed: ${err.message}`);
    }
    return full;
  }

  query({ from, to, provider, agent_id, model, limit = 100, offset = 0 } = {}) {
    if (!this.db) return { items: [], total: 0, backend: 'jsonl' };
    const where = [];
    const params = {};
    if (from) { where.push('ts >= @from'); params.from = from; }
    if (to) { where.push('ts <= @to'); params.to = to; }
    if (provider) { where.push('provider = @provider'); params.provider = provider; }
    if (agent_id) { where.push('agent_id = @agent_id'); params.agent_id = agent_id; }
    if (model) { where.push('model = @model'); params.model = model; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = this.db.prepare(
      `SELECT * FROM calls ${clause} ORDER BY ts DESC LIMIT @limit OFFSET @offset`
    ).all({ ...params, limit, offset });
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM calls ${clause}`).get(params).n;
    return { items, total, backend: 'sqlite' };
  }

  aggregate({ from, to, by = 'provider' } = {}) {
    if (!this.db) return [];
    const allowed = new Set(['provider', 'model', 'agent_id', 'session_id']);
    const col = allowed.has(by) ? by : 'provider';
    const where = [];
    const params = {};
    if (from) { where.push('ts >= @from'); params.from = from; }
    if (to) { where.push('ts <= @to'); params.to = to; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.prepare(`
      SELECT ${col} AS key,
             COUNT(*) AS calls,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cost_usd) AS cost_usd,
             AVG(latency_ms) AS avg_latency_ms
      FROM calls ${clause}
      GROUP BY ${col} ORDER BY cost_usd DESC
    `).all(params);
  }

  /** Spend since startOfDay (local tz). Used by guards. */
  spendToday() {
    if (!this.db) return 0;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE ts >= ?'
    ).get(start.getTime());
    return row?.s || 0;
  }

  spendWindow(ms) {
    if (!this.db) return 0;
    const since = Date.now() - ms;
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS s FROM calls WHERE ts >= ?'
    ).get(since);
    return row?.s || 0;
  }

  /** Count recent calls for a session (loop detector). */
  recentSessionCalls(session_id, withinMs) {
    if (!this.db || !session_id) return 0;
    const since = Date.now() - withinMs;
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM calls WHERE session_id = ? AND ts >= ?'
    ).get(session_id, since);
    return row?.n || 0;
  }

  close() {
    if (this.db) try { this.db.close(); } catch {}
    this.db = null;
  }
}

export function defaultLoggerPath(openclawDir) {
  return join(openclawDir, 'observability', 'calls.db');
}
