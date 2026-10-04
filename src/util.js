import { spawn } from 'node:child_process';

// Run a shell command; resolves with { code, out (stdout+stderr), stdout }. Never rejects.
export function sh(cmd, { cwd, timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, { cwd, shell: true, env: { ...process.env, ...env } });
    let out = '', stdout = '';
    const cap = (s) => (s.length > 300000 ? s.slice(-300000) : s);
    p.stdout.on('data', (d) => { out = cap(out + d); stdout = cap(stdout + d); });
    p.stderr.on('data', (d) => { out = cap(out + d); });
    p.on('error', (e) => { out += String(e); });
    const t = setTimeout(() => { out += '\n[timeout]'; p.kill('SIGKILL'); }, timeout);
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out, stdout }); });
  });
}
