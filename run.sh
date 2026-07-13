#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="satisfactory-blueprint-restoration"
SAVE_DIR="${SAVE_DIR:-$SCRIPT_DIR/data}"

# Build if image doesn't exist or source changed
if ! podman image exists "$IMAGE_NAME" || [ "$SCRIPT_DIR/src/index.mjs" -nt "$(podman image inspect "$IMAGE_NAME" --format '{{.Created}}' 2>/dev/null || echo 0)" ]; then
    echo "Building container..."
    podman build -t "$IMAGE_NAME" "$SCRIPT_DIR"
fi

mkdir -p "$SAVE_DIR" "$SAVE_DIR/output"

podman run --rm \
    --read-only \
    --security-opt=no-new-privileges \
    -v "$SAVE_DIR:/data/saves:ro" \
    -v "$SAVE_DIR/output:/data/output:rw" \
    "$IMAGE_NAME" "$@"
