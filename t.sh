#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Type Check ==="
bun run typecheck
echo ""

echo "=== Lint ==="
bun run lint
echo ""

echo "=== Tests ==="
bun run test
echo ""

echo "=== Build ==="
bun run build
echo ""

echo "=== All OK ==="