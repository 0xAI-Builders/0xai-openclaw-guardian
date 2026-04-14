/**
 * OpenClaw Spend Guard Hook
 *
 * Monitors API spend against configurable limits and sends alerts
 * (console + optional Telegram) when thresholds are crossed.
 *
 * Configuration:
 *   OPENCLAW_DIR   - path to .openclaw directory (default: ~/.openclaw)
 *   OBS_LIMITS_FILE - path to limits.json (default: $OPENCLAW_DIR/observability/limits.json)
 *
 * Limits file format: see config/limits.example.json
 */

import { homedir } from "node:os";
import { join } from "node:path";

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(homedir(), ".openclaw");
const LIMITS_PATH  = process.env.OBS_LIMITS_FILE || join(OPENCLAW_DIR, "observability", "limits.json");
const AGENTS_DIR   = join(OPENCLAW_DIR, "agents");
const CONFIG_FILE  = join(OPENCLAW_DIR, "openclaw.json");
const STATE_PATH   = "/tmp/spend-guard-state.json";

const handler = async (event: any) => {
  if (event.type !== "message" || event.action !== "sent") return;

  const fs = await import("node:fs");
  const path = await import("node:path");

  // Load limits config
  let limits: any;
  try {
    limits = JSON.parse(fs.readFileSync(LIMITS_PATH, "utf-8"));
  } catch {
    return; // No config = no enforcement
  }
  if (!limits.enabled) return;

  // Load alert state (to avoid spamming)
  let state: any = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {}

  const today = new Date().toISOString().slice(0, 10);
  if (state.date !== today) {
    state = { date: today, alerted: {} };
  }

  // Calculate current spend by scanning session files
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const spend = {
    global: { daily: 0, weekly: 0, monthly: 0 },
    agents: {} as Record<string, { daily: number; weekly: number; monthly: number }>,
    models: {} as Record<string, { daily: number }>,
  };

  // Scan all active session files
  let agentDirs: string[];
  try {
    agentDirs = fs.readdirSync(AGENTS_DIR);
  } catch {
    return;
  }

  for (const agentId of agentDirs) {
    const sessDir = path.join(AGENTS_DIR, agentId, "sessions");
    if (!fs.existsSync(sessDir)) continue;
    spend.agents[agentId] = { daily: 0, weekly: 0, monthly: 0 };

    let files: string[];
    try {
      files = fs.readdirSync(sessDir).filter((f: string) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(sessDir, file);

      // Only scan recently modified files (last 31 days)
      try {
        const stat = fs.statSync(filePath);
        if (now.getTime() - stat.mtimeMs > 31 * 86400000) continue;
      } catch {
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const cost = entry?.message?.usage?.cost?.total;
          const ts = entry?.timestamp;
          const model = entry?.message?.model || "";
          if (!cost || !ts || cost <= 0) continue;

          // Skip internal non-AI entries
          if (["delivery-mirror", "gateway-injected", ""].includes(model)) continue;

          const dt = new Date(ts);

          if (dt >= monthStart) {
            spend.global.monthly += cost;
            spend.agents[agentId].monthly += cost;
          }
          if (dt >= weekStart) {
            spend.global.weekly += cost;
            spend.agents[agentId].weekly += cost;
          }
          if (dt >= todayStart) {
            spend.global.daily += cost;
            spend.agents[agentId].daily += cost;

            if (!spend.models[model]) spend.models[model] = { daily: 0 };
            spend.models[model].daily += cost;
          }
        } catch {}
      }
    }
  }

  // Check limits and alert
  const warnings: string[] = [];
  const breaches: string[] = [];
  const threshold = limits.actions?.warningThreshold || 0.8;

  // Global limits
  const g = limits.global || {};
  if (g.dailyLimit && spend.global.daily >= g.dailyLimit) {
    breaches.push(`GLOBAL daily: $${spend.global.daily.toFixed(2)} / $${g.dailyLimit}`);
  } else if (g.dailyLimit && spend.global.daily >= g.dailyLimit * threshold) {
    warnings.push(`Global daily at ${((spend.global.daily / g.dailyLimit) * 100).toFixed(0)}%: $${spend.global.daily.toFixed(2)} / $${g.dailyLimit}`);
  }
  if (g.weeklyLimit && spend.global.weekly >= g.weeklyLimit) {
    breaches.push(`GLOBAL weekly: $${spend.global.weekly.toFixed(2)} / $${g.weeklyLimit}`);
  } else if (g.weeklyLimit && spend.global.weekly >= g.weeklyLimit * threshold) {
    warnings.push(`Global weekly at ${((spend.global.weekly / g.weeklyLimit) * 100).toFixed(0)}%: $${spend.global.weekly.toFixed(2)} / $${g.weeklyLimit}`);
  }
  if (g.monthlyLimit && spend.global.monthly >= g.monthlyLimit) {
    breaches.push(`GLOBAL monthly: $${spend.global.monthly.toFixed(2)} / $${g.monthlyLimit}`);
  } else if (g.monthlyLimit && spend.global.monthly >= g.monthlyLimit * threshold) {
    warnings.push(`Global monthly at ${((spend.global.monthly / g.monthlyLimit) * 100).toFixed(0)}%: $${spend.global.monthly.toFixed(2)} / $${g.monthlyLimit}`);
  }

  // Per-agent limits
  for (const [agentId, agentLimits] of Object.entries(limits.perAgent || {}) as [string, any][]) {
    const as = spend.agents[agentId];
    if (!as) continue;
    if (agentLimits.dailyLimit && as.daily >= agentLimits.dailyLimit) {
      breaches.push(`${agentId} daily: $${as.daily.toFixed(2)} / $${agentLimits.dailyLimit}`);
    } else if (agentLimits.dailyLimit && as.daily >= agentLimits.dailyLimit * threshold) {
      warnings.push(`${agentId} daily at ${((as.daily / agentLimits.dailyLimit) * 100).toFixed(0)}%`);
    }
    if (agentLimits.monthlyLimit && as.monthly >= agentLimits.monthlyLimit) {
      breaches.push(`${agentId} monthly: $${as.monthly.toFixed(2)} / $${agentLimits.monthlyLimit}`);
    } else if (agentLimits.monthlyLimit && as.monthly >= agentLimits.monthlyLimit * threshold) {
      warnings.push(`${agentId} monthly at ${((as.monthly / agentLimits.monthlyLimit) * 100).toFixed(0)}%`);
    }
  }

  // Per-model limits
  for (const [model, modelLimits] of Object.entries(limits.perModel || {}) as [string, any][]) {
    const ms = spend.models[model];
    if (!ms) continue;
    if (modelLimits.dailyLimit && ms.daily >= modelLimits.dailyLimit) {
      breaches.push(`Model ${model} daily: $${ms.daily.toFixed(2)} / $${modelLimits.dailyLimit}`);
    }
  }

  if (breaches.length === 0 && warnings.length === 0) return;

  // Build alert message
  let msg = "";
  if (breaches.length > 0) {
    msg += "SPEND LIMIT BREACHED:\n" + breaches.map((b) => `  - ${b}`).join("\n");
  }
  if (warnings.length > 0) {
    msg += (msg ? "\n\n" : "") + "SPEND WARNING:\n" + warnings.map((w) => `  - ${w}`).join("\n");
  }
  msg += `\n\nToday: $${spend.global.daily.toFixed(2)} | Week: $${spend.global.weekly.toFixed(2)} | Month: $${spend.global.monthly.toFixed(2)}`;

  // Deduplicate alerts (1 per unique breach set per day)
  const alertKey = JSON.stringify([...breaches, ...warnings].sort());
  if (state.alerted[alertKey]) return;
  state.alerted[alertKey] = Date.now();

  // Save state
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch {}

  console.log(`[spend-guard] ${msg}`);

  // Send Telegram alert if configured
  if (limits.alerts?.telegram) {
    try {
      const configRaw = fs.readFileSync(CONFIG_FILE, "utf-8");
      const config = JSON.parse(configRaw);
      const botToken = config?.channels?.telegram?.accounts?.default?.botToken;
      const chatId = limits.alerts.telegramChatId;

      if (botToken && chatId) {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: msg,
            parse_mode: "Markdown",
          }),
        });
        console.log("[spend-guard] Telegram alert sent");
      }
    } catch (err) {
      console.error("[spend-guard] Telegram alert failed:", err instanceof Error ? err.message : String(err));
    }
  }
};

export default handler;
