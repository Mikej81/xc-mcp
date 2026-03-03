#!/usr/bin/env bash
set -euo pipefail

SPEC_URL="https://docs.cloud.f5.com/docs-v2/downloads/f5-distributed-cloud-open-api.zip"
TARGET_DIR="f5-api"

echo "Downloading F5 XC OpenAPI specs..."

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

curl -fsSL -o "$tmp" "$SPEC_URL"

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
unzip -q -o "$tmp" -d "$TARGET_DIR"

count=$(find "$TARGET_DIR" -name '*.json' -type f | wc -l)
echo "Extracted $count spec files into $TARGET_DIR/"
