# PatchProof sandbox image. Used when the CLI is called with --docker.
# - Based on Node 20 (matches our minimum runtime; the SDK is on the host).
# - Runs as a non-root user so cleanup can rm -rf the mounted sandbox copy.
# - Started with `--network=none` and `--read-only` at runtime.

FROM node:20-alpine

# Add a non-root user that owns the workspace mount.
RUN addgroup -g 1000 patchproof && \
    adduser  -u 1000 -G patchproof -D patchproof

WORKDIR /workspace
USER patchproof

# Default to a shell; the orchestrator invokes `npx jest --runInBand`.
CMD ["/bin/sh"]
