#!/bin/bash
# This script transfers HYPER and stHYPER tokens to specified recipients based on a CSV file.
# It reads recipient addresses and amounts from a CSV file, checks balances, stakes HYPER to mint stHYPER, 
# and transfers tokens accordingly. It also verifies the final balances after the transfers.

set -euo pipefail

total_sthyper_wei=0
total_hyper_wei=0
total_combined_wei=0

format_eth_number() {
  local value=$(cast --from-wei "$1")
  # Split into whole and decimal parts
  local whole=${value%.*}
  local decimal=${value#*.}
  # If value has no decimal part or it's all zeros, just show the whole number
  if [[ "$value" == "$whole" || "$decimal" =~ ^0+$ ]]; then
    printf "%'d\n" "$whole"
  else
    printf "%'d.%s\n" "$whole" "$decimal"
  fi
}

format_number() {
  printf "%'d\n" "$1"
}

# Function to convert ETH to wei
to_wei() {
  cast --to-wei "$1"
}

# Function to get the token contract address based on the symbol
get_token_contract() {
  local symbol=$1
  for i in "${!TOKEN_SYMBOLS[@]}"; do
    if [[ "${TOKEN_SYMBOLS[$i]}" == "$symbol" ]]; then
      echo "${TOKEN_ADDRESSES[$i]}"
      return
    fi
  done
  echo ""
}

# Function to get the token balance of a wallet
get_token_balance() {
  local token_address=$1
  local wallet=$2
  cast call "$token_address" "balanceOf(address)(uint256)" "$wallet" --rpc-url "$RPC_URL" | awk '{print $1}'
}

# Function to send a transaction to a contract
send_tx() {
  local contract=$1
  local calldata=$2
  local gas_limit=${3:-}

  if [[ -n "$PRIVATE_KEY" ]]; then
    cast send "$contract" "$calldata" ${gas_limit:+--gas-limit "$gas_limit"} --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL"
  else
    cast send "$contract" "$calldata" ${gas_limit:+--gas-limit "$gas_limit"} --from "$FUNDING_WALLET" --unlocked --rpc-url "$RPC_URL" > /dev/null
  fi
}

# Function to send tokens to a recipient
send_token() {
  local token_address=$1
  local recipient=$2
  local amount=$3
  local amount_wei
  amount_wei=$(to_wei "$amount")
  local calldata
  calldata=$(cast calldata "transfer(address,uint256)" "$recipient" "$amount_wei")
  
  # Estimate gas for the transfer
  local estimated_gas
  estimated_gas=$(cast estimate "$token_address" "transfer(address,uint256)" "$recipient" "$amount_wei" --from "$FUNDING_WALLET" --rpc-url "$RPC_URL")
  
  # Calculate buffered gas (150% of estimated gas)
  local buffered_gas
  buffered_gas=$(echo "$estimated_gas * 150 / 100" | bc)

  # Send the transaction and handle failure
  send_tx "$token_address" "$calldata" "$buffered_gas" || echo "❌ Transfer failed for $amount $token_address to $recipient"
}

CSV_FILE="/Users/nambrot/devstuff/hyperlane-monorepo/typescript/infra/config/environments/mainnet3/safe/liquifi/TGE2.csv" # Update as needed
TMP_CSV=$(mktemp)
tail -n +2 "$CSV_FILE" > "$TMP_CSV"
# Ensure the last line of the CSV file ends with a newline, otherwise the last row might be skipped during processing
if [ -n "$(tail -c1 "$CSV_FILE")" ]; then
  echo "" >> "$TMP_CSV"
fi
RPC_URL="${1:-http://localhost:8545}"  # Default to local fork
FUNDING_WALLET="0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba"   # 🔁 Replace with the actual sender address
PRIVATE_KEY="${PRIVATE_KEY:-}"         # Optional
VAULT="0xE1F23869776c82f691d9Cb34597Ab1830Fb0De58" # ← Replace with the correct vault address

# Map token symbols to contract addresses (update with real ones)
TOKENS=("HYPER" "stHYPER")
TOKEN_SYMBOLS=("HYPER" "stHYPER")
TOKEN_ADDRESSES=("0x93A2Db22B7c736B341C32Ff666307F4a9ED910F5" "0xE1F23869776c82f691d9Cb34597Ab1830Fb0De58")

##### Step 1: Record Initial Balances #####
BEFORE_BAL=()
echo "📊 Initial balances of $FUNDING_WALLET"
for i in "${!TOKEN_SYMBOLS[@]}"; do
  symbol="${TOKEN_SYMBOLS[$i]}"
  address="${TOKEN_ADDRESSES[$i]}"
  BEFORE_BAL[$i]=$(get_token_balance "$address" "$FUNDING_WALLET")
  echo "$symbol: $(format_eth_number "${BEFORE_BAL[$i]}") $symbol"
done

##### Step 2: Preprocess CSV and Accumulate stHYPER #####
echo ""
echo "🚀 Determining HYPER/stHYPER total"
while IFS=, read -r _ _ _ RECIPIENT_NAME RECIPIENT_ADDR CHAIN AMOUNT TOKEN_SYMBOL _; do
  [[ "$RECIPIENT_ADDR" == "Recipient (address)" || -z "$RECIPIENT_ADDR" ]] && continue
  [[ "$CHAIN" != "Ethereum" ]] && continue

  TOKEN_CONTRACT=$(get_token_contract "$TOKEN_SYMBOL")
  AMOUNT_WEI=$(to_wei "$AMOUNT")
  
  CURRENT_BALANCE=$(get_token_balance "$TOKEN_CONTRACT" "$RECIPIENT_ADDR")
  DIFF=$(echo "$AMOUNT_WEI - $CURRENT_BALANCE" | bc)

  if [[ "$TOKEN_SYMBOL" == "stHYPER" ]]; then
    if (( $(echo "$DIFF > 0" | bc -l) )); then
      total_sthyper_wei=$(echo "$total_sthyper_wei + $DIFF" | bc)
    fi
  else
    if (( $(echo "$DIFF > 0" | bc -l) )); then
      total_hyper_wei=$(echo "$total_hyper_wei + $DIFF" | bc)
    fi
  fi

done < "$TMP_CSV"
total_combined_wei=$(echo "$total_hyper_wei + $total_sthyper_wei" | bc)
echo "Total HYPER to send: $(format_eth_number "$total_hyper_wei")"
echo "Total stHYPER to stake/send: $(format_eth_number "$total_sthyper_wei")"
echo "Total combined: $(format_eth_number "$total_combined_wei")"

##### Step 3: Stake Total stHYPER #####
if (( $(echo "$total_sthyper_wei > 0" | bc -l) )); then
  echo "💠 Staking total of $(format_eth_number "$total_sthyper_wei") HYPER to mint stHYPER once"
  HYPER_TOKEN="0x93A2Db22B7c736B341C32Ff666307F4a9ED910F5"
  
  # Approve the vault to spend HYPER tokens
  APPROVE_DATA=$(cast calldata "approve(address,uint256)" "$VAULT" "$total_sthyper_wei")
  send_tx "$HYPER_TOKEN" "$APPROVE_DATA"
  
  # Deposit HYPER tokens into the vault
  DEPOSIT_DATA=$(cast calldata "deposit(address,uint256)" "$FUNDING_WALLET" "$total_sthyper_wei")
  send_tx "$VAULT" "$DEPOSIT_DATA"
fi

##### Step 4: Transfer Tokens to Recipients #####
while IFS=, read -r _ _ _ RECIPIENT_NAME RECIPIENT_ADDR CHAIN AMOUNT TOKEN_SYMBOL _; do
  [[ "$RECIPIENT_ADDR" == "Recipient (address)" || -z "$RECIPIENT_ADDR" ]] && continue
  [[ "$CHAIN" != "Ethereum" ]] && continue

  TOKEN_CONTRACT=$(get_token_contract "$TOKEN_SYMBOL")

  if [[ -z "$TOKEN_CONTRACT" ]]; then
    echo "⚠️ Unknown token: $TOKEN_SYMBOL, skipping..."
    continue
  fi

  actual_balance=$(get_token_balance "$TOKEN_CONTRACT" "$RECIPIENT_ADDR")
  expected_balance=$(to_wei "$AMOUNT")
  
  DIFF=$(echo "$expected_balance - $actual_balance" | bc)
  if (( $(echo "$DIFF <= 0" | bc -l) )); then
    echo "✅ Skipping transfer to $RECIPIENT_ADDR for $TOKEN_SYMBOL (already has correct or excess balance)"
    continue
  fi

  # Check that the recipient is a smart contract (non-empty code)
  if [[ -z "$(cast code "$RECIPIENT_ADDR" --rpc-url "$RPC_URL")" || "$(cast code "$RECIPIENT_ADDR" --rpc-url "$RPC_URL")" == "0x" ]]; then
    echo "⚠️ Skipping $RECIPIENT_ADDR — not a smart contract"
    continue
  fi

  echo "Transferring $(cast --from-wei "$DIFF") $TOKEN_SYMBOL → $RECIPIENT_NAME ($RECIPIENT_ADDR)"
  send_token "$TOKEN_CONTRACT" "$RECIPIENT_ADDR" $(cast --from-wei "$DIFF")

done < "$TMP_CSV"

##### Step 5: Verify Recipient Balances #####
echo ""
echo "✅ Verifying recipient balances..."
while IFS=, read -r _ _ _ RECIPIENT_NAME RECIPIENT_ADDR CHAIN AMOUNT TOKEN_SYMBOL _; do
  [[ "$RECIPIENT_ADDR" == "Recipient (address)" || -z "$RECIPIENT_ADDR" ]] && continue
  [[ "$CHAIN" != "Ethereum" ]] && continue

  EXPECTED_BALANCE_WEI=$(to_wei "$AMOUNT")

  for i in "${!TOKEN_SYMBOLS[@]}"; do
    if [[ "${TOKEN_SYMBOLS[$i]}" == "$TOKEN_SYMBOL" ]]; then
      TOKEN_CONTRACT="${TOKEN_ADDRESSES[$i]}"
      ACTUAL_BALANCE=$(get_token_balance "$TOKEN_CONTRACT" "$RECIPIENT_ADDR")
      
      # Check if the actual balance matches the expected balance
      if [[ "$ACTUAL_BALANCE" != "$EXPECTED_BALANCE_WEI" ]]; then
        echo "❌ Mismatch for $RECIPIENT_NAME ($RECIPIENT_ADDR) ($TOKEN_SYMBOL): expected $(format_eth_number "$EXPECTED_BALANCE_WEI"), got $(format_eth_number "$ACTUAL_BALANCE")"
      else
        echo "✅ $TOKEN_SYMBOL balance correct for $RECIPIENT_NAME ($RECIPIENT_ADDR): $(format_eth_number "$ACTUAL_BALANCE")"
      fi
    fi
  done
done < "$TMP_CSV"

##### Step 6: Report Final Balances #####
echo ""
echo "📊 Final balances and delta for $FUNDING_WALLET"
for i in "${!TOKEN_SYMBOLS[@]}"; do
  symbol="${TOKEN_SYMBOLS[$i]}"
  address="${TOKEN_ADDRESSES[$i]}"
  final=$(get_token_balance "$address" "$FUNDING_WALLET")
  before=${BEFORE_BAL[$i]}
  delta_wei=$(echo "$before - $final" | bc)
  delta_eth=$(cast --from-wei "$delta_wei")
  echo "$symbol: Before=$(format_eth_number "$before") | After=$(format_eth_number "$final") | Sent=$(format_eth_number "$delta_wei") $symbol"
  
done
rm "$TMP_CSV"