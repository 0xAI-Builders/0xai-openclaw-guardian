/**
 * OpenClaw Observability Hook — Gateway Startup
 *
 * Launches the observability dashboard server when the OpenClaw gateway starts.
 *
 * Configuration:
 *   Set OPENCLAW_DIR and OBS_PORT env vars to override defaults.
 *   Set DASHBOARD_BIN to the path of the openclaw-obs CLI if not in PATH.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || join(homedir(), ".openclaw");
const DASHBOARD_PORT = parseInt(process.env.OBS_PORT || "3847", 10);
const DASHBOARD_DIR = join(OPENCLAW_DIR, "observability");
const DASHBOARD_PID_FILE = "/tmp/openclaw-dashboard.pid";
const DASHBOARD_LOG = "/tmp/openclaw-dashboard.log";

const handler = async (event: any) => {
  if (event.type !== "gateway" || event.action !== "startup") return;

  console.log("[observability] Gateway startup detected — launching dashboard...");

  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");

  // Check if dashboard already running
  try {
    const r = await fetch(`http://localhost:${DASHBOARD_PORT}/api/dashboard`, {
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) {
      console.log(`[observability] Dashboard already running on port ${DASHBOARD_PORT}`);
      return;
    }
  } catch {
    // Not running, start it
  }

  // Kill stale process
  try {
    if (fs.existsSync(DASHBOARD_PID_FILE)) {
      const oldPid = fs.readFileSync(DASHBOARD_PID_FILE, "utf-8").trim();
      try { process.kill(Number(oldPid)); } catch {}
      fs.unlinkSync(DASHBOARD_PID_FILE);
    }
  } catch {}

  // Start the dashboard server
  // Prefer the globally-installed CLI; fall back to running server.mjs directly
  const serverPath = process.env.DASHBOARD_BIN || join(DASHBOARD_DIR, "server.mjs");
  const dashboard = spawn("node", [serverPath], {
    cwd: DASHBOARD_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      OPENCLAW_DIR,
      OBS_PORT: String(DASHBOARD_PORT),
    },
  });

  if (dashboard.pid) {
    fs.writeFileSync(DASHBOARD_PID_FILE, String(dashboard.pid));
  }

  const dashLog = fs.createWriteStream(DASHBOARD_LOG, { flags: "a" });
  dashboard.stdout?.pipe(dashLog);
  dashboard.stderr?.pipe(dashLog);
  dashboard.unref();

  console.log(`[observability] Dashboard started (PID: ${dashboard.pid})`);
  console.log(`[observability] http://localhost:${DASHBOARD_PORT}`);
};

export default handler;
