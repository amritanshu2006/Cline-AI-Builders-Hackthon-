import { runPipeline, newState } from './pipeline.js';
import { shutdown } from './cline.js';

const a = process.argv.slice(2);
if (!a[0] || a[0].startsWith('--')) {
  console.log('Usage: node src/cli.js <path-or-git-url> [--test "npm test"] [--max 3] [--findings file.json] [--apply]');
  process.exit(1);
}
const opt = (n, d) => { const i = a.indexOf(n); return i > -1 ? a[i + 1] : d; };
const state = newState();
let printed = 0;
const emit = () => { while (printed < state.logs.length) console.log(state.logs[printed++]); };

await runPipeline({
  target: a[0], testCmd: opt('--test', 'npm test'), maxFindings: opt('--max', 3),
  findingsFile: opt('--findings'), apply: a.includes('--apply'),
}, state, emit);
emit();
console.log('\nStatus:', state.status, '|', state.summary ?? state.error);
for (const f of state.findings) console.log(` - ${f.id}: ${f.status}${f.reason ? ' (' + f.reason.split('\n')[0] + ')' : ''}`);
await shutdown();
process.exit(state.status === 'done' ? 0 : 1);
