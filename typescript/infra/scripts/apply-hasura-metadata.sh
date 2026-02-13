#!/usr/bin/env bash
set -euo pipefail

HASURA_URL="${HASURA_URL:-http://localhost:8080}"
: "${HASURA_ADMIN_SECRET:?Set HASURA_ADMIN_SECRET env var}"

TABLES=(domain message_view raw_message_dispatch)

for table in "${TABLES[@]}"; do
  echo "Tracking table: $table"
  curl -sf "$HASURA_URL/v1/metadata" \
    -H 'Content-Type: application/json' \
    -H "X-Hasura-Admin-Secret: $HASURA_ADMIN_SECRET" \
    -d "{\"type\":\"pg_track_table\",\"args\":{\"source\":\"default\",\"table\":{\"schema\":\"public\",\"name\":\"$table\"}}}" && echo " OK" || echo " (already tracked or error)"
done

for table in "${TABLES[@]}"; do
  echo "Granting anonymous select on: $table"
  curl -sf "$HASURA_URL/v1/metadata" \
    -H 'Content-Type: application/json' \
    -H "X-Hasura-Admin-Secret: $HASURA_ADMIN_SECRET" \
    -d "{\"type\":\"pg_create_select_permission\",\"args\":{\"source\":\"default\",\"table\":{\"schema\":\"public\",\"name\":\"$table\"},\"role\":\"anonymous\",\"permission\":{\"columns\":\"*\",\"filter\":{},\"allow_aggregations\":true}}}" && echo " OK" || echo " (already exists or error)"
done

echo ""
echo "Smoke test: querying domain table..."
curl -sf "$HASURA_URL/v1/graphql" \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { domain { id native_token name is_test_net is_deprecated chain_id } }"}' | head -c 200
echo ""
