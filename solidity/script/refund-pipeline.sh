#!/bin/bash
set -euo pipefail

# HypERC20Collateral Refund Pipeline
# Generates Safe Transaction Builder JSON for refunding stuck USDC to designated recipient
#
# Required environment variables:
#   RPC_URL        - RPC URL for the chain (Ink)
#   OLD_ROUTER     - Address of the old HypERC20Collateral contract
#   REMOTE_DOMAIN  - Any enrolled remote domain to spoof messages from
#   TX_HASHES      - Comma-separated list of stuck transaction hashes
#   REFUND_RECIPIENT - Address to receive all refunded tokens
#
# Optional environment variables:
#   SAFE_ADDRESS   - Override the Safe address (default: read from old router owner)
#   OUTPUT_FILE    - Output JSON file path (default: refund_transactions.json)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

: "${RPC_URL:?RPC_URL is required}"
: "${OLD_ROUTER:?OLD_ROUTER is required}"
: "${REMOTE_DOMAIN:?REMOTE_DOMAIN is required}"
: "${TX_HASHES:?TX_HASHES is required}"
: "${REFUND_RECIPIENT:?REFUND_RECIPIENT is required}"

OUTPUT_FILE="${OUTPUT_FILE:-refund_transactions.json}"

if [ -z "${SAFE_ADDRESS:-}" ]; then
	echo "Fetching Safe address from old router owner..."
	SAFE_ADDRESS=$(cast call "$OLD_ROUTER" "owner()(address)" --rpc-url "$RPC_URL")
	echo "Safe address: $SAFE_ADDRESS"
fi

# --- Fetch refund amounts from transaction hashes ---
echo "Fetching refund amounts from transaction hashes..."
SENT_TRANSFER_REMOTE_TOPIC="0xd229aacb94204188fe8042965fa6b269c62dc5818b21238779ab64bdd17efeec"
OLD_ROUTER_LOWER=$(echo "$OLD_ROUTER" | tr '[:upper:]' '[:lower:]')
REFUND_AMOUNT=0

IFS=',' read -ra HASHES <<< "$TX_HASHES"
for TX_HASH in "${HASHES[@]}"; do
	echo "Processing tx: $TX_HASH"
	RECEIPT=$(cast receipt "$TX_HASH" --rpc-url "$RPC_URL" --json)

	# Find SentTransferRemote event emitted by OLD_ROUTER
	LOG=$(echo "$RECEIPT" | jq --arg router "$OLD_ROUTER_LOWER" --arg topic "$SENT_TRANSFER_REMOTE_TOPIC" \
		'[.logs[] | select(.address == $router and .topics[0] == $topic)] | first')

	if [ "$LOG" = "null" ] || [ -z "$LOG" ]; then
		echo "  WARNING: No SentTransferRemote event found, skipping"
		continue
	fi

	# Extract amount (data)
	AMOUNT_HEX=$(echo "$LOG" | jq -r '.data')
	AMOUNT=$(cast to-dec "$AMOUNT_HEX")

	echo "  Amount: $AMOUNT"
	REFUND_AMOUNT=$((REFUND_AMOUNT + AMOUNT))
done

if [ "$REFUND_AMOUNT" -eq 0 ]; then
	echo "Error: No refund amounts found from transaction hashes"
	exit 1
fi

export REFUND_RECIPIENT
export REFUND_AMOUNT
echo "Refund recipient: $REFUND_RECIPIENT"
echo "Refund total amount: $REFUND_AMOUNT"

echo "Starting anvil fork..."
anvil --fork-url "$RPC_URL" --port 8546 >/dev/null 2>&1 &
ANVIL_PID=$!
trap "kill $ANVIL_PID 2>/dev/null || true" EXIT

echo "Waiting for anvil..."
until curl -s http://localhost:8546 >/dev/null 2>&1; do
	sleep 0.5
done
echo "Anvil ready"

echo "Impersonating Safe: $SAFE_ADDRESS"
cast rpc anvil_impersonateAccount "$SAFE_ADDRESS" --rpc-url http://localhost:8546 >/dev/null
cast rpc anvil_setBalance "$SAFE_ADDRESS" 0xDE0B6B3A7640000 --rpc-url http://localhost:8546 >/dev/null

echo "Running refund script..."
OLD_ROUTER="$OLD_ROUTER" \
	REMOTE_DOMAIN="$REMOTE_DOMAIN" \
	forge script script/HypERC20CollateralRefund.s.sol:HypERC20CollateralRefund \
	--rpc-url http://localhost:8546 \
	--unlocked \
	--sender "$SAFE_ADDRESS" \
	--broadcast \
	-vvvv

BROADCAST_FILE=$(find broadcast/HypERC20CollateralRefund.s.sol -name "run-latest.json" -not -path "*/dry-run/*" 2>/dev/null | head -1)
if [ -z "$BROADCAST_FILE" ]; then
	BROADCAST_FILE=$(find broadcast/HypERC20CollateralRefund.s.sol -name "run-latest.json" 2>/dev/null | head -1)
fi

if [ -z "$BROADCAST_FILE" ]; then
	echo "Error: Could not find broadcast JSON file"
	exit 1
fi

echo "Parsing broadcast file: $BROADCAST_FILE"

CHAIN_ID=$(jq -r '.chain' "$BROADCAST_FILE")
CHAIN_ID_HEX=$(printf "0x%x" "$CHAIN_ID")

echo "Generating Safe Transaction Builder JSON..."
jq --arg chainId "$CHAIN_ID_HEX" '{
    version: "1.0",
    chainId: $chainId,
    meta: {
        name: "HypERC20Collateral USDC Refund",
        description: "Refund stuck USDC from old HypERC20Collateral router to designated recipient"
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
echo "Import this file into the Safe Transaction Builder UI to execute the refund."
