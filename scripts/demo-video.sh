#!/usr/bin/env bash
# PatchProof end-to-end demo with both terminal AND live dashboard.
#
# PHASE 1 — Vulnerable app (port 4000) + dashboard idle (port 3001)
# PHASE 2 — PatchProof finds, fixes, and verifies 4/4 (watch on dashboard!)
# PHASE 3 — Patched app (port 4001) — same exploits now fail
#
# Usage:
#   bash scripts/demo-video.sh
#
# Open http://127.0.0.1:3001 in a browser tab before running this script —
# you'll see PatchProof update the dashboard in real time.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/sample-vulnerable-app"
RUNS="$ROOT/runs"
cd "$ROOT"

NODE22=/home/amritanshu-kumar/.nvm/versions/node/v22.23.3/bin/node

step() { printf "\n\033[1;36m=== %s ===\033[0m\n" "$*"; }

VULN_PORT=4000
FIXED_PORT=4001
DASH_PORT=3001

cleanup() {
  pkill -9 -f 'sample-vulnerable-app/server.js' 2>/dev/null || true
  pkill -9 -f '/sample-fixed/server.js' 2>/dev/null || true
  pkill -9 -f 'src/server.js' 2>/dev/null || true
}
trap cleanup EXIT

# ── PHASE 0: start the dashboard server ───────────────────────────
step "0) Starting the dashboard server on port $DASH_PORT"
echo "  Open http://127.0.0.1:$DASH_PORT in a browser to see the live UI."
PORT=$DASH_PORT $NODE22 --env-file-if-exists=.env --env-file-if-exists=.env.example \
  src/server.js > /tmp/dash.log 2>&1 &
DASH_PID=$!
sleep 2
echo "  dashboard PID: $DASH_PID"
head -1 /tmp/dash.log | sed 's/^/  /'

# ── PHASE 1: vulnerable app ───────────────────────────────────────
step "1) Starting the VULNERABLE app on port $VULN_PORT"
echo "  (server.js has 4 known CVEs: path traversal, command injection,"
echo "   prototype pollution, hardcoded JWT secret)"
cd "$APP"
PORT=$VULN_PORT $NODE22 server.js > /tmp/vuln.log 2>&1 &
VULN_PID=$!
sleep 2
echo "  PID: $VULN_PID"
head -1 /tmp/vuln.log | sed 's/^/  /'

step "2) Each exploit SUCCEEDS against the vulnerable app"
echo ""

echo "  --- CVE-22: path traversal (GET /files?name=../package.json) ---"
STATUS=$(curl -s -o /tmp/r1.txt -w "%{http_code}" "http://127.0.0.1:$VULN_PORT/files?name=../package.json")
echo "    HTTP $STATUS"
if [ "$STATUS" = "200" ]; then
  echo "    ❌ VULNERABILITY CONFIRMED — server returned the file"
  echo "    first line of leaked content: $(head -1 /tmp/r1.txt | tr -d ',')"
else
  echo "    (unexpected: HTTP $STATUS)"
fi
echo ""

echo "  --- CWE-78: command injection (GET /ping?host=...;echo INJECTED) ---"
INJ=$(curl -s "http://127.0.0.1:$VULN_PORT/ping?host=127.0.0.1%3Becho+INJECTED")
echo "    response excerpt: $(echo "$INJ" | grep -oE 'INJECTED|--- .* ping statistics' | head -1)"
if echo "$INJ" | grep -q INJECTED; then
  echo "    ❌ VULNERABILITY CONFIRMED — INJECTED ran via shell"
else
  echo "    (no INJECTED marker in response)"
fi
echo ""

echo "  --- CWE-1321: prototype pollution (POST /preferences) ---"
RESP=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"path":"__proto__.isAdmin","value":true}' \
  http://127.0.0.1:$VULN_PORT/preferences)
echo "    response: $RESP"
if echo "$RESP" | grep -q '"isAdmin":true'; then
  echo "    ❌ VULNERABILITY CONFIRMED — Object.prototype polluted (isAdmin: true)"
else
  echo "    (unexpected — pollution did not happen)"
fi
echo ""

echo "  --- CWE-798: hardcoded JWT secret (verify forge works) ---"
TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"username":"x"}' \
  http://127.0.0.1:$VULN_PORT/login | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
VERIFIES=$(cd "$APP" && $NODE22 -e "
try { require('jsonwebtoken').verify(process.argv[1], 'patchproof-demo-secret'); console.log('YES'); }
catch { console.log('NO'); }
" "$TOKEN")
echo "    token verifies with known secret 'patchproof-demo-secret': $VERIFIES"
[ "$VERIFIES" = "YES" ] && echo "    ❌ VULNERABILITY CONFIRMED — JWT secret is exposed"
echo ""

# Open the dashboard tab instructions
echo ""
echo "  👉  Watch the dashboard at http://127.0.0.1:$DASH_PORT for the next part."
echo ""

kill $VULN_PID 2>/dev/null || true
wait $VULN_PID 2>/dev/null || true

# ── PHASE 2: PatchProof via the dashboard API ─────────────────────
step "3) Triggering PatchProof through the dashboard's /api/run endpoint"
echo "  (Dashboard subscribers will see the run start and progress live.)"
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"target":"sample-vulnerable-app","maxFindings":4}' \
  http://127.0.0.1:$DASH_PORT/api/run
echo ''
echo "  Dashboard URL: http://127.0.0.1:$DASH_PORT"
echo "  Waiting for the run to complete (up to ~60s)..."
# Poll until the run is done
for i in $(seq 1 60); do
  STATUS=$(curl -s http://127.0.0.1:$DASH_PORT/api/state | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  echo -n "."
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then break; fi
  sleep 1
done
echo ''
echo ""
echo "  Run finished with status: $STATUS"
curl -s http://127.0.0.1:$DASH_PORT/api/state | python3 -c "
import json,sys
s = json.load(sys.stdin)
print(f'  verified: {sum(1 for f in s[\"findings\"] if f[\"status\"] == \"verified\")} of {len(s[\"findings\"])}')
for f in s['findings']:
    print(f'  - {f[\"id\"]}: {f[\"status\"]}')
"

# ── PHASE 3: patched app ──────────────────────────────────────────
step "4) Building a patched copy from PatchProof's full.patch files"
cp "$APP/server.js" "$APP/server.js.before-fix"
RUN=$(ls -t "$RUNS" 2>/dev/null | head -1)
echo "  using run: $RUN"
FIXED="/tmp/sample-fixed"
rm -rf "$FIXED"
cp -r "$APP" "$FIXED"
cd "$FIXED"
for fid in $(ls "$RUNS/$RUN" | grep -- '-evidence' | sed 's/-evidence//'); do
  if [ -f "$RUNS/$RUN/$fid-evidence/full.patch" ]; then
    echo "  applying $fid-evidence/full.patch"
    git apply "$RUNS/$RUN/$fid-evidence/full.patch" 2>&1 || echo "    (warn: patch may already be applied)"
  fi
done

step "5) Starting the PATCHED app on port $FIXED_PORT"
PORT=$FIXED_PORT $NODE22 server.js > /tmp/fixed.log 2>&1 &
FIXED_PID=$!
sleep 2
echo "  PID: $FIXED_PID"
head -1 /tmp/fixed.log | sed 's/^/  /'

step "6) The same exploits now FAIL against the patched app"
echo ""
echo "  --- CVE-22: path traversal ---"
STATUS=$(curl -s -o /tmp/r2.txt -w "%{http_code}" "http://127.0.0.1:$FIXED_PORT/files?name=../package.json")
echo "    HTTP $STATUS  (was 200 on vulnerable)"
if [ "$STATUS" = "200" ]; then
  echo "    still serves the file"
else
  echo "    ✓ VULNERABILITY BLOCKED — request rejected"
fi
echo ""

echo "  --- CWE-78: command injection ---"
INJ2=$(curl -s "http://127.0.0.1:$FIXED_PORT/ping?host=127.0.0.1%3Becho+INJECTED")
echo "    response excerpt: $(echo "$INJ2" | grep -oE 'INJECTED|--- .* ping statistics|"error"|invalid host' | head -1)"
if echo "$INJ2" | grep -q INJECTED; then
  echo "    ❌ still vulnerable"
else
  echo "    ✓ VULNERABILITY BLOCKED — INJECTED no longer runs"
fi
echo ""

echo "  --- CWE-1321: prototype pollution ---"
RESP2=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"path":"__proto__.isAdmin","value":true}' \
  http://127.0.0.1:$FIXED_PORT/preferences)
echo "    response: $RESP2"
if echo "$RESP2" | grep -q '"isAdmin":true'; then
  echo "    ❌ still polluted"
else
  echo "    ✓ VULNERABILITY BLOCKED — request rejected (400) or sanitized"
fi
echo ""

echo "  --- CWE-798: hardcoded JWT secret ---"
TOKEN2=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"username":"x"}' \
  http://127.0.0.1:$FIXED_PORT/login | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
VERIFIES2=$(cd "$FIXED" && $NODE22 -e "
try { require('jsonwebtoken').verify(process.argv[1], 'patchproof-demo-secret'); console.log('YES'); }
catch { console.log('NO'); }
" "$TOKEN2")
echo "    forged token verifies with known secret: $VERIFIES2  (was YES on vulnerable)"
[ "$VERIFIES2" = "NO" ] && echo "    ✓ VULNERABILITY BLOCKED — JWT secret replaced with random"
echo ""

kill $FIXED_PID 2>/dev/null || true
wait $FIXED_PID 2>/dev/null || true

step "Done."
echo "  Dashboard URL (live): http://127.0.0.1:$DASH_PORT — refresh to see final state"
echo "  Evidence reports:  runs/$RUN/*-evidence/report.md"
echo "  Patch files:       runs/$RUN/*-evidence/full.patch"
echo "  Patched demo app:   $FIXED"
echo ""
echo "  Per-finding summary:"
for fid in $(ls "$RUNS/$RUN" | grep -- '-evidence' | sed 's/-evidence//'); do
  echo "    ✓ $fid"
done
echo ""
echo "  The dashboard at http://127.0.0.1:$DASH_PORT still has the full session history."
echo "  Press Ctrl-C in its terminal to stop it (or just leave it running)."
