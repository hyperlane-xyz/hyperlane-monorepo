#!/usr/bin/env bash
set -euo pipefail

# Demo setup for Token Transfer ICA with local execution
# Starts anvil, deploys core + ICA router + ERC20, writes config

ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ANVIL_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
CHAIN_NAME="anvil1"
CHAIN_ID=31337
DOMAIN_ID=31337
RPC_URL="http://127.0.0.1:8545"
REGISTRY_PATH="/tmp/demo-registry"
CONFIG_OUT="/tmp/demo-config.json"

echo "=== Token Transfer ICA Demo Setup ==="

# 1. Start anvil
echo "Starting anvil..."
if lsof -i :8545 &>/dev/null; then
  echo "Port 8545 already in use, killing existing process..."
  kill $(lsof -t -i :8545) 2>/dev/null || true
  sleep 1
fi
anvil --chain-id $CHAIN_ID --port 8545 &
ANVIL_PID=$!
sleep 2
echo "Anvil running (PID $ANVIL_PID)"

# 2. Create temp registry
echo "Creating registry at $REGISTRY_PATH..."
rm -rf "$REGISTRY_PATH"
mkdir -p "$REGISTRY_PATH/chains/$CHAIN_NAME"

cat > "$REGISTRY_PATH/chains/$CHAIN_NAME/metadata.yaml" <<EOF
name: $CHAIN_NAME
displayName: Anvil Local
chainId: $CHAIN_ID
domainId: $DOMAIN_ID
protocol: ethereum
rpcUrls:
  - http: $RPC_URL
nativeToken:
  name: Ether
  symbol: ETH
  decimals: 18
EOF

# 3. Deploy core contracts
echo "Deploying core contracts..."
CORE_CONFIG="$(dirname "$0")/../typescript/cli/examples/core-config.yaml"
pnpm -C typescript/cli run hyperlane core deploy \
  --registry "$REGISTRY_PATH" \
  --chains "$CHAIN_NAME" \
  --config "$CORE_CONFIG" \
  --key "$ANVIL_KEY" \
  --yes \
  --verbosity debug

# 4. Deploy ICA router
echo "Deploying ICA router..."
pnpm -C typescript/cli run hyperlane ica deploy \
  --registry "$REGISTRY_PATH" \
  --origin "$CHAIN_NAME" \
  --chains "$CHAIN_NAME" \
  --owner "$ANVIL_ADDRESS" \
  --key "$ANVIL_KEY" \
  --yes \
  --verbosity debug

# Read deployed addresses
ADDRESSES_FILE="$REGISTRY_PATH/chains/$CHAIN_NAME/addresses.yaml"
echo "Reading addresses from $ADDRESSES_FILE..."

MAILBOX=$(grep 'mailbox:' "$ADDRESSES_FILE" | awk '{print $2}' | tr -d '"')
ICA_ROUTER=$(grep 'interchainAccountRouter:' "$ADDRESSES_FILE" | awk '{print $2}' | tr -d '"')

echo "Mailbox: $MAILBOX"
echo "ICA Router: $ICA_ROUTER"

# 5. Enroll ICA router with itself for same-domain operations
echo "Enrolling ICA router with itself..."
DEFAULT_ISM=$(cast call "$MAILBOX" "defaultIsm()(address)" --rpc-url "$RPC_URL")

# Convert addresses to bytes32
ROUTER_BYTES32=$(cast --to-bytes32 "$ICA_ROUTER")
ISM_BYTES32=$(cast --to-bytes32 "$DEFAULT_ISM")

# Check if already enrolled
ENROLLED=$(cast call "$ICA_ROUTER" "routers(uint32)(bytes32)" "$DOMAIN_ID" --rpc-url "$RPC_URL")
ZERO_BYTES32="0x0000000000000000000000000000000000000000000000000000000000000000"

if [ "$ENROLLED" = "$ZERO_BYTES32" ]; then
  cast send "$ICA_ROUTER" \
    "enrollRemoteRouterAndIsm(uint32,bytes32,bytes32)" \
    "$DOMAIN_ID" "$ROUTER_BYTES32" "$ISM_BYTES32" \
    --rpc-url "$RPC_URL" \
    --private-key "$ANVIL_KEY"
  echo "Enrolled."
else
  echo "Already enrolled."
fi

# 6. Deploy ERC20 test token
echo "Deploying ERC20 test token..."
TOKEN_DEPLOY=$(forge create \
  --root typescript/cli \
  --rpc-url "$RPC_URL" \
  --private-key "$ANVIL_KEY" \
  "node_modules/@hyperlane-xyz/core/contracts/test/ERC20Test.sol:ERC20Test" \
  --constructor-args "TestUSDC" "USDC" "1000000000000000000000" 18)

TOKEN_ADDRESS=$(echo "$TOKEN_DEPLOY" | grep "Deployed to:" | awk '{print $3}')
echo "Token: $TOKEN_ADDRESS"

# 7. Write config
cat > "$CONFIG_OUT" <<EOF
{
  "chainName": "$CHAIN_NAME",
  "chainId": $CHAIN_ID,
  "domainId": $DOMAIN_ID,
  "rpcUrl": "$RPC_URL",
  "mailbox": "$MAILBOX",
  "icaRouter": "$ICA_ROUTER",
  "tokenAddress": "$TOKEN_ADDRESS",
  "tokenSymbol": "USDC",
  "tokenDecimals": 18,
  "registryPath": "$REGISTRY_PATH",
  "deployerKey": "$ANVIL_KEY",
  "deployerAddress": "$ANVIL_ADDRESS"
}
EOF

echo ""
echo "=== Setup Complete ==="
echo "Config written to: $CONFIG_OUT"
echo ""
echo "Addresses:"
echo "  Mailbox:    $MAILBOX"
echo "  ICA Router: $ICA_ROUTER"
echo "  Token:      $TOKEN_ADDRESS"
echo ""
echo "Next steps:"
echo "  1. Start ccip-server:"
echo "     ENABLED_MODULES=tokenTransferIca \\"
echo "     REGISTRY_URI=$REGISTRY_PATH \\"
echo "     SERVER_BASE_URL=http://localhost:3001 \\"
echo "     RELAYER_PRIVATE_KEY=$ANVIL_KEY \\"
echo "     SERVER_PORT=3001 \\"
echo "     pnpm -C typescript/ccip-server dev"
echo ""
echo "  2. Update ICA_CONFIG in warp-ui with:"
echo "     routerAddress: '$ICA_ROUTER'"
echo "     tokenAddress:  '$TOKEN_ADDRESS'"
echo ""
echo "  3. Start warp-ui: cd /path/to/warp-ui && pnpm dev"
echo ""
echo "Anvil PID: $ANVIL_PID (kill when done)"
