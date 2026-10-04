# PatchProof Demo Video — Narration Script

**Total runtime: ~2 minutes**

Before recording:

```bash
cd /home/amritanshu-kumar/PatchProof

# 1. Maximize the terminal (font 18–20pt, full screen)
# 2. Open Firefox / Chrome with three tabs:
firefox http://127.0.0.1:3001 &       # dashboard (will be populated by demo)
firefox http://127.0.0.1:4000 &       # vulnerable app
firefox http://127.0.0.1:4001 &       # patched app (will be populated)
# 3. Position browser so it's visible alongside the terminal
# 4. Start screen recorder (OBS / Loom / GNOME Screen Recorder)
```

Then execute:

```bash
PP_REPLAY=1 bash scripts/demo-video.sh
```

The script is non-interactive. It will:

- Start the dashboard on port 3001 (open it BEFORE running the script so the live UI is visible)
- Start the vulnerable app on port 4000
- Run each exploit to prove they succeed
- Trigger PatchProof through the dashboard API → live UI updates
- Build a patched copy, start it on port 4001
- Run the same exploits to prove they fail

---

## Scene 1 — The dashboard appears (≈ 5s)

> **SPEAK:** "PatchProof's live dashboard at http://127.0.0.1:3001."

**Show on screen:** the empty dashboard with the "Start a run" form, mode badge "REPLAY (pre-recorded, no AI)".

---

## Scene 2 — Vulnerable app, exploits work (≈ 30s)

> **SPEAK:** "Here's the sample app. Four known CVEs. Watch them all fire."

**Show on screen:** the curl output — each exploit returns 200 / "INJECTED" / "isAdmin:true" / "verifies with secret".

---

## Scene 3 — PatchProof via the dashboard (≈ 60s)

> **SPEAK:** "Now I trigger PatchProof through the dashboard. Watch the UI update live."

**Show on screen:**
- The terminal logs from PatchProof
- **AND** the dashboard tab filling in real-time with finding cards, statuses, the live log, the diff, the verification result

This is the money shot — record at 1080p, full screen, ~ 1 minute.

---

## Scene 4 — Patched app, exploits fail (≈ 30s)

> **SPEAK:** "Now the same app, rebuilt from PatchProof's patches. Same payloads."

**Show on screen:** the curl output — each exploit returns 403 / error / `{"error":"invalid path"}` / forgery rejected.

---

## Scene 5 — Evidence (≈ 20s)

**Show on screen:**

```bash
ls /home/amritanshu-kumar/PatchProof/runs/<latest>/
cat /home/amritanshu-kumar/PatchProof/runs/<latest>/f1-path-traversal-evidence/report.md
```

**Highlight:**
- `before.txt` — the failing exploit test
- `after.txt` — the same test now passes
- `fix.diff` — the actual code change
- `full.patch` — drop-in patch file
- `report.md` — human-readable evidence

---

## End card

Show static text on screen for 5 seconds:

```
PatchProof — security fixes with proof.
Built on @cline/sdk · MIT license
```

---

## Recording tips

- **Resolution:** 1920×1080
- **Recorder:** OBS (cross-platform), Loom (browser), or GNOME Screen Recorder (Ctrl+Alt+Shift+R)
- **Font size:** 18–20pt in the terminal for readability
- **Audio:** use your laptop mic or a headset; speak slowly and clearly
- **Pacing:** pause 2–3 seconds between sections so the viewer can read the output
- **Total length:** aim for 2–3 minutes
- **Cuts:** you can cut between scenes; the script is independent per phase

---

## Verify the start works without recording

```bash
# 1. Start dashboard
cd /home/amritanshu-kumar/PatchProof
PORT=3001 /home/amritanshu-kumar/.nvm/versions/node/v22.23.3/bin/node \
  --env-file-if-exists=.env --env-file-if-exists=.env.example \
  src/server.js &
# open http://127.0.0.1:3001

# 2. Start the vulnerable app manually
cd sample-vulnerable-app
PORT=4000 /home/amritanshu-kumar/.nvm/versions/node/v22.23.3/bin/node server.js &
curl http://127.0.0.1:4000/files?name=../package.json | head -3
# → returns the package.json contents (vulnerability)

# 3. Run PatchProof through the UI
# click "Run pipeline" with target=sample-vulnerable-app
# watch findings appear and resolve on the dashboard

# 4. Build the patched copy and serve it on a different port
# (already handled by scripts/demo-video.sh)
```
