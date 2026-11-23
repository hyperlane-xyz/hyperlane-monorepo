#!/usr/bin/env bash
#
# End-to-end fork test for set-merchant-btc-deposit-address.ts.
#
# The WBTC merchant Factory/Members contracts only exist on Ethereum mainnet, so
# this test forks mainnet (NOT BSC — BSC has no such contracts). It:
#   1. Forks Ethereum mainnet with anvil.
#   2. Impersonates the Members owner and grants merchant status to a throwaway
#      test key (proving the script works for an arbitrary approved merchant).
#   3. Runs the script with that test key against the fork.
#   4. Asserts the on-chain merchantBtcDepositAddress matches the input.
#
# Requires: anvil, cast, pnpm, and a mainnet RPC to fork from.
#
#   ETH_FORK_RPC_URL=https://ethereum-rpc.publicnode.com ./fork-test.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

FORK_RPC_URL="${ETH_FORK_RPC_URL:-https://ethereum-rpc.publicnode.com}"
LOCAL_RPC="http://127.0.0.1:8545"

# Canonical mainnet contracts.
FACTORY="0xe5A5F138005E19A3E6D0FE68b039397EeEf2322b"
MEMBERS="0x3e8640574aa764763291eD733672D3A105107ac5"
MEMBERS_OWNER="0x4dbbbFb0e68bE9D8F5a377A4654604a62E851e80"

# anvil default account #0 — throwaway test identity. The private key is
# derived at runtime from anvil's well-known default mnemonic so no key literal
# is committed to the repo.
ANVIL_MNEMONIC="test test test test test test test test test test test junk"
TEST_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
TEST_KEY="$(cast wallet private-key "$ANVIL_MNEMONIC" 0)"

BTC_ADDR="bc1q8d8fe5ptt67qd2xasndwx0edk8vgnxv8qcejtk"

ANVIL_PID=""
cleanup() {
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo ">>> Starting anvil fork of Ethereum mainnet..."
anvil --fork-url "$FORK_RPC_URL" --port 8545 --silent &
ANVIL_PID=$!

echo ">>> Waiting for anvil to be ready..."
for _ in $(seq 1 30); do
  if cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null

echo ">>> Sanity: test key is NOT yet a merchant"
BEFORE=$(cast call "$MEMBERS" "isMerchant(address)(bool)" "$TEST_ADDR" --rpc-url "$LOCAL_RPC")
echo "    isMerchant($TEST_ADDR) = $BEFORE"
if [[ "$BEFORE" != "false" ]]; then
  echo "!!! Unexpected: test key already a merchant" >&2
  exit 1
fi

echo ">>> Granting merchant status via impersonated Members owner..."
cast rpc anvil_impersonateAccount "$MEMBERS_OWNER" --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_setBalance "$MEMBERS_OWNER" 0xDE0B6B3A7640000 --rpc-url "$LOCAL_RPC" >/dev/null
cast send "$MEMBERS" "addMerchant(address)" "$TEST_ADDR" \
  --from "$MEMBERS_OWNER" --unlocked --rpc-url "$LOCAL_RPC" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$MEMBERS_OWNER" --rpc-url "$LOCAL_RPC" >/dev/null

AFTER=$(cast call "$MEMBERS" "isMerchant(address)(bool)" "$TEST_ADDR" --rpc-url "$LOCAL_RPC")
echo "    isMerchant($TEST_ADDR) = $AFTER"
if [[ "$AFTER" != "true" ]]; then
  echo "!!! Failed to grant merchant status" >&2
  exit 1
fi

echo ">>> Running the script against the fork..."
TSX_BIN="$INFRA_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  TSX_BIN="$(cd "$INFRA_DIR/../.." && pwd)/node_modules/.bin/tsx"
fi
(
  cd "$INFRA_DIR"
  WBTC_RPC_URL="$LOCAL_RPC" \
  WBTC_MERCHANT_PRIVATE_KEY="$TEST_KEY" \
  WBTC_BTC_DEPOSIT_ADDRESS="$BTC_ADDR" \
    "$TSX_BIN" scripts/wbtc/set-merchant-btc-deposit-address.ts
)

echo ">>> Verifying on-chain state..."
STORED=$(cast call "$FACTORY" "merchantBtcDepositAddress(address)(string)" "$TEST_ADDR" --rpc-url "$LOCAL_RPC")
echo "    merchantBtcDepositAddress($TEST_ADDR) = $STORED"
# cast returns the string wrapped in quotes.
if [[ "$STORED" != "\"$BTC_ADDR\"" ]]; then
  echo "!!! MISMATCH: expected \"$BTC_ADDR\", got $STORED" >&2
  exit 1
fi

echo ">>> PASS: merchant BTC deposit address set and verified on the fork."
