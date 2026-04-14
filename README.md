# OpenClaw Observability

Real-time cost tracking, security monitoring, and configuration dashboard for [OpenClaw](https://openclaw.ai) AI agent deployments. Reads session JSONL files directly from your `.openclaw` directory, calculates accurate API costs (with correct Google cache handling and Anthropic subscription detection), and serves a Catppuccin-themed Tailwind CSS dashboard with Spend, Settings, and Security tabs.

![Screenshot placeholder](https://via.placeholder.com/1200x600/1e1e2e/fab387?text=OpenClaw+Observability+Dashboard)

## Quick Start

Run directly with npx (no install required):

```bash
npx openclaw-observability
```

Or install globally:

```bash
npm install -g openclaw-observability
openclaw-obs
```

The dashboard will be available at **http://localhost:3847**.

## Configuration

All configuration is via environment variables. No config files required for basic usage.

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_DIR` | `~/.openclaw` | Path to your OpenClaw directory |
| `OBS_PORT` | `3847` | Dashboard server port |
| `OBS_HOST` | `0.0.0.0` | Bind address |
| `OBS_LIMITS_FILE` | `$OPENCLAW_DIR/observability/limits.json` | Path to spend limits config |
| `OBS_BILLING_PROXY_AUTOSTART` | `1` | Start the embedded Anthropic billing proxy on boot when Claude credentials are available |
| `OBS_BILLING_PROXY_PORT` | `18801` | Embedded billing proxy port |
| `OBS_BILLING_PROXY_HOST` | `127.0.0.1` | Embedded billing proxy bind address |
| `OBS_BILLING_PROXY_ROUTE_BASE_URL` | `http://127.0.0.1:$OBS_BILLING_PROXY_PORT` | `baseUrl` written into `models.providers.anthropic.baseUrl` |
| `OBS_BILLING_PROXY_CONFIG` | `$OPENCLAW_DIR/observability/billing-proxy.json` | Optional advanced config file for replacement maps and proxy behavior |
| `ANTHROPIC_COST` | `subscription` | Set to `metered` to track Anthropic costs at API rates |

Example with custom settings:

```bash
OPENCLAW_DIR=/path/to/.openclaw OBS_PORT=8080 openclaw-obs
```

## Embedded Billing Proxy

`openclaw-observability` can now run the `openclaw-billing-proxy` logic internally. The Settings tab exposes:

- Proxy runtime status and Claude credential detection
- Current Anthropic `baseUrl` vs. the local proxy target
- Buttons to start/restart the proxy and apply/remove the Anthropic proxy route

When the proxy route is changed, restart the OpenClaw gateway so the new `baseUrl` takes effect.

## Spend Limits

Copy the example limits file and customize:

```bash
cp node_modules/openclaw-observability/config/limits.example.json ~/.openclaw/observability/limits.json
```

The limits file supports:

- **Global limits** — daily, weekly, and monthly caps across all agents
- **Per-agent limits** — individual daily and monthly caps per agent
- **Per-model limits** — daily caps per model (e.g., limit Opus usage)
- **Warning threshold** — alert at 80% of limit (configurable)
- **Telegram alerts** — optional real-time notifications

```json
{
  "enabled": true,
  "global": {
    "dailyLimit": 10.00,
    "weeklyLimit": 50.00,
    "monthlyLimit": 200.00
  },
  "perAgent": {
    "my-agent": { "dailyLimit": 5.00, "monthlyLimit": 50.00 }
  },
  "actions": {
    "warningThreshold": 0.80
  }
}
```

## Hooks Installation

OpenClaw hooks provide automatic startup, spend monitoring, and model drift protection. Copy the hooks into your OpenClaw hooks directory:

```bash
# Create hook directories
mkdir -p ~/.openclaw/hooks/{observability,spend-guard,model-guard}

# Copy hooks
cp node_modules/openclaw-observability/hooks/observability/handler.ts ~/.openclaw/hooks/observability/
cp node_modules/openclaw-observability/hooks/spend-guard/handler.ts ~/.openclaw/hooks/spend-guard/
cp node_modules/openclaw-observability/hooks/model-guard/handler.ts ~/.openclaw/hooks/model-guard/
```

### Hook descriptions

| Hook | Trigger | What it does |
|---|---|---|
| **observability** | Gateway startup | Launches the dashboard server automatically |
| **spend-guard** | Every message sent | Checks spend against limits, sends alerts on breach |
| **model-guard** | Gateway startup | Cleans stale session overrides that don't match configured models |

## Dashboard Tabs

### Spend Tab

The main view showing:

- **KPI cards** — total real API spend, tokens processed, API call count
- **Daily spend chart** — bar chart of daily costs over time
- **Breakdowns** — by agent, model, source (cron/subagent/telegram/whatsapp/direct)
- **Cron tracking** — cost per scheduled job with execution counts
- **Subagent detail** — costs for spawned sub-tasks with context
- **Recent calls** — live stream of the latest API requests

Click on any agent, model, cron, subagent, or event row for a detailed modal.

### Settings Tab

- **Agent model selector** — change the AI model for each agent
- **Default model** — set the model for new agents
- **Cron toggles** — enable/disable scheduled jobs
- **Gateway restart** — apply model changes without CLI

### Security Tab

Automatic security audit of your OpenClaw deployment:

- **Security score** (0-100) based on weighted findings
- **File permissions** — checks for world-readable secrets
- **Secret storage** — detects plaintext vs. SecretRef (dotenvx encrypted) API keys
- **Network exposure** — gateway binding and auth mode
- **Channel allowlists** — WhatsApp and Telegram access control
- **Token expiry** — flags expired auth profiles
- **dotenvx status** — encryption-at-rest verification

## Pricing Engine

The cost calculator handles provider-specific nuances:

- **Anthropic** — subscription plans show $0 real cost by default (configurable via `ANTHROPIC_COST=metered`)
- **Google** — correct formula: `uncached = input - cacheRead` (avoids the common double-counting bug). Long-context requests (>200K tokens) use the higher pricing tier automatically.
- **Noosphere** — if `@mariozechner/pi-ai` is installed, model pricing is loaded from the Noosphere catalog. Otherwise, fallback pricing is used.

## dotenvx Setup (Advanced)

For production deployments, encrypt your secrets with [dotenvx](https://dotenvx.com):

```bash
# Install dotenvx
brew install dotenvx/brew/dotenvx

# Create encrypted .env in your OpenClaw directory
cd ~/.openclaw
dotenvx set GOOGLE_API_KEY "your-key-here"
dotenvx set TELEGRAM_BOT_TOKEN "your-token-here"

# Move the private key to macOS Keychain (remove from disk)
security add-generic-password -a "$USER" -s "openclaw-dotenvx" -w "$(cat .env.keys)"
rm .env.keys
```

Then reference secrets in `openclaw.json` using SecretRef objects instead of plaintext strings:

```json
{
  "models": {
    "providers": {
      "google": {
        "apiKey": { "source": "dotenvx", "key": "GOOGLE_API_KEY" }
      }
    }
  }
}
```

The Security tab will show green checks for all SecretRef-backed values.

## License

MIT
