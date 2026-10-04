/**
 * Cline SDK wrapper. Real @cline/sdk (ClineCore) is the DEFAULT path.
 * Replay is opt-in via PP_REPLAY=1 and labelled honestly in the dashboard,
 * CLI log, and every evidence report.
 *
 * Env:
 *   PP_PROVIDER     provider id (must match a BUILT_IN_PROVIDER enum value
 *                   in @cline/llms, e.g. "anthropic", "openai-native",
 *                   "openai-compatible", "openrouter", "cline"). Note:
 *                   "openai" is NOT valid – use "openai-native".
 *   PP_MODEL        model id (e.g. "claude-sonnet-4-5", "gpt-4o-mini",
 *                   "anthropic/claude-3.5-sonnet" for OpenRouter).
 *   PP_API_KEY      API key. Not needed for "cline" provider (Cline credits
 *                   are billed separately).
 *   PP_REPLAY=1     force the opt-in replay mode
 *   PP_AGENT_TIMEOUT_MS  per-session timeout, default 180000
 *   PP_VERBOSE=1    print every Cline SDK event to stderr
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayAgent, replayExplain } from './replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const TIMEOUT = Number(process.env.PP_AGENT_TIMEOUT_MS ?? 180_000);

let core = null;
let sink = () => {};

/** Dashboard / CLI installs a sink to receive short log lines per agent event. */
export const setSink = (fn) => { sink = typeof fn === 'function' ? fn : () => {}; };

/** Read provider / model / key from env. Throws clear errors when missing. */
function readCreds() {
  const providerId = process.env.PP_PROVIDER;
  const modelId = process.env.PP_MODEL;
  const apiKey = process.env.PP_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
  const errors = [];
  if (!providerId) errors.push('PP_PROVIDER');
  if (!modelId) errors.push('PP_MODEL');
  // PP_API_KEY is only required for non-cline providers
  if (!apiKey && providerId && providerId !== 'cline') errors.push('PP_API_KEY');
  if (errors.length) {
    throw new Error(
      `PatchProof: missing ${errors.join(', ')} in .env. ` +
      `Copy .env.example to .env and fill in your provider, model, and (if needed) API key.`
    );
  }
  return { providerId, modelId, apiKey };
}

/** Returns a one-line description of an interesting agent event, or null. */
function describe(ev) {
  if (ev?.type === 'agent_event') {
    const e = ev.payload?.event;
    if (e?.type === 'content_start' && e.contentType === 'tool') {
      return `tool: ${e.toolName || 'unnamed'}` +
        (e.input && typeof e.input === 'object' ? ' ' + JSON.stringify(e.input).slice(0, 80) : '');
    }
    if (e?.type === 'iteration_start') return `iteration ${e.iteration}`;
    if (e?.type === 'error') return 'agent error: ' + (e.error?.message || 'unknown').slice(0, 200);
  }
  return null;
}

async function getCore(creds) {
  if (core) return core;
  const { ClineCore } = await import('@cline/sdk');
  core = await ClineCore.create({ clientName: 'patchproof', backendMode: 'local' });
  core.subscribe((ev) => {
    const d = describe(ev);
    if (d) sink(d);
    if (process.env.PP_VERBOSE) {
      try {
        const summary = JSON.stringify(ev).slice(0, 240);
        process.stderr.write('[cline] ' + summary + '\n');
      } catch {}
    }
  });
  return core;
}

const isReplay = () => process.env.PP_REPLAY === '1';

/**
 * Run the agent on a sandboxed copy of a repo.
 *  - default: real Cline SDK (calls LLM)
 *  - PP_REPLAY=1: replay mode (offline pattern-based, clearly labelled)
 *
 * Returns { sessionId, finishReason, iterations, text, error? }.
 * Throws on real failure so the orchestrator can mark `ok: false`.
 */
export async function runAgent(cwd, prompt, sessionId) {
  if (isReplay()) {
    sink('[mode] REPLAY (pre-recorded, no AI)');
    const id = await replayAgent(cwd, prompt, sessionId, sink);
    return { sessionId: id, finishReason: 'completed', iterations: 0, replay: true };
  }
  sink('[mode] REAL Cline SDK');
  const creds = readCreds();
  const c = await getCore(creds);

  // Subscribe to events from this session only – we already subscribed in
  // getCore() for global events; here we just record the final result.
  // If sessionId is supplied (retry), we send a follow-up turn instead.
  if (sessionId) {
    sink('[cline] continuing session ' + sessionId);
    const result = await c.runTurn({ sessionId, prompt });
    const err = result?.finishReason === 'error' ? result?.text : null;
    sink('[cline] turn finished: ' + (result?.finishReason || 'unknown') + ' (' + (result?.iterations || 0) + ' iter)');
    if (err) throw new Error(err);
    return { sessionId, finishReason: result?.finishReason, iterations: result?.iterations, text: result?.text };
  }

  // Fresh session. start() runs the first turn and returns the AgentResult inline.
  sink('[cline] starting session in ' + cwd);
  let result;
  try {
    result = await c.start({
      config: {
        providerId: creds.providerId,
        modelId: creds.modelId,
        apiKey: creds.apiKey,
        cwd,
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
      },
      source: 'cline-sdk',
      prompt,
    });
  } catch (e) {
    // Real error from the SDK – propagate to the orchestrator.
    sink('[cline] start failed: ' + (e?.message || String(e)).slice(0, 200));
    throw e;
  }
  const ar = result?.result;
  const reason = ar?.finishReason || 'unknown';
  sink('[cline] session ' + reason + ' (' + (ar?.iterations ?? 0) + ' iter)');
  if (reason === 'error' || !ar) {
    throw new Error(ar?.text?.slice(0, 600) || 'Cline session failed without a result');
  }
  return { sessionId: result.sessionId, finishReason: reason, iterations: ar.iterations, text: ar.text };
}

/**
 * Plain-language explanation of what the fix changed.
 * Used in evidence reports so non-experts can read them.
 */
export async function explain(finding, diff) {
  if (isReplay()) return replayExplain(finding);
  return [
    `Finding: ${finding.title || finding.id}`,
    finding.description ? `Description: ${String(finding.description).slice(0, 280)}` : null,
    `Severity: ${finding.severity || 'unknown'}`,
    `Tool: ${finding.tool || 'n/a'}`,
    '',
    'What changed: see the unified diff below. The patch was generated by the real Cline SDK',
    'and only accepted after (a) an exploit test that failed before the fix started passing,',
    'and (b) every existing test in the suite still passed.',
  ].filter(Boolean).join('\n');
}

/** Best-effort cleanup. Errors swallowed – the run is already done. */
export async function shutdown() {
  if (core) {
    try { await core.dispose?.('done'); } catch {}
    core = null;
  }
}

// Used elsewhere to resolve paths without hardcoding /home/amritanshu-kumar.
export const PROJECT_ROOT = ROOT;

// Exposed so other modules can check the mode without re-implementing.
export const MODE = isReplay() ? 'replay' : 'real';
