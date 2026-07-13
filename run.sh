#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="satisfactory-blueprint-restoration"
SAVE_DIR="${SAVE_DIR:-$SCRIPT_DIR/data}"
STAMP="$SCRIPT_DIR/.build-stamp"

# Rebuild if no stamp, no image, or any source file is newer than the stamp
needs_build=false
if ! podman image exists "$IMAGE_NAME" || [ ! -f "$STAMP" ]; then
    needs_build=true
elif find "$SCRIPT_DIR/src" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/Dockerfile" -newer "$STAMP" | grep -q .; then
    needs_build=true
fi

if [ "$needs_build" = true ]; then
    echo "Building container..."
    podman build -t "$IMAGE_NAME" "$SCRIPT_DIR"
    touch "$STAMP"
fi

mkdir -p "$SAVE_DIR" "$SAVE_DIR/output"

podman run --rm \
    --read-only \
    --security-opt=no-new-privileges \
    -v "$SAVE_DIR:/data/saves:ro" \
    -v "$SAVE_DIR/output:/data/output:rw" \
    "$IMAGE_NAME" "$@"
