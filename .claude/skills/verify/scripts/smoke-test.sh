#!/usr/bin/env bash
set -euo pipefail

# Smoke test: ingest a markdown file, then search it
# Exit 0 = pass, non-zero = fail

export LUMEN_DIR=$(mktemp -d)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

cd "$PROJECT_DIR"

# Create test content
TEST_FILE=$(mktemp "${LUMEN_DIR}/test-XXXXXX.md")
cat > "$TEST_FILE" << 'EOF'
# Test Article

This is a test article about knowledge graphs and information retrieval.

## Key Concepts

Knowledge graphs represent structured information as nodes and edges.
BM25 is a ranking function used in information retrieval.

## Applications

Search engines use BM25 to rank documents by relevance to a query.
EOF

echo "=== Smoke Test ==="
echo "Data dir: $LUMEN_DIR"
echo "Test file: $TEST_FILE"

# Test: add a file
echo ""
echo "--- Testing: lumen add ---"
npx tsx src/cli.ts add "$TEST_FILE"

# Test: search
echo ""
echo "--- Testing: lumen search ---"
OUTPUT=$(npx tsx src/cli.ts search "knowledge graphs" 2>&1)
echo "$OUTPUT"

# Verify search returned results
if echo "$OUTPUT" | grep -q "result"; then
    echo ""
    echo "=== PASS ==="
else
    echo ""
    echo "=== FAIL: search returned no results ==="
    exit 1
fi

# Test: dedup (add same file again)
echo ""
echo "--- Testing: dedup detection ---"
DEDUP_OUTPUT=$(npx tsx src/cli.ts add "$TEST_FILE" 2>&1)
echo "$DEDUP_OUTPUT"

if echo "$DEDUP_OUTPUT" | grep -q "already exists"; then
    echo ""
    echo "=== DEDUP PASS ==="
else
    echo ""
    echo "=== FAIL: dedup not detected ==="
    exit 1
fi

# Cleanup
rm -rf "$LUMEN_DIR"
echo ""
echo "=== All smoke tests passed ==="
