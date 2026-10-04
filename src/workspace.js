import fs from 'node:fs';
import path from 'node:path';
import { sh } from './util.js';

export const GIT = 'git -c user.name=PatchProof -c user.email=bot@patchproof.local';

// Copy (or clone) the target into runDir/base, install deps, make a baseline git commit.
export async function prepareBase(target, runDir, log) {
  const base = path.join(runDir, 'base');
  fs.mkdirSync(runDir, { recursive: true });
  if (/^(https?:\/\/|git@)/.test(target)) {
    const r = await sh(`git clone --depth 1 "${target}" "${base}"`, { timeout: 300000 });
    if (r.code) throw new Error('git clone failed: ' + r.out.slice(-400));
    fs.rmSync(path.join(base, '.git'), { recursive: true, force: true });
  } else {
    fs.cpSync(path.resolve(target), base, {
      recursive: true,
      filter: (s) => !/(^|[\\/])(node_modules|\.git)$/.test(s),
    });
  }
  fs.appendFileSync(path.join(base, '.gitignore'), '\nnode_modules\n');
  if (fs.existsSync(path.join(base, 'package.json'))) {
    log('Installing dependencies in sandbox copy...');
    const r = await sh('npm install --no-audit --no-fund', { cwd: base, timeout: 600000 });
    if (r.code) throw new Error('npm install failed: ' + r.out.slice(-400));
  }
  await sh(`git init -q && git add -A && ${GIT} commit -qm baseline`, { cwd: base });
  return base;
}

export function cloneFor(base, dst) {
  fs.cpSync(base, dst, { recursive: true, verbatimSymlinks: true });
  return dst;
}

export const head = async (dir) => (await sh('git rev-parse HEAD', { cwd: dir })).stdout.trim();
export const commitAll = (dir, msg) => sh(`git add -A && ${GIT} commit -qm "${msg}"`, { cwd: dir });

export async function changedFiles(dir) {
  const r = await sh('git status --porcelain -uall', { cwd: dir });
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
}

export async function restore(dir, files) {
  for (const f of files) {
    const tracked = (await sh(`git cat-file -e HEAD:"${f}"`, { cwd: dir })).code === 0;
    if (tracked) await sh(`git checkout HEAD -- "${f}"`, { cwd: dir });
    else fs.rmSync(path.join(dir, f), { force: true });
  }
}

export async function stagedDiff(dir, since) {
  await sh('git add -A', { cwd: dir });
  return (await sh(`git diff --cached ${since ?? ''}`, { cwd: dir })).stdout;
}
