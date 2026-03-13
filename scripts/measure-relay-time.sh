#!/bin/bash

# Measure Hyperlane message relay time with statistics
# Usage: ./measure-relay-time.sh [num_transfers] [amount_in_wei] [--use-relay-api] [--random-delay]
#
# Flags:
#   --use-relay-api: Use fast relay API instead of normal indexing
#   --random-delay: Add random 0-30s delay between messages (simulates real-world usage)

set -e

# Configuration
ORIGIN_RPC="http://127.0.0.1:8545"
DEST_RPC="http://127.0.0.1:8546"
RELAY_API_URL="http://127.0.0.1:9090/relay"
WARP_TOKEN="0x59b670e9fA9D0A427751Af201D676719a970857b"
DEST_DOMAIN="31338"
RECIPIENT="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
RECIPIENT_BYTES32="0x000000000000000000000000f39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ORIGIN_CHAIN="test4"

# Parse arguments
NUM_TRANSFERS="${1:-20}" # Default 20 transfers
AMOUNT="${2:-1000000000000000000}" # Default 1 ETH
USE_RELAY_API=false
USE_RANDOM_DELAY=false
MAX_RANDOM_DELAY=30

if [[ "$*" == *"--use-relay-api"* ]]; then
  USE_RELAY_API=true
fi

if [[ "$*" == *"--random-delay"* ]]; then
  USE_RANDOM_DELAY=true
fi

echo "╔════════════════════════════════════════════════════════════╗"
echo "║      Hyperlane Relay Time Measurement - Benchmark         ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Configuration:"
echo "  Transfers: $NUM_TRANSFERS"
echo "  Amount: $AMOUNT wei per transfer"
echo "  Origin: ethereumlocal1 ($ORIGIN_RPC)"
echo "  Destination: ethereumlocal2 ($DEST_RPC)"
if [ "$USE_RELAY_API" = true ]; then
  echo "  Relay Mode: ⚡ Fast Relay API ($RELAY_API_URL)"
else
  echo "  Relay Mode: 📡 Normal Indexing"
fi
if [ "$USE_RANDOM_DELAY" = true ]; then
  echo "  Spacing: 🎲 Random delay (0-${MAX_RANDOM_DELAY}s between messages)"
else
  echo "  Spacing: ⏱️  Fixed 1s delay between messages"
fi
echo ""

# Array to store relay times
declare -a RELAY_TIMES=()
SUCCESSFUL=0
FAILED=0

# Function to send one transfer and measure time
measure_transfer() {
  local TRANSFER_NUM=$1

  echo "────────────────────────────────────────────────────────────"
  echo "Transfer #$TRANSFER_NUM/$NUM_TRANSFERS"
  echo "────────────────────────────────────────────────────────────"

  # Get current balance
  CURRENT_BALANCE=$(cast call $WARP_TOKEN \
    "balanceOf(address)" \
    $RECIPIENT \
    --rpc-url $DEST_RPC)
  CURRENT_BALANCE_DEC=$((16#${CURRENT_BALANCE:2}))
  EXPECTED_BALANCE=$((CURRENT_BALANCE_DEC + AMOUNT))

  # Send transfer and record timestamp
  echo -n "Sending transfer... "
  START_TIME=$(python3 -c 'import time; print(int(time.time() * 1000))')

  TX_HASH=$(cast send $WARP_TOKEN \
    "transferRemote(uint32,bytes32,uint256)" \
    $DEST_DOMAIN \
    $RECIPIENT_BYTES32 \
    $AMOUNT \
    --rpc-url $ORIGIN_RPC \
    --private-key $PRIVATE_KEY \
    --value $AMOUNT \
    --json 2>/dev/null | jq -r '.transactionHash')

  echo "✓ ($TX_HASH)"

  # Submit to relay API if enabled
  if [ "$USE_RELAY_API" = true ]; then
    echo -n "  Submitting to relay API... "
    RELAY_RESPONSE=$(curl -s -X POST $RELAY_API_URL \
      -H "Content-Type: application/json" \
      -d "{\"origin_chain\":\"$ORIGIN_CHAIN\",\"tx_hash\":\"$TX_HASH\"}")

    MESSAGE_ID=$(echo $RELAY_RESPONSE | jq -r '.message_id // empty')
    if [ -n "$MESSAGE_ID" ]; then
      echo "✓ (message: $MESSAGE_ID)"
    else
      echo "✗ Failed: $RELAY_RESPONSE"
    fi
  fi

  # Poll destination balance until it changes
  echo -n "Waiting for delivery... "
  TIMEOUT=120
  POLL_INTERVAL=0.5
  ELAPSED=0

  while [ $ELAPSED -lt $TIMEOUT ]; do
    NEW_BALANCE=$(cast call $WARP_TOKEN \
      "balanceOf(address)" \
      $RECIPIENT \
      --rpc-url $DEST_RPC)
    NEW_BALANCE_DEC=$((16#${NEW_BALANCE:2}))

    if [ $NEW_BALANCE_DEC -ge $EXPECTED_BALANCE ]; then
      END_TIME=$(python3 -c 'import time; print(int(time.time() * 1000))')
      RELAY_TIME=$((END_TIME - START_TIME))

      echo "✓ Delivered in ${RELAY_TIME}ms"
      RELAY_TIMES+=($RELAY_TIME)
      SUCCESSFUL=$((SUCCESSFUL + 1))
      return 0
    fi

    sleep $POLL_INTERVAL
    ELAPSED=$((ELAPSED + 1))
  done

  echo "✗ Timeout (>${TIMEOUT}s)"
  FAILED=$((FAILED + 1))
  return 1
}

# Run transfers
echo "Starting benchmark..."
echo ""

for i in $(seq 1 $NUM_TRANSFERS); do
  measure_transfer $i

  # Delay between transfers
  if [ $i -lt $NUM_TRANSFERS ]; then
    if [ "$USE_RANDOM_DELAY" = true ]; then
      # Random delay between 0 and MAX_RANDOM_DELAY seconds
      DELAY=$((RANDOM % (MAX_RANDOM_DELAY + 1)))
      echo "  Waiting ${DELAY}s before next transfer..."
      sleep $DELAY
    else
      # Fixed 1 second delay
      sleep 1
    fi
  fi
done

# Calculate statistics
if [ ${#RELAY_TIMES[@]} -gt 0 ]; then
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "                      RESULTS                               "
  echo "════════════════════════════════════════════════════════════"
  echo ""
  echo "Transfers:"
  echo "  ✓ Successful: $SUCCESSFUL"
  echo "  ✗ Failed: $FAILED"
  echo ""

  # Calculate min, max, avg
  MIN=${RELAY_TIMES[0]}
  MAX=${RELAY_TIMES[0]}
  SUM=0

  for time in "${RELAY_TIMES[@]}"; do
    SUM=$((SUM + time))
    if [ $time -lt $MIN ]; then
      MIN=$time
    fi
    if [ $time -gt $MAX ]; then
      MAX=$time
    fi
  done

  AVG=$((SUM / ${#RELAY_TIMES[@]}))

  echo "Relay Times:"
  echo "  📊 Average: ${AVG}ms ($(python3 -c "print(f'{$AVG/1000:.2f}')") seconds)"
  echo "  ⚡ Minimum: ${MIN}ms ($(python3 -c "print(f'{$MIN/1000:.2f}')") seconds)"
  echo "  🐌 Maximum: ${MAX}ms ($(python3 -c "print(f'{$MAX/1000:.2f}')") seconds)"
  echo ""

  # Calculate median (sort and take middle value)
  IFS=$'\n' SORTED_TIMES=($(sort -n <<<"${RELAY_TIMES[*]}"))
  MEDIAN_IDX=$((${#SORTED_TIMES[@]} / 2))
  MEDIAN=${SORTED_TIMES[$MEDIAN_IDX]}
  echo "  📈 Median: ${MEDIAN}ms ($(python3 -c "print(f'{$MEDIAN/1000:.2f}')") seconds)"
  echo ""

  # Show all individual times
  echo "Individual Times:"
  for i in "${!RELAY_TIMES[@]}"; do
    printf "  #%-3d %5dms (%ss)\n" $((i+1)) ${RELAY_TIMES[$i]} $(python3 -c "print(f'{${RELAY_TIMES[$i]}/1000:.2f}')")
  done
  echo ""
  echo "════════════════════════════════════════════════════════════"
else
  echo ""
  echo "❌ No successful transfers completed"
  exit 1
fi
