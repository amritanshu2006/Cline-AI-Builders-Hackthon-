import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runPipeline, newState, countPassFail, diffStats } from './pipeline.js';
import { PROJECT_ROOT, MODE } from './cline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = PROJECT_ROOT || path.resolve(here, '..');
const RUNS_ROOT = path.join(ROOT, 'runs');

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '256kb' }));

// Tight CORS: same-origin by default.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim())
    : (origin && req.headers.host && origin.endsWith(':' + req.headers.host)) ? [origin] : [];
  if (allowed.length && (!origin || allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static dashboard
app.use(express.static(path.join(ROOT, 'public')));

let state = newState();
const clients = new Set();
const emit = () => {
  const data = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const r of clients) r.write(data);
};

function validateRunId(id) { return typeof id === 'string' && /^[a-z0-9-]+$/.test(id); }
function findRunDir(id) {
  if (!validateRunId(id)) return null;
  const d = path.join(RUNS_ROOT, id);
  if (!fs.existsSync(d)) return null;
  const rel = path.relative(RUNS_ROOT, d);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return d;
}

app.get('/api/health', (_q, r) => r.json({
  ok: true, mode: state.mode, runMode: MODE, status: state.status,
  provider: state.provider, target: state.target,
}));

app.get('/api/state', (_q, r) => r.json(state));

app.get('/api/events', (q, r) => {
  r.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  r.flushHeaders();
  r.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  clients.add(r);
  q.on('close', () => clients.delete(r));
});

// Start a run
app.post('/api/run', (q, r) => {
  if (state.status === 'running') return r.status(409).json({ error: 'A run is already in progress', mode: state.mode });
  const { target } = q.body || {};
  if (!target) return r.status(400).json({ error: 'target is required' });
  if (!/^(https?:\/\/|git@)/.test(target)) {
    let abs;
    try { abs = path.resolve(target); } catch { return r.status(400).json({ error: 'invalid path' }); }
    if (!fs.existsSync(abs)) return r.status(400).json({ error: 'target path does not exist' });
    if (!fs.statSync(abs).isDirectory()) return r.status(400).json({ error: 'target is not a directory' });
  }
  state = newState();
  runPipeline(q.body || {}, state, emit).catch((e) => {
    state.status = 'error';
    state.error = String(e?.message || e);
    state.finishedAt = new Date().toISOString();
    emit();
  });
  r.json({ ok: true, mode: state.mode });
});

app.get('/api/runs', (_q, r) => {
  if (!fs.existsSync(RUNS_ROOT)) return r.json({ runs: [] });
  const ids = fs.readdirSync(RUNS_ROOT)
    .filter((d) => { try { return fs.statSync(path.join(RUNS_ROOT, d)).isDirectory(); } catch { return false; } })
    .sort((a, b) => Number(b) - Number(a));
  // Enrich with counts.
  const runs = ids.map((id) => {
    const dir = path.join(RUNS_ROOT, id);
    const verified = fs.readdirSync(dir)
      .filter((d) => d.endsWith('-evidence'))
      .length;
    return { id, verified };
  });
  r.json({ runs });
});

app.get('/api/runs/:runId/findings/:findingId/:file', (q, r) => {
  const runDir = findRunDir(q.params.runId);
  if (!runDir) return r.status(400).json({ error: 'invalid runId' });
  if (!validateRunId(q.params.findingId)) return r.status(400).json({ error: 'invalid findingId' });
  const safeFile = path.basename(q.params.file);
  const p = path.join(runDir, `${q.params.findingId}-evidence`, safeFile);
  if (!fs.existsSync(p)) return r.status(404).json({ error: 'not found' });
  r.type('text/plain').send(fs.readFileSync(p, 'utf8'));
});

// Run the exploit in baseline vs fixed copy.
app.post('/api/try-attack', async (q, r) => {
  const { runId, findingId } = q.body || {};
  const runDir = findRunDir(runId);
  if (!runDir) return r.status(400).json({ error: 'invalid runId' });
  if (!validateRunId(findingId)) return r.status(400).json({ error: 'invalid findingId' });
  const baseDir = path.join(runDir, 'base');
  const fixedDir = path.join(runDir, findingId);
  const exploitRel = `patchproof_exploits/${findingId}.test.js`;
  const exploitAbs = path.join(fixedDir, exploitRel);
  if (!fs.existsSync(exploitAbs)) return r.status(404).json({ error: 'exploit test not found' });
  try {
    fs.mkdirSync(path.join(baseDir, 'patchproof_exploits'), { recursive: true });
    fs.copyFileSync(exploitAbs, path.join(baseDir, exploitRel));
    const runJest = async (cwd) => {
      try {
        const o = await execFileAsync('npx', ['jest', '--runInBand', exploitRel], { cwd, maxBuffer: 1024 * 1024 * 10, timeout: 180000 });
        return o.stdout + o.stderr;
      } catch (e) { return (e.stdout || '') + (e.stderr || e.message || ''); }
    };
    const [before, after] = await Promise.all([runJest(baseDir), runJest(fixedDir)]);
    r.json({ before, after });
  } catch (e) { r.status(500).json({ error: String(e?.message || e) }); }
});

// Return safe plan text only (no shell interpolation).
app.post('/api/approve', (q, r) => {
  const { runId, findingId } = q.body || {};
  const runDir = findRunDir(runId);
  if (!runDir) return r.status(400).json({ error: 'invalid runId' });
  if (!validateRunId(findingId)) return r.status(400).json({ error: 'invalid findingId' });
  const branch = `patchproof/${findingId}`;
  const evDir = path.join(runDir, `${findingId}-evidence`);
  const fullPatch = path.join(evDir, 'full.patch');
  if (!fs.existsSync(fullPatch)) return r.status(404).json({ error: 'no patch to apply' });
  const report = path.join(evDir, 'report.md');
  r.json({
    branch, patchPath: fullPatch,
    plan: [
      `git checkout -b ${branch}`,
      `git apply --check ${fullPatch}`,
      `git apply ${fullPatch}`,
      `git add -A`,
      `git commit -m "PatchProof: fix ${findingId}"`,
      fs.existsSync(report) ? `gh pr create --title "Security fix: ${findingId}" --body-file ${report}` : '# (no report.md)',
    ],
  });
});

// Apply a fix to the original target repo with --check first.
app.post('/api/apply', async (q, r) => {
  const { runId, findingId, target } = q.body || {};
  const runDir = findRunDir(runId);
  if (!runDir) return r.status(400).json({ error: 'invalid runId' });
  if (!validateRunId(findingId)) return r.status(400).json({ error: 'invalid findingId' });
  if (!target || !fs.existsSync(target)) return r.status(400).json({ error: 'target path does not exist' });
  const evDir = path.join(runDir, `${findingId}-evidence`);
  const patch = path.join(evDir, 'full.patch');
  if (!fs.existsSync(patch)) return r.status(404).json({ error: 'no patch to apply' });
  try {
    const dry = await execFileAsync('git', ['apply', '--check', patch], { cwd: target });
    if (dry.code) return r.status(400).json({ error: 'patch fails to apply cleanly', details: (dry.stderr || dry.stdout || '').slice(-400) });
    await execFileAsync('git', ['apply', patch], { cwd: target });
    r.json({ ok: true, message: 'Patch applied to ' + target });
  } catch (e) { r.status(500).json({ error: String(e?.message || e) }); }
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`PatchProof dashboard: http://${host}:${port}  (mode=${state.mode})`));
