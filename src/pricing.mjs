/**
 * OpenClaw Observability — Pricing Engine
 *
 * Calculates real API costs from token usage data.
 *
 * Key design decisions:
 *   - All providers are metered — subscription or API, cost is always tracked
 *   - Google pricing uses the correct formula: uncached = input - cacheRead
 *     (avoids the common double-counting bug)
 *   - Long-context Google requests (>200K tokens) use higher pricing tier
 *   - Noosphere model catalog is loaded dynamically when available
 */

// ---------------------------------------------------------------------------
// Fallback pricing table (per million tokens)
// ---------------------------------------------------------------------------
const FALLBACK_PRICING = {
  'gemini-3.1-pro-preview':            { input: 1.25, output: 10,   cacheRead: 0.315  },
  'gemini-3.1-pro-preview-customtools': { input: 1.25, output: 10,   cacheRead: 0.315  },
  'gemini-3-flash-preview':            { input: 0.15, output: 0.6,  cacheRead: 0.0375 },
  'gemini-2.5-pro':                    { input: 1.25, output: 10,   cacheRead: 0.315  },
  'gemini-2.5-flash':                  { input: 0.15, output: 0.6,  cacheRead: 0.0375 },
  'claude-sonnet-4-6':                 { input: 3,    output: 15,   cacheRead: 0.3    },
  'claude-opus-4-6':                   { input: 15,   output: 75,   cacheRead: 1.5    },
  'claude-haiku-4-5':                  { input: 0.80, output: 4,    cacheRead: 0.08   },
};

// ---------------------------------------------------------------------------
// Load Noosphere / pi-ai model catalog if available
// ---------------------------------------------------------------------------
let PRICING = {};

export async function initPricing() {
  try {
    const { MODELS } = await import('@mariozechner/pi-ai/dist/models.generated.js');
    for (const [, models] of Object.entries(MODELS)) {
      for (const [id, m] of Object.entries(models)) {
        if (m.cost) PRICING[id] = m.cost;
      }
    }
  } catch {
    // Noosphere / pi-ai not installed — use fallback only
  }

  // Merge fallback pricing (fallback values do not override Noosphere data)
  for (const [id, cost] of Object.entries(FALLBACK_PRICING)) {
    if (!PRICING[id]) PRICING[id] = cost;
  }

  // Build available models list
  await syncAvailableModels();

  return PRICING;
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the real API cost for a single request.
 * All providers are metered — subscription or not, the cost is tracked.
 *
 * @param {string}  provider   - 'google', 'anthropic', 'openai', etc.
 * @param {string}  model      - model identifier (e.g. 'gemini-2.5-pro')
 * @param {object}  tokens     - { input, output, cacheRead, total }
 * @returns {number} cost in USD
 */
export function calcCost(provider, model, tokens) {
  // Google: correct calculation that avoids double-counting cached tokens
  if (provider === 'google') {
    const uncached = Math.max((tokens.input || 0) - (tokens.cacheRead || 0), 0);
    const isLongContext = (tokens.total || 0) > 200_000;
    const tier = isLongContext
      ? { i: 2.50, o: 15,  c: 0.63  }
      : { i: 1.25, o: 10,  c: 0.315 };

    return (
      (uncached           / 1e6 * tier.i) +
      ((tokens.output || 0)    / 1e6 * tier.o) +
      ((tokens.cacheRead || 0) / 1e6 * tier.c)
    );
  }

  // Anthropic: use pricing table with cache-aware calculation
  if (provider === 'anthropic') {
    const p = PRICING[model];
    if (!p) return 0;
    const inp = (tokens.input || 0) / 1e6 * p.input;
    const out = (tokens.output || 0) / 1e6 * p.output;
    const cr  = (tokens.cacheRead || 0) / 1e6 * (p.cacheRead || 0);
    const cw  = (tokens.cacheWrite || 0) / 1e6 * (p.cacheWrite || p.input * 1.25 || 0);
    return inp + out + cr + cw;
  }

  // Generic: look up pricing table
  const p = PRICING[model];
  if (!p) return 0;
  return (
    ((tokens.input  || 0) / 1e6 * p.input) +
    ((tokens.output || 0) / 1e6 * p.output)
  );
}

// ---------------------------------------------------------------------------
// Available model catalog (for the Settings tab)
// Dynamically built from Noosphere + Noosphere sync + fallbacks
// ---------------------------------------------------------------------------
export let AVAILABLE_MODELS = [];

export async function syncAvailableModels() {
  const models = [];
  const seen = new Set();

  // 1. Static pi-ai catalog (fast, has pricing)
  for (const [id, cost] of Object.entries(PRICING)) {
    const provider = id.includes('claude') || id.includes('haiku') ? 'anthropic'
                   : id.includes('gemini') ? 'google'
                   : id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4') ? 'openai'
                   : id.includes('grok') ? 'xai'
                   : id.includes('llama') || id.includes('mixtral') ? 'groq'
                   : 'other';
    const costStr = cost.input !== undefined
      ? `$${cost.input}/$${cost.output} per M`
      : '';
    if (!seen.has(id)) {
      models.push({ id: `${provider}/${id}`, name: id, provider, cost: costStr, inputCost: cost.input, outputCost: cost.output });
      seen.add(id);
    }
  }

  // 2. Noosphere dynamic sync (discovers newest models from provider APIs)
  try {
    const { Noosphere } = await import('noosphere');
    const ns = new Noosphere({
      keys: {
        google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
        anthropic: process.env.ANTHROPIC_API_KEY || '',
        openai: process.env.OPENAI_API_KEY || '',
      },
    });
    await ns.syncModels('llm');
    const llmModels = await ns.getModels('llm');
    for (const m of llmModels) {
      const fullId = `${m.provider === 'pi-ai' ? (m.id.includes('claude') ? 'anthropic' : m.id.includes('gemini') ? 'google' : m.id.includes('gpt') || m.id.includes('o1') || m.id.includes('o3') || m.id.includes('o4') ? 'openai' : m.id.includes('grok') ? 'xai' : 'other') : m.provider}/${m.id}`;
      if (!seen.has(m.id)) {
        const costStr = m.cost?.price ? `$${m.cost.price} per M` : '';
        models.push({ id: fullId, name: m.name || m.id, provider: fullId.split('/')[0], cost: costStr, inputCost: m.cost?.price, outputCost: m.cost?.price ? m.cost.price * 4 : 0 });
        seen.add(m.id);
      }
    }
    console.log(`[observability] Synced ${llmModels.length} models from Noosphere`);
  } catch (e) {
    console.log(`[observability] Noosphere sync skipped: ${e.message}`);
  }

  // Sort: Google first, then Anthropic, then others. Within each, by name.
  const provOrder = { google: 0, anthropic: 1, openai: 2, xai: 3, groq: 4 };
  models.sort((a, b) => {
    const pa = provOrder[a.provider] ?? 99;
    const pb = provOrder[b.provider] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  AVAILABLE_MODELS = models;
  console.log(`[observability] ${AVAILABLE_MODELS.length} models available for selection`);
  return AVAILABLE_MODELS;
}
