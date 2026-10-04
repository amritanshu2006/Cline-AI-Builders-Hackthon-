# PatchProof — Hackathon Submission

> **Cline AI Builders Hackathon – Stage 2**, Team Ultra: Amritanshu Kumar, Vedang Japtap, Granth Choudhary
> **Date:** 4 October 2026
> **Venue:** Lecture Hall Complex (L7), IIT Kanpur
> **Category:** Security tooling, AI agents, DevX

---

## 1. One-paragraph summary

**PatchProof** is a tool that finds security vulnerabilities in a Node.js repository, asks a real LLM (via the official [`@cline/sdk`](https://www.npmjs.com/package/@cline/sdk)) to reproduce each one with a failing test, asks the LLM to fix it, then **runs the tests itself** before accepting any patch. No fix is shipped unless (a) the exploit test that used to fail now passes, and (b) every existing test in the project still passes. Every accepted fix comes with a markdown evidence report, a real `git diff`, and a patch file you can `git apply`.

---

## 2. The problem we solve

| Problem | Reality |
|---------|---------|
| `npm audit` returns 30 findings | a part-time developer can't triage them |
| Semgrep returns long lists | same problem |
| AI-suggested patches are unverified | "did this fix the hole, or did it just silence the scanner?" |
| Test integrity is at risk | a careless AI can edit tests to "make them pass" |
| Organisation has no security engineer | fixes get shipped late or never |

PatchProof compresses this loop into one command and ships **proof** with every fix.

---

## 3. How it works

```
Scan → Reproduce → Fix → Verify → Deliver
```

| Phase | What happens | Who runs it |
|-------|--------------|--------------|
| **Scan** | Semgrep (or a prepared `patchproof.findings.json`) → list of findings sorted by severity, deduped by `(file, line)` | PatchProof |
| **Reproduce** | The LLM writes an exploit test under `patchproof_exploits/` | Cline SDK |
| **Reproduce** | PatchProof runs it, **requires** it to fail with a genuine assertion (not a syntax / import error) | PatchProof |
| **Fix** | The LLM edits the application source | Cline SDK |
| **Fix** | PatchProof reverts any edit to tests or the exploit file | PatchProof |
| **Verify** | PatchProof runs the exploit test + the project's full suite, retries up to 3 times on failure with the failing output passed back to Cline | PatchProof |
| **Deliver** | Markdown report, `fix.diff`, `full.patch` saved | PatchProof |

Everything except the LLM call is performed by the orchestrator, never trusted from the agent.

---

## 4. Quick start (Linux / macOS)

```bash
# 1. Clone
git clone <repo-url> patchproof
cd patchproof

# 2. One-time setup (checks Node ≥ 22, copies .env.example → .env, installs npm deps)
npm run setup

# 3. Edit .env — pick ONE provider and paste your key
$EDITOR .env
# Uncomment exactly ONE block, for example:
#   PP_PROVIDER=openai-native  PP_MODEL=gpt-4o-mini    PP_API_KEY=sk-...
#   PP_PROVIDER=anthropic     PP_MODEL=claude-sonnet-4-5  PP_API_KEY=sk-ant-...
#   PP_PROVIDER=openrouter     PP_MODEL=anthropic/claude-3.5-sonnet  PP_API_KEY=sk-or-...
#   PP_PROVIDER=cline         PP_MODEL=anthropic/claude-sonnet-4.5  PP_API_KEY=

# 4. Try the offline demo first (no API credits used)
npm run demo:replay

# 5. Then run with the real Cline SDK
npm run demo

# 6. Or start the dashboard
npm start
# open http://127.0.0.1:3000
```

That's the entire happy path. Judges should be able to run the project by following these six steps.

---

## 5. Requirements

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | ≥ 22 | `@cline/sdk` needs the `node:sqlite` builtin (Node ≥ 22). `engines` field in `package.json` enforces this. |
| **npm** | ≥ 10 | Comes with Node 22. |
| **git** | any recent | Diffs, snapshots, branches. |
| **Semgrep** | 1.x, *optional* | If missing, the orchestrator reads `sample-vulnerable-app/patchproof.findings.json`. |
| **OS** | Linux or macOS | Tested on Ubuntu 25.10. macOS 14+ should work without changes. |

**Disk space:** ~ 30 MB for the source + `node_modules/`. The submission archive is 84 KB.

---

## 6. Setup commands

```bash
# Verify Node
node --version         # must print v22.x or later

# Run the included setup script (recommended)
npm run setup

# Or do it manually:
cp .env.example .env
npm install                 # backend deps
cd sample-vulnerable-app && npm install && cd ..
# Optionally install Semgrep
pip3 install --user --break-system-packages semgrep

# Build the Docker sandbox image (optional)
docker build -t patchproof-sandbox:latest sandbox-runner/
```

The setup script prints clear next steps at the end:

```
📋 Next steps
   1. Edit .env. Uncomment exactly ONE block …
   2. Try the offline demo first: npm run demo:replay
   3. Then run with real Cline: npm run demo
   4. Or start the dashboard: npm start
   5. Build a submission archive: npm run package
```

---

## 7. Run commands

| Goal | Command | Cost |
|------|---------|------|
| Offline demo (4 vulns, no AI credits) | `PP_REPLAY=1 npm run demo` | free |
| Real Cline SDK, default settings | `npm run demo` | LLM credits |
| Process custom target | `node --env-file-if-exists=.env --env-file-if-exists=.env.example src/cli.js /path/to/app --max 5` | LLM credits |
| Custom findings file | `… src/cli.js . --findings my.json` | varies |
| Apply patches to target | `… src/cli.js /path/to/app --apply` | LLM credits |
| Start dashboard | `npm start` | free |
| API health | `curl http://127.0.0.1:3000/api/health` | free |
| Build submission archive | `npm run package` | free |
| Run end-to-end video demo | `bash scripts/demo-video.sh` | free (uses replay) |

`npm run demo` is wired to `node --env-file-if-exists=.env --env-file-if-exists=.env.example src/cli.js sample-vulnerable-app --max 3`.

---

## 8. All dependencies

### Runtime (npm)

| Package | Version | Purpose |
|---------|---------|---------|
| `@cline/sdk` | ^0.0.90 | Official Cline SDK — runs the LLM agent in a local runtime |
| `express` | ^5.2.1 | Dashboard web server |

(See `package.json` and `package-lock.json`.)

### Dev / build

No dev dependencies are required — the project ships with no test framework, no TypeScript build, no bundler. Everything is plain Node ≥ 22 ES modules.

### System (optional)

| Tool | Used for | How to install |
|------|----------|----------------|
| `semgrep` | Static analysis | `pip3 install --user --break-system-packages semgrep` (the setup script does this automatically) |
| `docker` | Network-isolated test execution | Your distro's package manager |

---

## 9. All environment variables

`.env` is loaded automatically by every entrypoint (via Node 22's `node --env-file-if-exists` flag).

| Variable | Required? | Default | Purpose |
|----------|-----------|---------|---------|
| `PP_PROVIDER` | **yes** | — | One of `anthropic`, `openai-native`, `openai-compatible`, `openrouter`, `cline`, `gemini`, `deepseek`, `groq`, `bedrock`, `vertex`, etc. **Important:** `openai` alone is **not** a valid id — use `openai-native`. |
| `PP_MODEL` | **yes** | — | Provider-specific model id, e.g. `claude-sonnet-4-5`, `gpt-4o-mini`, `anthropic/claude-3.5-sonnet` (for OpenRouter), `anthropic/claude-sonnet-4.5` (for Cline). |
| `PP_API_KEY` | **yes for non-cline** | — | API key from your provider. Leave blank when `PP_PROVIDER=cline`. |
| `PP_REPLAY` | no | `0` | Set to `1` to use the offline replay mode (pre-recorded, no AI credits). |
| `PP_VERBOSE` | no | `0` | Set to `1` to log every Cline SDK event to stderr. |
| `PP_AGENT_TIMEOUT_MS` | no | `180000` | Per-session timeout (Cline's exit is awaited synchronously via the `start()` return value, but this is the hard cap). |
| `PP_SEMGREP_CONFIG` | no | local rules | Set to `auto` to opt-in to fetching Semgrep's auto ruleset from the internet. By default we ship local rules in `semgrep-rules/patchproof.yml` (no internet needed). |
| `HOST` | no | `127.0.0.1` | Server bind address. **Do not change unless you understand the security implications** — the agent runs shell commands. |
| `PORT` | no | `3000` | Server port. |
| `CORS_ORIGINS` | no | same-origin | Comma-separated list of allowed origins. |
| `SEMGREP_BIN` | no | `semgrep` on PATH | Override path to the Semgrep binary. |
| `GITHUB_TOKEN` | no | — | Optional, used by the `/api/apply` flow to open a PR. |

**Where do I get an API key?**

| Provider | Where | Notes |
|----------|-------|-------|
| OpenAI | https://platform.openai.com/api-keys | Easiest, free trial credits |
| Anthropic | https://console.anthropic.com/ | Best for code tasks |
| OpenRouter | https://openrouter.ai/keys | One key, many models |
| Cline provider | (no account needed) | Uses Cline credits instead |

---

## 10. What you get after a successful run

After `npm run demo` finishes:

```
runs/<timestamp>/                                   ← one folder per run
  base/                                             ← pristine copy of the target repo, baseline-tested
  f1-path-traversal/                                ← per-finding working copy
  f1-path-traversal-evidence/
    before.txt                                      ← exploit test FAILED before the fix
    after.txt                                       ← exploit test PASSES after the fix
    suite-after.txt                                 ← full suite output
    fix.diff                                        ← the change (no exploit test)
    full.patch                                      ← full patch file (git-apply ready)
    report.md                                       ← human-readable evidence
  f2-command-injection/
  f2-command-injection-evidence/ … (same files)
  …
```

Each `*-evidence/` folder is the proof that this fix works.

---

## 11. Dashboard tour

After `npm start`, open http://127.0.0.1:3000. The dashboard:

- shows a **mode badge** (`REAL Cline SDK` or `REPLAY (pre-recorded, no AI)`)
- shows per-finding status (`reproducing / fixing / verifying / verified / failed / invalid-exploit-test`)
- shows Cline's **live activity log**
- shows the **before-and-after proof** (full Jest output)
- shows the **unified diff** of the patch
- shows the **plain-language "what was wrong"** explanation
- shows **real backend errors** (e.g. `PP_API_KEY missing`, provider errors)

Screenshots and a working dashboard are part of the demo video.

---

## 12. What runs where

| Component | Where it runs |
|-----------|---------------|
| Dashboard (Express) | host, `127.0.0.1:3000` |
| CLI (`npm run demo`) | host |
| Scanner (Semgrep) | host, 5-minute timeout, falls back to `patchproof.findings.json` |
| LLM agent (Cline) | host, `ClineCore` from `@cline/sdk` runs locally |
| Per-finding sandbox | `/tmp/patchproof-runs/<ts>/<finding-id>/`, git-initialised, deps installed once |
| Test execution | sandbox copy on host; with `--docker`, runs in `patchproof-sandbox` |

The `--docker` flag runs tests in a network-isolated container:

```
docker build -t patchproof-sandbox:latest sandbox-runner/
node --env-file=.env src/cli.js /path/to/app --docker
```

The sandbox image:

- base: `node:20-alpine`
- runs as a non-root user (`patchproof`, uid 1000)
- launched with `--network=none` and `--read-only`
- mounts the sandbox copy at `/workspace`

---

## 13. Repository layout

```
PatchProof/
├── README.md                          # user-facing guide
├── SUBMISSION.md                      # this file
├── QUICKSTART.md                      # 1-page quick reference
├── package.json                       # Node ≥ 22, @cline/sdk, express 5
├── package-lock.json
├── .env.example                       # copy → .env, fill in your key
├── .dockerignore
├── .gitignore
│
├── scripts/
│   ├── setup.sh                       # Node check, npm install, .env setup
│   ├── package.sh                     # `npm run package` → small submission zip
│   ├── demo-video.sh                  # one-command vulnerable + patched demo
│   └── demo-narration.md              # scene-by-scene narration for the video
│
├── semgrep-rules/
│   └── patchproof.yml                 # local rules (no internet needed)
│
├── examples/                          # sample evidence reports
│   ├── finding-1-report.md
│   ├── finding-2-report.md
│   ├── finding-3-report.md
│   ├── finding-4-report.md
│   └── finding-5-report.md
│
├── public/
│   └── index.html                     # dashboard (vanilla JS, single file)
│
├── src/
│   ├── cline.js                       # @cline/sdk wrapper (default) + replay opt-in
│   ├── replay.js                      # offline pattern agent (PP_REPLAY=1)
│   ├── scanner.js                     # Semgrep + prepared-findings file
│   ├── workspace.js                   # sandbox copy + git snapshot/restore/diff
│   ├── pipeline.js                    # Scan → Reproduce → Fix → Verify → Deliver
│   ├── server.js                      # Express API (127.0.0.1 by default)
│   ├── cli.js                         # CLI entry point
│   └── util.js                        # safe shell runner with timeout
│
├── sample-vulnerable-app/             # demo target (4 deliberate CVEs)
│   ├── server.js
│   ├── package.json
│   ├── patchproof.findings.json       # prepared findings (used when Semgrep missing)
│   ├── public/welcome.txt
│   ├── __tests__/baseline.test.js
│   └── .env.secret-for-demo
│
└── sandbox-runner/
    └── Dockerfile                     # non-root, network-isolated test image
```

---

## 14. Anti-cheating protections

The agent **cannot** cheat the verification step:

1. **Test snapshots** — before every agent call, PatchProof snapshots every file under `__tests__/`.
2. **Auto-revert** — after the agent runs, any file under `__tests__/` that differs from the snapshot is reverted.
3. **Exploit test is checked** — the agent is not allowed to modify `patchproof_exploits/` either.
4. **Pipeline runs tests itself** — the agent's word that "tests pass" is never trusted.
5. **Genuine-assertion check** — exploit failures that are SyntaxError / "no tests found" / import errors are rejected as `invalid-exploit-test`.
6. **Full suite must pass** — even if the exploit test passes, the project's full baseline suite must pass too.
7. **Failure context passed back** — on retry, the failing test output is included in the next prompt.
8. **Real `git diff`** — every evidence report contains the actual diff captured from a fresh git diff against the snapshot commit.

All of this is observable in the dashboard's log and per-finding `evidence` payload.

---

## 15. What we did NOT do (limitations)

- The OpenAI API key you provided has zero credits remaining (verified by direct `curl` to the OpenAI API). The pipeline correctly reports this when you run with real Cline + OpenAI. We documented this in the README and offered three alternatives: Antrhopic, OpenRouter, or the `cline` provider (which uses Cline credits instead of an API key). The replay mode (`npm run demo:replay`) works offline regardless.
- `@cline/sdk` 0.0.90 requires Node ≥ 22. Older Node will not start. The `engines` field in `package.json` documents this, and `npm run setup` checks before installing.
- The dashboard frontend is a single HTML file with inline JS — it is **not** React, despite what an earlier draft said. We chose this so reviewers can read the whole UI in one file.
- The "plain-language explanation" in the evidence report is templated (no extra LLM call) so a fix doesn't double the API bill.
- The submission archive excludes the huge `target-repo/` directory to stay under 20 MB (the actual Juice Shop is large).

---

## 16. Build a submission archive

```bash
npm run package
# → patchproof-submission-YYYYMMDD.zip (~ 84 KB)
```

Contents:

```
.dockerignore
.env.example
.gitignore
README.md
QUICKSTART.md
SUBMISSION.md
package.json
package-lock.json
public/index.html
sample-vulnerable-app/{server.js, package.json, patchproof.findings.json, public/, __tests__/}
sandbox-runner/Dockerfile
scripts/{setup.sh, package.sh, demo-video.sh, demo-narration.md}
semgrep-rules/patchproof.yml
src/{cli.js, cline.js, pipeline.js, replay.js, scanner.js, server.js, util.js, workspace.js}
examples/finding-{1..5}-report.md
target-repo/  ← intentionally large; replace with a smaller second target if needed
```

The `.env` file is **never** included — the script refuses to build if it's tracked.

---

## 17. Demo video

Run the full demo that shows the vulnerable app, PatchProof fixing it, and the same exploits failing on the patched app:

```bash
bash scripts/demo-video.sh
```

This produces a complete transcript. The script is non-interactive — no
`npm run` or interactive prompts inside. **It also starts the dashboard on
port 3001** so the live UI updates as PatchProof works.

**For a UI-only walkthrough** (no PatchProof run), start the dashboard
on its own:

```bash
npm run dashboard                # → http://127.0.0.1:3001
# or: bash scripts/start-dashboard.sh
```

A scene-by-scene narration guide lives at `scripts/demo-narration.md`.

---

## 18. Submission checklist

- [x] Source code with extensive documentation (this file + inline JSDoc on every module).
- [x] Setup steps for Linux and macOS (verified on Ubuntu 25.10).
- [x] All dependencies listed (above and in `package.json`).
- [x] All environment variables listed (above and in `.env.example`).
- [x] Judges can run the project by following the README alone.
- [x] `npm run package` produces a submission archive under 20 MB (84 KB).
- [x] Demo video: `bash scripts/demo-video.sh` runs the full vulnerable → patched demo.
- [ ] Cline chat history: *(export separately at the venue).*

---

## 19. Credits

- **@cline/sdk** (https://www.npmjs.com/package/@cline/sdk) — the official Cline SDK
- **Semgrep** (https://semgrep.com) — static analysis
- **express** (https://expressjs.com) — dashboard web server
- **Jest + supertest** — test framework used by the sample app

## 20. License

MIT — built during the Cline AI Builders Hackathon at IIT Kanpur, October 2026.
