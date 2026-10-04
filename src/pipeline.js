import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './util.js';
import { scan } from './scanner.js';
import { prepareBase, cloneFor, commitAll, changedFiles, restore, stagedDiff, head, GIT } from './workspace.js';
import { runAgent, explain, setSink, MODE } from './cline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPLOITS = 'patchproof_exploits';
const MAX_ATTEMPTS = 3;
const tail = (s, n = 2500) => (s.length > n ? '...' + s.slice(-n) : s);

/** Returns { framework: 'jest'|'node:test', testFilePattern, testPath, runExploitCmd } */
function detectTestFramework(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (all.jest) {
    return {
      framework: 'jest',
      runner: 'jest',
      testFileGlob: '**/__tests__/**/*.test.{js,ts}',
      runExploitCmd: (exploitRel) => `npx jest --runInBand --testPathPattern="${exploitRel.replace(/\//g, '\\/')}"`,
    };
  }
  if (pkg.scripts?.test?.includes('node --test') || all.supertest) {
    return {
      framework: 'node:test',
      runner: 'node --test',
      testFileGlob: '**/*.test.{js,ts}',
      runExploitCmd: (exploitRel) => `node --test ${exploitRel}`,
    };
  }
  // Fallback: jest
  return {
    framework: 'jest',
    runner: 'jest',
    testFileGlob: '**/__tests__/**/*.test.{js,ts}',
    runExploitCmd: (exploitRel) => `npx jest --runInBand ${exploitRel}`,
  };
}

const isReplay = () => MODE === 'replay';

// Files the agent must never touch: tests + the exploit test file.
const isProtected = (p) =>
  p.startsWith(EXPLOITS + '/') || /(^|\/)(tests?|__tests__)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p);

// Treat a Jest failure as a real assertion, not a setup / syntax / import error.
function isGenuineAssertionFailure(out) {
  const s = String(out || '');
  if (/SyntaxError|Cannot find module|MODULE_NOT_FOUND|Test Suites: 0|No tests found|TypeError: .* is not a function/.test(s)) return false;
  if (/FAIL .*\bexpect\(|Expected|Received|AssertionError|\bexpect\([^)]*\)/.test(s)) return true;
  return false;
}

// De-duplicate findings on (file, line) keeping the highest severity.
function dedupeFindings(list) {
  const RANK = { CRITICAL: 4, HIGH: 3, ERROR: 3, MODERATE: 2, MEDIUM: 2, WARNING: 2, LOW: 1, INFO: 1 };
  const rank = (s) => RANK[String(s || '').toUpperCase()] ?? 0;
  const seen = new Map();
  for (const f of list) {
    const key = `${f.file || f.package || '?'}:${f.line || 0}`;
    if (!seen.has(key) || rank(seen.get(key).severity) < rank(f.severity)) seen.set(key, f);
  }
  return [...seen.values()];
}

// Process code findings first, dependency findings second.
function prioritize(list) {
  const code = list.filter((f) => f.kind !== 'dependency');
  const dep = list.filter((f) => f.kind === 'dependency');
  return [...code, ...dep];
}

// Format a duration like "12.3s" / "1m 04s".
function fmtDur(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export const newState = () => ({
  status: 'idle',
  mode: isReplay() ? 'REPLAY (pre-recorded, no AI)' : 'REAL Cline SDK',
  provider: { id: process.env.PP_PROVIDER || '', model: process.env.PP_MODEL || '' },
  target: null,
  startedAt: null,
  finishedAt: null,
  logs: [],
  findings: [],
  summary: null,
  error: null,
  runId: null,
});

function buildPrompts(f, exploit, framework, testCmd, extraContext = '') {
  const ctx = extraContext ? `\n\nPrevious attempt feedback:\n${extraContext}` : '';
  if (f.kind === 'dependency') {
    return {
      reproduce: null,
      fix: `Fix the vulnerable dependency "${f.package}". Finding: ${f.description}\nUpdate package.json (and the lockfile) to a patched version, run \`npm install\`, then run \`${testCmd}\`.\nRun \`npm audit\` and confirm "${f.package}" is no longer reported. Do not modify tests. Finish with a one-line summary.${ctx}`,
    };
  }
  const testFraming = framework === 'jest'
    ? 'Write ONE test file using Jest (require supertest for HTTP). The file MUST live at the path below.'
    : 'Write ONE test file using node:test and node:assert. The file MUST live at the path below.';
  const runCmd = framework === 'jest'
    ? `npx jest --runInBand ${exploit}`
    : `node --test ${exploit}`;
  return {
    reproduce: `Security finding to reproduce:
${JSON.stringify(f, null, 2)}

${testFraming}
Path: ${exploit}
The test must FAIL on the current vulnerable code because of this issue, and PASS once the issue is fixed.
Exercise the real code path (for example start the app on an ephemeral port and send a malicious request, or import the function and call it).
Do NOT modify any application source or existing test in this step.
Run \`${runCmd}\` and confirm it fails because of the vulnerability (not because of a syntax or import error).
End your reply with the line: TEST_FILE: ${exploit}${ctx}`,
    fix: `Now fix the vulnerability in the application source with the smallest safe change.
Rules: do not modify, delete or skip any test file, and do not touch ${EXPLOITS}/. Avoid adding dependencies.
Then run \`${runCmd}\` and \`${testCmd}\`. Both must pass. Finish with a one-line summary.${ctx}`,
  };
}

async function proof(dir, f, exploit, framework) {
  if (f.kind === 'dependency') {
    const r = await sh('npm audit --json', { cwd: dir, timeout: 120000 });
    let present = true;
    try { present = !!JSON.parse(r.stdout).vulnerabilities?.[f.package]; } catch { /* keep true */ }
    return { pass: !present, out: present ? `npm audit still reports ${f.package}` : `npm audit no longer reports ${f.package}` };
  }
  const cmd = framework === 'jest' ? `npx jest --runInBand ${exploit}` : `node --test ${exploit}`;
  const r = await sh(cmd, { cwd: dir });
  return { pass: r.code === 0, out: r.out };
}

export async function runPipeline({ target, testCmd = 'npm test', maxFindings = 3, findingsFile, apply = false }, state, emit) {
  const log = (m) => { state.logs.push(`${new Date().toLocaleTimeString()}  ${m}`); emit(); };
  const set = (f, patch) => { Object.assign(f, patch); emit(); };
  setSink((m) => log('   agent> ' + m));
  state.status = 'running';
  state.target = target;
  state.startedAt = new Date().toISOString();
  emit();

  const runId = String(Date.now());
  state.runId = runId;
  const runDir = path.join(ROOT, 'runs', runId);

  try {
    log(`Mode: ${state.mode}`);
    log(`Provider: ${state.provider.id || '?'} / ${state.provider.model || '?'}`);
    log(`Preparing sandbox copy of ${target}`);
    const base = await prepareBase(target, runDir, log);

    // Detect the test framework so we can build correct prompts + commands.
    const fw = detectTestFramework(base);
    log(`Test framework: ${fw?.framework || 'unknown'}`);

    log(`Baseline test suite: ${testCmd}`);
    const b = await sh(testCmd, { cwd: base, timeout: 300000 });
    if (b.code !== 0) throw new Error('Baseline test suite already fails, so fixes cannot be verified.\n' + tail(b.out, 800));
    log('Baseline passes. Scanning...');
    const all = dedupeFindings(await scan(base, { findingsFile }));
    const ordered = prioritize(all);
    const list = ordered.slice(0, Number(maxFindings));
    state.findings = list.map((f) => ({
      ...f, status: 'queued', attempts: 0, startedAt: null, finishedAt: null,
      elapsedMs: 0, evidence: null, reason: null,
    }));
    log(`${all.length} finding(s) found, processing top ${list.length}`);

    for (const f of state.findings) {
      try { await processFinding(f, fw); }
      catch (e) { set(f, { status: 'failed', reason: String(e?.message || e), finishedAt: new Date().toISOString() }); log(`  ${f.id}: FAILED: ${f.reason}`); }
    }
    const n = state.findings.filter((f) => f.status === 'verified').length;
    state.summary = `${n} of ${state.findings.length} findings fixed and verified. Evidence saved in ${runDir}`;
    log(state.summary);
    state.status = 'done';
    state.finishedAt = new Date().toISOString();
  } catch (e) {
    state.status = 'error';
    state.error = String(e?.message || e);
    log('ERROR: ' + state.error);
    state.finishedAt = new Date().toISOString();
  }
  emit();

  async function processFinding(f, fw) {
    const startedAt = Date.now();
    set(f, { status: 'reproducing', startedAt: new Date(startedAt).toISOString(), attempts: 0 });
    log(`[${f.id}] ${f.severity || ''}: ${f.title}  (kind=${f.kind || 'code'})`);
    const dir = cloneFor(path.join(runDir, 'base'), path.join(runDir, f.id));
    const evDir = path.join(runDir, f.id + '-evidence');
    fs.mkdirSync(evDir, { recursive: true });
    const exploit = `${EXPLOITS}/${f.id}.test.js`;
    const baseline = await head(dir);
    let sid;
    const prompts = buildPrompts(f, exploit, fw?.framework || 'jest', testCmd);

    // 1) REPRODUCE
    if (f.kind !== 'dependency') {
      try { const r = await runAgent(dir, prompts.reproduce); sid = r.sessionId; }
      catch (e) {
        set(f, { status: 'failed', reason: `reproduce agent error: ${e?.message || e}`, finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
        log(`  ${f.id}: reproduce agent error: ${e?.message || e}`);
        return;
      }
      if (!fs.existsSync(path.join(dir, exploit))) {
        set(f, { status: 'failed', reason: 'Agent did not produce an exploit test', finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
        return;
      }
    }
    const before = await proof(dir, f, exploit, fw?.framework || 'jest');
    fs.writeFileSync(path.join(evDir, 'before.txt'), before.out);
    if (before.pass) {
      set(f, { status: 'not-reproduced', reason: 'Proof already passes on the unfixed code (possible false positive or weak test)', finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
      return;
    }
    if (f.kind !== 'dependency' && !isGenuineAssertionFailure(before.out)) {
      set(f, { status: 'invalid-exploit-test', reason: 'Exploit test failed for the wrong reason (syntax / import / "no tests found").', finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
      return;
    }
    log(`  ${f.id}: reproduced (proof fails before fix, genuine assertion)`);
    await commitAll(dir, 'PatchProof exploit test');

    // 2) FIX + 3) VERIFY, with bounded retries
    let prompt = prompts.fix, ok = false, last = '', after, suite, beforeProof = before;
    const exploitHash = fs.existsSync(path.join(dir, exploit)) ? fs.readFileSync(path.join(dir, exploit), 'utf8') : '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
      set(f, { status: 'fixing', attempts: attempt });
      log(`  ${f.id}: fix attempt ${attempt}/${MAX_ATTEMPTS}`);
      try { const r = await runAgent(dir, prompt, sid); sid = r.sessionId; }
      catch (e) {
        last = `Agent error: ${e?.message || e}`;
        log(`  ${f.id}: ${last}`);
        continue;
      }
      set(f, { status: 'verifying' });

      const changed = await changedFiles(dir);
      const bad = changed.filter(isProtected);
      if (bad.length) {
        await restore(dir, bad);
        last = `You modified protected files (${bad.join(', ')}). They were reverted. Fix the application source only.`;
        prompt = buildPrompts(f, exploit, fw?.framework || 'jest', testCmd, last).fix; continue;
      }
      if (!changed.length) {
        last = 'No files were changed. Make the fix.';
        prompt = buildPrompts(f, exploit, fw?.framework || 'jest', testCmd, last).fix; continue;
      }
      if (exploitHash && fs.readFileSync(path.join(dir, exploit), 'utf8') !== exploitHash) {
        last = 'The exploit test was altered.';
        prompt = buildPrompts(f, exploit, fw?.framework || 'jest', testCmd, last).fix; continue;
      }

      after = await proof(dir, f, exploit, fw?.framework || 'jest');
      suite = await sh(testCmd, { cwd: dir, timeout: 300000 });
      if (after.pass && suite.code === 0) { ok = true; break; }
      last = `Verification failed.\nProof ${after.pass ? 'passed' : 'FAILED'}:\n${tail(after.out)}\nFull suite exit code ${suite.code}:\n${tail(suite.out)}`;
      prompt = buildPrompts(f, exploit, fw?.framework || 'jest', testCmd, last).fix;
      log(`  ${f.id}: verification failed on attempt ${attempt}`);
    }
    if (!ok) {
      set(f, { status: 'failed', reason: tail(last, 600), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
      return;
    }

    // 4) DELIVER
    const fixDiff = await stagedDiff(dir);
    const fullPatch = await stagedDiff(dir, baseline);
    fs.writeFileSync(path.join(evDir, 'fix.diff'), fixDiff);
    fs.writeFileSync(path.join(evDir, 'full.patch'), fullPatch);
    fs.writeFileSync(path.join(evDir, 'after.txt'), after.out);
    fs.writeFileSync(path.join(evDir, 'suite-after.txt'), suite.out);
    let explanation = '';
    try { explanation = await explain(f, fixDiff); }
    catch (e) { explanation = '(explanation unavailable: ' + (e?.message || e) + ')'; }
    const testSrc = fs.existsSync(path.join(dir, exploit)) ? fs.readFileSync(path.join(dir, exploit), 'utf8') : '';
    fs.writeFileSync(path.join(evDir, 'report.md'),
      `# ${f.title}\n\nSeverity: ${f.severity}  |  Tool: ${f.tool}  |  Attempts: ${f.attempts}  |  Mode: ${state.mode}  |  Elapsed: ${fmtDur(Date.now() - startedAt)}\n\n## What was wrong, in plain words\n${explanation}\n\n## Proof before fix (must fail)\n\`\`\`\n${tail(beforeProof.out)}\n\`\`\`\n\n## Exploit test\n\`\`\`js\n${testSrc}\n\`\`\`\n\n## Fix\n\`\`\`diff\n${fixDiff}\n\`\`\`\n\n## Proof after fix (must pass)\n\`\`\`\n${tail(after.out)}\n\`\`\`\n\n## Existing test suite after fix\nExit code ${suite.code}\n`);
    set(f, {
      status: 'verified',
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      evidence: { before: tail(beforeProof.out), after: tail(after.out), diff: fixDiff, fullPatch, exploitTest: testSrc, explanation, dir: evDir, mode: state.mode, beforeTestsRun: countPassFail(beforeProof.out), afterTestsRun: countPassFail(after.out), diffStats: diffStats(fixDiff) },
    });
    log(`  ${f.id}: VERIFIED in ${fmtDur(Date.now() - startedAt)}. Evidence in ${evDir}`);

    if (apply) await applyToRepo(f, path.join(evDir, 'full.patch'));
  }

  async function applyToRepo(f, patch) {
    const g = (c) => sh(c, { cwd: path.resolve(target) });
    if ((await g('git rev-parse --is-inside-work-tree')).code) return log('  apply skipped: target is not a git repository');
    if ((await g('git status --porcelain')).stdout.trim()) return log('  apply skipped: target has uncommitted changes');
    const cur = (await g('git rev-parse --abbrev-ref HEAD')).stdout.trim();
    await g(`git checkout -b patchproof/${f.id}`);
    const dry = await g(`git apply --check "${patch}"`);
    if (dry.code) return log(`  apply failed (dry-run): ${dry.out.slice(-200)}`);
    await g(`git apply "${patch}"`);
    await g(`git add -A && ${GIT} commit -qm "PatchProof: fix ${f.id}"`);
    await g(`git checkout ${cur}`);
    log(`  branch patchproof/${f.id} created`);
  }
}

// Helpers for the dashboard
export function countPassFail(out) {
  const s = String(out || '');
  const pass = (s.match(/(\d+)\s+pass(ed|ing)?/i) || [])[1];
  const fail = (s.match(/(\d+)\s+fail(ed|ing)?/i) || [])[1];
  return { pass: pass ? Number(pass) : null, fail: fail ? Number(fail) : null };
}

export function diffStats(diff) {
  const lines = String(diff || '').split('\n');
  let added = 0, removed = 0, files = new Set();
  for (const l of lines) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
    if (l.startsWith('diff --git')) {
      const m = l.match(/b\/(.+)$/);
      if (m) files.add(m[1]);
    }
  }
  return { added, removed, files: [...files] };
}
