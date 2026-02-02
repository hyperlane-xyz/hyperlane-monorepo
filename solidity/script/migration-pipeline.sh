#!/bin/bash
set -euo pipefail

# HypNative Collateral Migration Pipeline
# Generates Safe Transaction Builder JSON for migrating collateral from old to new HypNative
#
# Required environment variables:
#   ETH_RPC_URL    - Ethereum mainnet RPC URL for forking
#   OLD_ROUTER     - Address of the old HypNative contract
#   NEW_ROUTER     - Address of the new HypNative contract
#   REMOTE_DOMAIN  - Domain ID of the remote chain
#   PROXY_ADMIN    - Address of pre-deployed ProxyAdmin (must be owned by Safe)
#
# Optional environment variables:
#   SAFE_ADDRESS   - Override the Safe address (default: read from old router owner)
#   OUTPUT_FILE    - Output JSON file path (default: migration_transactions.json)
#
# Usage:
#   ETH_RPC_URL=https://... OLD_ROUTER=0x... NEW_ROUTER=0x... REMOTE_DOMAIN=88 PROXY_ADMIN=0x... ./script/migration-pipeline.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Validate required env vars
: "${ETH_RPC_URL:?ETH_RPC_URL is required}"
: "${OLD_ROUTER:?OLD_ROUTER is required}"
: "${NEW_ROUTER:?NEW_ROUTER is required}"
: "${REMOTE_DOMAIN:?REMOTE_DOMAIN is required}"
: "${PROXY_ADMIN:?PROXY_ADMIN is required}"

# Default output file
OUTPUT_FILE="${OUTPUT_FILE:-migration_transactions.json}"

# Get Safe address from old router owner if not provided
if [ -z "${SAFE_ADDRESS:-}" ]; then
	echo "Fetching Safe address from old router owner..."
	SAFE_ADDRESS=$(cast call "$OLD_ROUTER" "owner()(address)" --rpc-url "$ETH_RPC_URL")
	echo "Safe address: $SAFE_ADDRESS"
fi

# Start anvil fork in background
echo "Starting anvil fork..."
anvil --fork-url "$ETH_RPC_URL" --port 8546 >/dev/null 2>&1 &
ANVIL_PID=$!
trap "kill $ANVIL_PID 2>/dev/null || true" EXIT

# Wait for anvil to be ready
echo "Waiting for anvil..."
until curl -s http://localhost:8546 >/dev/null 2>&1; do
	sleep 0.5
done
echo "Anvil ready"

# Impersonate the Safe
echo "Impersonating Safe: $SAFE_ADDRESS"
cast rpc anvil_impersonateAccount "$SAFE_ADDRESS" --rpc-url http://localhost:8546 >/dev/null

# Run the migration script
echo "Running migration script..."
OLD_ROUTER="$OLD_ROUTER" \
	NEW_ROUTER="$NEW_ROUTER" \
	REMOTE_DOMAIN="$REMOTE_DOMAIN" \
	PROXY_ADMIN="$PROXY_ADMIN" \
	forge script script/HypNativeCollateralMigration.s.sol:HypNativeCollateralMigration \
	--rpc-url http://localhost:8546 \
	--unlocked \
	--sender "$SAFE_ADDRESS" \
	--broadcast \
	-vvvv

# Find the broadcast JSON file
BROADCAST_FILE=$(find broadcast/HypNativeCollateralMigration.s.sol -name "run-latest.json" -path "*/dry-run/*" 2>/dev/null | head -1)
if [ -z "$BROADCAST_FILE" ]; then
	BROADCAST_FILE=$(find broadcast/HypNativeCollateralMigration.s.sol -name "run-latest.json" 2>/dev/null | head -1)
fi

if [ -z "$BROADCAST_FILE" ]; then
	echo "Error: Could not find broadcast JSON file"
	exit 1
fi

echo "Parsing broadcast file: $BROADCAST_FILE"

# Get chain ID
CHAIN_ID=$(jq -r '.chain' "$BROADCAST_FILE")
CHAIN_ID_HEX=$(printf "0x%x" "$CHAIN_ID")

# Parse transactions and create Safe TX Builder JSON
echo "Generating Safe Transaction Builder JSON..."
jq --arg chainId "$CHAIN_ID_HEX" '{
    version: "1.0",
    chainId: $chainId,
    meta: {
        name: "HypNative Collateral Migration",
        description: "Migrate collateral from old non-proxied HypNative to new proxied HypNative"
    },
    transactions: [.transactions[] | {
        to: .transaction.to,
        value: (if .transaction.value == null then "0" else .transaction.value end),
        data: .transaction.input
    }]
}' "$BROADCAST_FILE" >"$OUTPUT_FILE"

echo ""
echo "=== Pipeline Complete ==="
echo "Output file: $OUTPUT_FILE"
echo "Chain ID: $CHAIN_ID ($CHAIN_ID_HEX)"
echo "Transactions: $(jq '.transactions | length' "$OUTPUT_FILE")"
echo ""
echo "Import this file into the Safe Transaction Builder UI to execute the migration."
