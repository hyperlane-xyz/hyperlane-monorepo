#!/bin/bash
# Deploy a Base -> Ethereum USDC warp route with Predicate compliance

set -e

CONFIG_FILE="warp-config-predicate-base-ethereum.yaml"
WARP_ROUTE_ID="usdc-base-ethereum-predicate"

hyperlane warp deploy \
  --config "$CONFIG_FILE" \
  --key "$HYP_KEY" \
  --warp-route-id "$WARP_ROUTE_ID" \
  --yes
