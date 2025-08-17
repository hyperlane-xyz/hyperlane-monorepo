#!/usr/bin/env bash
set -euo pipefail

SEPOLIA_RPC_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
ARBSEP_RPC_URL="${ARBSEP_RPC_URL:-https://api.zan.top/arb-sepolia}"
PK="${PK:?set PK environment variable to the EOA private key}"

SEPOLIA_TOKEN="${SEPOLIA_TOKEN:?}"
ARBSEP_TOKEN="${ARBSEP_TOKEN:?}"
SEPOLIA_ROUTER="${SEPOLIA_ROUTER:?}"
ARBSEP_ROUTER="${ARBSEP_ROUTER:?}"
SEPOLIA_AMOUNT="${SEPOLIA_AMOUNT:-100000000000000000000}"
ARBSEP_AMOUNT="${ARBSEP_AMOUNT:-50000000000000000000}"

export ETH_RPC_URL="$SEPOLIA_RPC_URL"
cast call "$SEPOLIA_TOKEN" "balanceOf(address)(uint256)" "$SEPOLIA_ROUTER" || true
cast send "$SEPOLIA_TOKEN" "mint(address,uint256)" "$SEPOLIA_ROUTER" "$SEPOLIA_AMOUNT" --private-key "$PK" --legacy --gas-price 15000000
cast call "$SEPOLIA_TOKEN" "balanceOf(address)(uint256)" "$SEPOLIA_ROUTER"

export ETH_RPC_URL="$ARBSEP_RPC_URL"
cast call "$ARBSEP_TOKEN" "balanceOf(address)(uint256)" "$ARBSEP_ROUTER" || true
cast send "$ARBSEP_TOKEN" "mint(address,uint256)" "$ARBSEP_ROUTER" "$ARBSEP_AMOUNT" --private-key "$PK" --legacy --gas-price 250000
cast call "$ARBSEP_TOKEN" "balanceOf(address)(uint256)" "$ARBSEP_ROUTER"
