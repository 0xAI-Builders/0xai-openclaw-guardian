/**
 * OpenClaw Model Guard Hook — Gateway Startup
 *
 * Cleans stale session overrides that don't match each agent's configured model.
 * This prevents sessions from using an expensive model after an agent's model
 * has been changed to a cheaper one.
 *
 * Configuration:
 *   OPENCLAW_DIR - path to .openclaw directory (default: ~/.openclaw)
 */

import { homedir } from "node:os";
import { join } from "node:path";

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(homedir(), ".openclaw");
const AGENTS_DIR   = join(OPENCLAW_DIR, "agents");
const CONFIG_FILE  = join(OPENCLAW_DIR, "openclaw.json");

const handler = async (event: any) => {
  if (event.type !== "gateway" || event.action !== "startup") return;

  const fs = await import("node:fs");
  const path = await import("node:path");

  // Load agent -> model mapping from config
  let agentModels: Record<string, string> = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const defaultModel = cfg?.agents?.defaults?.model?.primary || "";
    for (const a of cfg?.agents?.list || []) {
      agentModels[a.id] = a.model || defaultModel;
    }
  } catch {
    return;
  }

  let totalCleaned = 0;

  for (const agentId of Object.keys(agentModels)) {
    const intended = agentModels[agentId];
    const intendedProvider = intended.split("/")[0];
    const sessFile = path.join(AGENTS_DIR, agentId, "sessions", "sessions.json");

    try {
      const raw = fs.readFileSync(sessFile, "utf-8");
      const sessions = JSON.parse(raw);
      let changed = false;

      for (const key of Object.keys(sessions)) {
        const s = sessions[key];

        // Clean auth profile overrides that point to a different provider
        if (s.authProfileOverride) {
          const overrideProvider = s.authProfileOverride.split(":")[0];
          if (overrideProvider !== intendedProvider) {
            delete s.authProfileOverride;
            delete s.authProfileOverrideSource;
            delete s.authProfileOverrideCompactionCount;
            changed = true;
            totalCleaned++;
          }
        }

        // Clean model overrides that point to a different provider
        if (s.modelOverride) {
          const overrideProvider = s.modelOverride.includes("claude") ? "anthropic" :
                                  s.modelOverride.includes("gemini") ? "google" : "unknown";
          if (overrideProvider !== intendedProvider) {
            delete s.modelOverride;
            changed = true;
            totalCleaned++;
          }
        }
      }

      if (changed) {
        fs.writeFileSync(sessFile, JSON.stringify(sessions, null, 2));
      }
    } catch {}
  }

  if (totalCleaned > 0) {
    console.log(`[model-guard] Cleaned ${totalCleaned} stale session overrides`);
  } else {
    console.log("[model-guard] All sessions match configured models");
  }
};

export default handler;
