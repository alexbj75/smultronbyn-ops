#!/bin/bash
# Test script for POST /ops/cd-webhook
#
# Usage:
#   export CD_WEBHOOK_SECRET="your-secret-here"
#   export OPS_URL="https://vgd4xzq2fj.apps.osaas.io"   # or http://localhost:3000
#   ./scripts/test-cd-webhook.sh
#
# All three test cases run automatically:
#   1. Valid request        -> expect 200 with {received: true, id, priority}
#   2. Invalid secret       -> expect 401
#   3. Missing required fields -> expect 400

set -euo pipefail

OPS_URL="${OPS_URL:-http://localhost:3000}"
SECRET="${CD_WEBHOOK_SECRET:-}"
ENDPOINT="${OPS_URL}/ops/cd-webhook"

if [ -z "$SECRET" ]; then
  echo "ERROR: CD_WEBHOOK_SECRET env var not set."
  echo "Usage: export CD_WEBHOOK_SECRET=<your-secret> && ./scripts/test-cd-webhook.sh"
  exit 1
fi

echo "=== Testar CD Webhook: ${ENDPOINT} ==="
echo ""

# --- Test 1: Giltig request ---
echo "[Test 1] Giltig request (forvanta: HTTP 200 + {received: true})"
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-CD-SECRET: $SECRET" \
  -d '{
    "uuid": "test-uuid-001",
    "watch_url": "https://www.adda.se/upphandling-och-ramavtal/vara-ramavtalsomraden/lekmaterial-2025/",
    "watch_title": "Adda Lekmaterial 2025",
    "change_datetime": "2026-04-10T07:00:00Z",
    "diff_url": "https://changedetection.example/diff/test-uuid-001",
    "diff": "Text changed: old -> new"
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

echo "  HTTP: $HTTP_CODE"
echo "  Body: $BODY"

if [ "$HTTP_CODE" = "200" ]; then
  echo "  [OK] Test 1 PASSERADE"
else
  echo "  [FAIL] Test 1 MISSLYCKADES — forvantade 200, fick $HTTP_CODE"
fi
echo ""

# --- Test 2: Ogiltig secret ---
echo "[Test 2] Ogiltig X-CD-SECRET (forvanta: HTTP 401)"
RESPONSE2=$(curl -s -w "\n%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-CD-SECRET: WRONG_SECRET" \
  -d '{
    "uuid": "test-uuid-002",
    "watch_url": "https://www.lekolar.se/produkter/",
    "watch_title": "Lekolar",
    "change_datetime": "2026-04-10T07:00:00Z"
  }')

HTTP_CODE2=$(echo "$RESPONSE2" | tail -n1)
BODY2=$(echo "$RESPONSE2" | head -n-1)

echo "  HTTP: $HTTP_CODE2"
echo "  Body: $BODY2"

if [ "$HTTP_CODE2" = "401" ]; then
  echo "  [OK] Test 2 PASSERADE"
else
  echo "  [FAIL] Test 2 MISSLYCKADES — forvantade 401, fick $HTTP_CODE2"
fi
echo ""

# --- Test 3: Saknade obligatoriska falt ---
echo "[Test 3] Saknade obligatoriska falt (forvanta: HTTP 400)"
RESPONSE3=$(curl -s -w "\n%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-CD-SECRET: $SECRET" \
  -d '{
    "uuid": "test-uuid-003"
  }')

HTTP_CODE3=$(echo "$RESPONSE3" | tail -n1)
BODY3=$(echo "$RESPONSE3" | head -n-1)

echo "  HTTP: $HTTP_CODE3"
echo "  Body: $BODY3"

if [ "$HTTP_CODE3" = "400" ]; then
  echo "  [OK] Test 3 PASSERADE"
else
  echo "  [FAIL] Test 3 MISSLYCKADES — forvantade 400, fick $HTTP_CODE3"
fi
echo ""

echo "=== Alla tester klara ==="
