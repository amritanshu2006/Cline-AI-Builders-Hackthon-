#!/usr/bin/env bash
# PatchProof – build a submission archive.
# Excludes: .env, runs/, evidence/, node_modules/, the .venv/, target-repo/
# (which is huge) and the sample app's node_modules.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Sanity: .env must not be tracked.
if [ -f "$ROOT/.env" ] && git -C . ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "❌ .env is tracked by git. Remove it before packaging."; exit 1; fi

OUT="patchproof-submission-$(date +%Y%m%d).zip"
echo "📦 Building $OUT …"

# Use git archive so we respect .gitignore.
git archive --format=zip -o "$OUT" HEAD
echo "✅ Wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Show top-level contents so reviewers can see what's inside.
unzip -l "$OUT" | head -25
echo "…"
unzip -l "$OUT" | tail -5
