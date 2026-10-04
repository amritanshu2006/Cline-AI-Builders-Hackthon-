import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const LOCAL_RULES = path.join(ROOT, 'semgrep-rules', 'patchproof.yml');

const RANK = { CRITICAL: 4, HIGH: 3, ERROR: 3, MODERATE: 2, MEDIUM: 2, WARNING: 2, LOW: 1, INFO: 1 };
const rank = (s) => RANK[String(s).toUpperCase()] ?? 0;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

export async function scan(dir, { findingsFile } = {}) {
  // 1) Prepared findings file always wins (reliable demo).
  const pre = findingsFile || path.join(dir, 'patchproof.findings.json');
  if (fs.existsSync(pre)) return normalize(JSON.parse(fs.readFileSync(pre, 'utf8')));

  const found = [];

  // 2) Semgrep. Local rules by default (no `--config=auto`, no internet).
  //    Opt-in to remote via PP_SEMGREP_CONFIG=auto.
  const sgBin = process.env.SEMGREP_BIN || 'semgrep';
  const config = process.env.PP_SEMGREP_CONFIG
    || (fs.existsSync(LOCAL_RULES) ? LOCAL_RULES : 'auto');
  const sg = await sh(`${sgBin} --config "${config}" --json --quiet ${dir}`, { cwd: dir, timeout: 300000 });
  if (sg.code === 0 || sg.stdout) {
    try {
      for (const r of JSON.parse(sg.stdout).results ?? []) {
        found.push({
          kind: 'code', tool: 'semgrep',
          severity: r.extra?.severity ?? 'INFO',
          title: String(r.check_id).split('.').pop(),
          file: r.path, line: r.start?.line, ruleId: r.check_id,
          description: r.extra?.message ?? '',
          codeSnippet: r.extra?.lines ?? '',
        });
      }
    } catch { /* semgrep missing or no JSON */ }
  }

  // 3) npm audit (direct advisories only).
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    const au = await sh('npm audit --json', { cwd: dir, timeout: 120000 });
    if (au.code === 0 || au.stdout) {
      try {
        const v = JSON.parse(au.stdout).vulnerabilities ?? {};
        for (const [name, info] of Object.entries(v)) {
          const adv = (info.via ?? []).find((x) => typeof x === 'object');
          if (!adv) continue;
          found.push({
            kind: 'dependency', tool: 'npm-audit',
            severity: info.severity, package: name,
            title: `${name}: ${adv.title}`, file: 'package.json',
            description: `${adv.title} (${adv.url ?? 'no url'}). Fix available: ${JSON.stringify(info.fixAvailable)}`,
          });
        }
      } catch { /* offline or no lockfile */ }
    }
  }
  return normalize(found);
}

function normalize(list) {
  const seen = new Set();
  return list
    .sort((a, b) => rank(b.severity) - rank(a.severity))
    .map((f, i) => ({ ...f, id: f.id || `f${i + 1}-${slug(f.title)}` }))
    .filter((f) => !seen.has(f.id) && seen.add(f.id));
}
