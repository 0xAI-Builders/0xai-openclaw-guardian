#!/usr/bin/env node
/**
 * OpenClaw Observability CLI Entry Point
 *
 * Starts the observability dashboard server.
 * Configurable via environment variables:
 *   OPENCLAW_DIR  - path to .openclaw directory (default: ~/.openclaw)
 *   OBS_PORT      - server port (default: 3847)
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Forward to the server module
await import(join(__dirname, '..', 'src', 'server.mjs'));
