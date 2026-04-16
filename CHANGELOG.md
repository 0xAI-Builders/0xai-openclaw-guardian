# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0-alpha.1] — 2026-04-15
### Added
- **Optional gateway-token auth** for the dashboard. Opt-in via
  `OBS_ENABLE_AUTH=1`. Reuses `GATEWAY_AUTH_TOKEN` from `~/.openclaw/.env`
  (dotenvx + macOS Keychain) so the dashboard is protected by the same
  credential as the OpenClaw gateway itself. Public `/api/_auth/bootstrap`
  endpoint tells the SPA whether auth is active (no secrets leaked).

## [2.0.0-alpha.0] — 2026-04-15
### Added
- **Multi-provider proxy** covering every Noosphere provider: anthropic,
  openai, openrouter, groq, cerebras, xai, google, ollama, huggingface.
  Each route extracts tokens, pricing, latency, and persists to SQLite.
- **Per-call logger** (`better-sqlite3`) with indexes on ts, provider+model,
  agent_id, session_id. JSONL fallback if sqlite is missing.
- **Kill-switches** (pre-request guards):
  - Global daily / weekly / monthly USD caps
  - Per-agent / per-model / per-provider caps
  - Rate + token caps for zero-cost providers (ollama / local)
  - Loop detector (N calls per session within window)
  - Emergency pause switch with sticky red banner
- **Dashboard** rewritten with six tabs — Spend · Calls · Crons · Limits ·
  Settings · Security. Tooltips on every control in English. Deep-link
  slugs (`#limits/caps`, `#calls/filters`, etc.) with copy-link icons.
- **Calls tab** shows live token counts, API-equivalent cost, billing
  mode (SUB/API badge), user query snippet per row.
- **Crons tab** lists every OpenClaw cron with one-click enable / disable /
  permanent delete.
- **CLI subcommands**: `init` (auto-patches openclaw.json + LaunchAgent on
  macOS), `status`, `limits get | pause | resume`, `help`.
- **Subscription-aware pricing**: every call shows API-equivalent cost even
  for Claude Max subscription. Source: `noosphere` catalog (45+ models)
  merged with a fallback table.

### Fixed
- Dashboard spend tab used to silently skip subscription calls (cost=0).
  Now loads every call with non-zero tokens and prices it at API rates.
- `apiKeyAuth` in consumer apps gets a deterministic `findFirst` with
  `orderBy: createdAt asc` to avoid racing between seed users.

### Changed
- Pricing is now a single source of truth (`pricing.mjs` wraps Noosphere).
  `multi-provider.mjs` and `usage-parser.mjs` no longer carry their own
  hardcoded cost tables.

## [1.0.0] — Historical
### Added
- Original Spend / Settings / Security dashboard reading directly from
  OpenClaw session JSONL files.
- Anthropic-only billing proxy (OAuth rewriting for Claude Max).
