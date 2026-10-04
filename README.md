# 🛡️ PatchProof

**Security fixes that come with proof.**

PatchProof finds vulnerabilities in a repository, asks a real LLM (via the
official [`@cline/sdk`](https://www.npmjs.com/package/@cline/sdk)) to
reproduce each one with a failing test, asks the LLM to fix it, then
**runs the tests itself** before accepting any patch.

No fix is merged unless (a) the exploit test that used to fail now passes,
and (b) every existing test in the project still passes. Every accepted fix
ships with a markdown evidence report, a real `git diff`, and a patch file.

---

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | ≥ 22 | The `@cline/sdk` needs the `node:sqlite` builtin. |
| **npm** | ≥ 10 | Comes with Node 22. |
| **git** | any recent | Diffs, snapshots, branches. |
| **Semgrep** *(optional)* | 1.x | Falls back to a prepared `patchproof.findings.json` if missing. |

Tested on Linux (Ubuntu 25.10) and macOS 14+.

---

## Quick start

```bash
git clone https://github.com/amritanshu2006/Cline-AI-Builders-Hackthon- patchproof
cd patchproof

# One-time setup: checks Node ≥ 22, copies .env.example → .env,
# installs npm deps, optionally installs Semgrep.
npm run setup

# Open .env and choose a provider + paste your key.
# IMPORTANT: provider id is NOT "openai" – use "openai-native".
$EDITOR .env
# Examples (uncomment exactly one block):
#   PP_PROVIDER=openai-native  PP_MODEL=gpt-4o-mini    PP_API_KEY=sk-...
#   PP_PROVIDER=anthropic     PP_MODEL=claude-sonnet-4-5  PP_API_KEY=sk-ant-...
#   PP_PROVIDER=openrouter     PP_MODEL=anthropic/claude-3.5-sonnet  PP_API_KEY=sk-or-...
#   PP_PROVIDER=cline         PP_MODEL=anthropic/claude-sonnet-4.5  PP_API_KEY=

# Try the demo against the bundled sample-vulnerable-app
npm run demo
# Or the offline replay mode (pre-recorded, no API credits used)
npm run demo:replay

# Or start the dashboard
npm start
# open http://127.0.0.1:3000
```

A real demo run with the **Cline SDK** costs LLM credits (Anthropic / OpenAI /
OpenRouter / Cline). The replay mode is opt-in (`PP_REPLAY=1`) and is
clearly labelled in the dashboard, the CLI log and every evidence report –
it never pretends to be the Cline SDK.

---

## How it works

```
Scan → Reproduce → Fix → Verify → Deliver
```

| Phase | What happens |
|-------|--------------|
| **Scan** | Semgrep (or a prepared `patchproof.findings.json`) produces a list of findings sorted by severity. |
| **Reproduce** | The LLM writes an exploit test under `patchproof_exploits/`. The orchestrator runs it and *requires* it to fail with a genuine assertion error. |
| **Fix** | The LLM edits the application source. The orchestrator reverts any edit to protected files (tests, the exploit test). |
| **Verify** | The orchestrator runs the exploit test AND the project's full suite. Both must pass. |
| **Deliver** | A markdown report, `fix.diff` and `full.patch` are saved. |

Every step is performed by the orchestrator, never trusted from the agent.

---

## What runs where

| Component | Where it runs |
|-----------|---------------|
| **Dashboard** (Express) | Host (`127.0.0.1:3000` by default) |
| **CLI** (`npm run demo`) | Host |
| **Scanner** (Semgrep) | Host — invoked via `sh()` with a 5-min timeout. Falls back to local `semgrep-rules/patchproof.yml`. |
| **LLM agent** (Cline) | Host — `ClineCore` from `@cline/sdk` runs locally |
| **Per-finding sandbox** | `/tmp` — fresh copy of the repo under `runs/<ts>/<finding-id>/`, git-initialised, deps installed once |
| **Test execution** | Inside the sandbox copy, on the host. With `--docker`, runs in `patchproof-sandbox` (no network, non-root user). |

---

## All environment variables

`.env` is loaded automatically by every entrypoint (via `node --env-file=.env`).

| Variable | Default | Purpose |
|----------|---------|---------|
| `PP_PROVIDER` | *(required)* | `anthropic` / `openai-native` / `openai-compatible` / `openrouter` / `cline` etc. See `.env.example`. |
| `PP_MODEL` | *(required)* | Model id (`claude-sonnet-4-5`, `gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, …). |
| `PP_API_KEY` | *(required for non-cline)* | Provider API key. Leave blank when `PP_PROVIDER=cline`. |
| `PP_REPLAY` | `0` | `1` to opt-in to replay mode (offline, no AI credits). |
| `PP_VERBOSE` | `0` | `1` to log every Cline SDK event to stderr. |
| `PP_AGENT_TIMEOUT_MS` | `180000` | Per-session timeout in milliseconds. |
| `PP_SEMGREP_CONFIG` | local rules | `auto` to opt-in to fetching Semgrep rules over the internet. |
| `HOST` | `127.0.0.1` | Server bind address. |
| `PORT` | `3000` | Server port. |
| `CORS_ORIGINS` | same-origin | Comma-separated list of allowed origins. |
| `SEMGREP_BIN` | `semgrep` on PATH | Override path to the Semgrep binary. |
| `GITHUB_TOKEN` | *(none)* | Optional – if set, `/api/apply` can open a PR. |

---

## CLI examples

```bash
# Default: top 3 findings, no apply
npm run demo

# Offline replay mode (no API credits used, labelled honestly)
npm run demo:replay

# Real Cline SDK against a custom target
node --env-file=.env src/cli.js /path/to/your-app --test 'npm test' --max 5

# Custom findings file (skip scanner, use a prepared JSON)
node --env-file=.env src/cli.js . --findings my-findings.json --max 5

# Apply the verified fix as a new git branch in the target repo
node --env-file=.env src/cli.js /path/to/your-app --apply
```

---

## Dashboard

```bash
npm start
# open http://127.0.0.1:3000
```

The dashboard at `public/index.html` shows:

- which mode is active (`REAL Cline SDK` or `REPLAY (pre-recorded, no AI)`),
- per-finding status (`queued / reproducing / fixing / verifying / verified / failed / invalid-exploit-test`),
- Cline's live activity log,
- the before-and-after proof (full Jest output),
- the unified diff of the patch,
- the plain-language "what was wrong" explanation,
- any real backend errors (e.g. `PP_API_KEY missing`, provider errors).

---

## Demo video

Run the end-to-end demo (vulnerable app → PatchProof → patched app) with one command:

```bash
bash scripts/demo-video.sh
```

The script is fully scripted, no keypresses needed. It starts the **dashboard
on port 3001** as well, so open http://127.0.0.1:3001 in a browser **before**
running it to see the live UI update in real time.

A scene-by-scene narration guide lives at `scripts/demo-narration.md`.

To start the dashboard on its own (e.g. for a UI walkthrough):

```bash
npm run dashboard               # → http://127.0.0.1:3001
# or: bash scripts/start-dashboard.sh
```

## Sandbox isolation (Docker, optional)

By default tests run on the host inside `/tmp/patchproof-runs/`.
For untrusted code, build the sandbox image and pass `--docker`:

```bash
docker build -t patchproof-sandbox:latest sandbox-runner/
node --env-file=.env src/cli.js /path/to/app --docker
```

The image:

- is based on `node:20-alpine`,
- runs as a non-root user (`patchproof`, uid 1000),
- is launched with `--network=none` and `--read-only`,
- mounts the sandbox copy at `/workspace`.

---

## Repository layout

```
PatchProof/
├── package.json              # Node ≥ 22, @cline/sdk, express 5
├── .env.example              # copy to .env, fill in your key
├── scripts/
│   ├── setup.sh              # Node check, install, .env setup
│   └── package.sh            # npm run package → small submission zip
├── semgrep-rules/patchproof.yml   # local rules (no internet needed)
├── examples/                 # sample evidence reports
├── public/index.html         # dashboard (vanilla JS, single file)
├── src/
│   ├── cline.js              # @cline/sdk wrapper (default) + replay opt-in
│   ├── replay.js             # offline pattern agent (PP_REPLAY=1)
│   ├── scanner.js            # Semgrep + prepared-findings file
│   ├── workspace.js          # sandbox copy + git snapshot/restore/diff
│   ├── pipeline.js           # Scan → Reproduce → Fix → Verify → Deliver
│   ├── server.js             # Express API (127.0.0.1 by default)
│   ├── cli.js                # CLI entry point
│   └── util.js               # safe shell runner with timeout
├── sample-vulnerable-app/    # 4 deliberately vulnerable endpoints
└── sandbox-runner/
    └── Dockerfile
```

---

## Submission archive

```bash
npm run package
# → patchproof-submission-YYYYMMDD.zip (~ 92 KB, excludes node_modules, runs/, evidence/, target-repo/, .env)
```

The `.gitignore` keeps the archive small and excludes secrets. The script
refuses to build if `.env` is tracked.

---

## Known limitations

- **A real API key is required for the default mode.** The opt-in replay
  mode (`PP_REPLAY=1`) is the only way to demo without API credits.
- `@cline/sdk` requires Node ≥ 22. Older versions of Node will not start.
- Semgrep rules are local-only by default. Set `PP_SEMGREP_CONFIG=auto` to
  fetch Semgrep's auto ruleset from the internet.
- The dashboard frontend is a single HTML file with inline JS — it is not
  React.
- The plain-language "what was wrong" section is templated (no extra LLM
  call) so a fix doesn't double the API bill.

---

## Submission checklist

- [x] Source code with extensive documentation (this README + inline JSDoc).
- [x] Setup steps for Linux (verified on Ubuntu 25.10).
- [x] Every dependency and environment variable documented above.
- [x] Judges can run the project by following the README alone.
- [x] `npm run package` produces a submission archive under 1 MB.
- [x] Demo video (use `bash scripts/demo-video.sh` and record the terminal; see `scripts/demo-narration.md`)
- [ ] Cline chat history *(export separately)*.
