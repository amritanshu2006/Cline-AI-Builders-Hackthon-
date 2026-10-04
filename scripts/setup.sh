#!/usr/bin/env bash
# PatchProof – one-time setup. Run from the project root.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "🛡️  PatchProof setup"
echo "   Root: $ROOT"

# 1. Node ≥ 22
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ Node.js ≥ 22 is required (you have $(node --version 2>/dev/null || echo 'no node'))."
  echo "   Install Node 22+: https://nodejs.org/en/download"
  exit 1
fi
echo "✅ Node $(node --version)"

# 2. .env – create from example if missing, never overwrite
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "📝 Created .env from .env.example — open it and set PP_PROVIDER / PP_MODEL / PP_API_KEY."
  echo "   Note: 'openai' is NOT a valid id — use 'openai-native'."
else
  echo "✅ .env already present"
fi

# 3. npm deps
echo "📦 Installing host dependencies..."
npm install --omit=dev

# 4. Semgrep (optional)
if command -v semgrep >/dev/null 2>&1; then
  echo "✅ Semgrep $(semgrep --version) already installed"
elif command -v pip3 >/dev/null 2>&1; then
  echo "📦 Installing Semgrep via pip3..."
  if pip3 install --user --break-system-packages semgrep 2>/dev/null || pip3 install --user semgrep 2>/dev/null; then
    echo "✅ Semgrep installed"
  else
    echo "⚠️  Semgrep not installed – scanner will still work via patchproof.findings.json"
  fi
else
  echo "⚠️  pip3 not found – skipping Semgrep install"
fi

# 5. Docker sandbox image (optional)
if command -v docker >/dev/null 2>&1; then
  echo "🐳 Building Docker sandbox image (optional)..."
  if docker build -t patchproof-sandbox:latest sandbox-runner/ 2>/dev/null; then
    echo "✅ patchproof-sandbox image ready"
  else
    echo "⚠️  Docker build skipped (sandbox-runner/ not present or build failed)"
  fi
fi

cat << 'NEXT'

✅ Setup complete!

📋 Next steps
   1. Edit .env. Uncomment exactly ONE block, e.g.:

        PP_PROVIDER=openai-native
        PP_MODEL=gpt-4o-mini
        PP_API_KEY=sk-...

   2. (Optional) Try the offline demo first to make sure the pipeline works:

        npm run demo:replay      # pre-recorded, no API credits

   3. Then run with the real Cline SDK:

        npm run demo             # uses your PP_API_KEY, costs credits

   4. Or start the dashboard:

        npm start
        open http://127.0.0.1:3000

   5. Build a submission archive (excludes .env, runs/, node_modules/):

        npm run package

NEXT
