#!/usr/bin/env bash
# Start only the PatchProof dashboard. The UI is at http://127.0.0.1:3001.
# Use this for a clean UI walkthrough in the demo video.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE22=/home/amritanshu-kumar/.nvm/versions/node/v22.23.3/bin/node

cleanup() {
  pkill -9 -f 'src/server.js' 2>/dev/null || true
}
trap cleanup EXIT

PORT=${PORT:-3001}
HOST=${HOST:-127.0.0.1}
echo "🛡️  PatchProof dashboard starting on http://$HOST:$PORT"
echo "    (Mode is read from .env; if PP_REPLAY=1 the badge says REPLAY)"
exec $NODE22 --env-file-if-exists=.env --env-file-if-exists=.env.example \
  src/server.js
