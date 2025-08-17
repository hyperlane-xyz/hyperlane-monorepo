#!/usr/bin/env bash
set -euo pipefail


: "${WARP_DEPLOY_YAML:?Set WARP_DEPLOY_YAML}"
: "${SYMBOL:?Set SYMBOL}"
: "${REG1:=$HOME/.hyperlane}"
: "${REG2:=https://github.com/hyperlane-xyz/hyperlane-registry}"
: "${KEY:=}"

if [[ -n "$KEY" ]]; then
  hyperlane warp deploy --config "$WARP_DEPLOY_YAML" --key "$KEY"
else
  hyperlane warp deploy --config "$WARP_DEPLOY_YAML"
fi

hyperlane warp read --symbol "$SYMBOL" --registry "$REG1" --registry "$REG2" --json > /tmp/warp.json
echo "warpRouteId: $(jq -r '.warpRouteId // .routeId // empty' /tmp/warp.json)"
echo "routers:"
jq -r '.routers' /tmp/warp.json || true
