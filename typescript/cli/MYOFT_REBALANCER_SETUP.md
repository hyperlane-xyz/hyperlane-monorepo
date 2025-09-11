# Complete Setup Guide: MyOFT Rebalancer with Updated CLI

## Prerequisites

Your existing MyOFT tokens:
- Sepolia: `0x85A99C9445a95e4E8220B8dAB8d3e5d8e4c34553`
- Arbitrum Sepolia: `0x507153B0975bd45F7E5Db31dEB37Cf8D30968740`

## Step-by-Step Instructions

### Step 1: Ensure SDK and CLI are Built with Updates
```bash
# Build SDK with OFT domain configuration support
cd typescript/sdk
yarn build

# Bundle CLI with the updated SDK
cd ../cli
yarn bundle
```

### Step 2: Deploy TokenBridgeOft Routers

Use the deployment config `myoft-deploy.yaml`:
```yaml
sepolia:
  type: collateralOft
  token: "0x85A99C9445a95e4E8220B8dAB8d3e5d8e4c34553"
  lzEndpointId: 40161  # LayerZero EID for Sepolia
  name: "MyOFT"
  symbol: "MYOFT"
  decimals: 18
  scale: 1
  mailbox: "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766"
  owner: "0x368ABEe52D223BFF3DD7116a1BB31Ad899Eb9fd5"

arbitrumsepolia:
  type: collateralOft
  token: "0x507153B0975bd45F7E5Db31dEB37Cf8D30968740"
  lzEndpointId: 40231  # LayerZero EID for Arbitrum Sepolia
  name: "MyOFT"
  symbol: "MYOFT"
  decimals: 18
  scale: 1
  mailbox: "0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8"
  owner: "0x368ABEe52D223BFF3DD7116a1BB31Ad899Eb9fd5"
```

Deploy the routers:
```bash
export HYP_KEY=0x0820e79cde729336c29c6d3f5102b522f625b4b1e5801f097848600a23e15cb2

node cli-bundle/index.js warp deploy \
  --config ./myoft-deploy.yaml \
  --warp ./myoft-warp.json \
  --yes
```

**What happens during deployment:**
1. TokenBridgeOft contracts are deployed (not HypERC20Collateral)
2. LayerZero domains are automatically configured via `addDomains()`
3. Router addresses are saved to `myoft-warp.json`

### Step 3: Update Rebalancer Config with Deployed Addresses

After deployment, update `myoft-rebalancer.yaml` with the router addresses from `myoft-warp.json`:
```yaml
warpRouteId: "MYOFT/sepolia-arbitrumsepolia"
strategy:
  rebalanceStrategy: "weighted"
  chains:
    sepolia:
      bridge: "[ROUTER_ADDRESS_FROM_WARP_JSON]"
      bridgeLockTime: 300
      bridgeMinAcceptedAmount: "100000000000000000"  # 0.1 tokens
      weighted: { weight: 50, tolerance: 5 }
    arbitrumsepolia:
      bridge: "[ROUTER_ADDRESS_FROM_WARP_JSON]"
      bridgeLockTime: 300
      bridgeMinAcceptedAmount: "100000000000000000"  # 0.1 tokens
      weighted: { weight: 50, tolerance: 5 }
```

### Step 4: Fund the Routers

Transfer MyOFT tokens to each router for liquidity:

**Sepolia:**
```bash
cast send 0x85A99C9445a95e4E8220B8dAB8d3e5d8e4c34553 \
  "transfer(address,uint256)" \
  [ROUTER_ADDRESS] \
  10000000000000000000 \
  --private-key $HYP_KEY \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

**Arbitrum Sepolia:**
```bash
cast send 0x507153B0975bd45F7E5Db31dEB37Cf8D30968740 \
  "transfer(address,uint256)" \
  [ROUTER_ADDRESS] \
  10000000000000000000 \
  --private-key $HYP_KEY \
  --rpc-url https://arbitrum-sepolia-rpc.publicnode.com
```

### Step 5: Test Manual Rebalancing

Test with a small manual transfer:
```bash
node cli-bundle/index.js warp rebalancer \
  --config ./myoft-rebalancer.yaml \
  --warp ./myoft-warp.json \
  --manual \
  --origin sepolia \
  --destination arbitrumsepolia \
  --amount 0.5
```

**Expected Result:**
- Transaction triggers LayerZero OFT bridging
- Check LayerZeroscan for cross-chain transfer
- No more "sending to self" transactions

### Step 6: Run Automatic Rebalancer

Start automatic rebalancing:
```bash
node cli-bundle/index.js warp rebalancer \
  --config ./myoft-rebalancer.yaml \
  --warp ./myoft-warp.json \
  --checkFrequency 30000
```

This will:
- Check balances every 30 seconds
- Automatically rebalance when imbalance exceeds 5%
- Maintain 50/50 weight distribution

## Verification Commands

### Check Router Balances:
```bash
# Sepolia
cast call 0x85A99C9445a95e4E8220B8dAB8d3e5d8e4c34553 \
  "balanceOf(address)(uint256)" \
  [ROUTER_ADDRESS] \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com

# Arbitrum Sepolia
cast call 0x507153B0975bd45F7E5Db31dEB37Cf8D30968740 \
  "balanceOf(address)(uint256)" \
  [ROUTER_ADDRESS] \
  --rpc-url https://arbitrum-sepolia-rpc.publicnode.com
```

### Check Domain Configuration:
```bash
# Check if LayerZero domains are configured
cast call [ROUTER_ADDRESS] \
  "hyperlaneDomainToLayerZeroEid(uint32)(uint16)" \
  11155111 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

## Troubleshooting

### If deployment fails with "Registry factory addresses not found":
Ensure you have the registry files in `~/.hyperlane/deployments/`:
- `sepolia.yaml` with factory addresses
- `arbitrumsepolia.yaml` with factory addresses

### If rebalancer shows "sending to self":
This means the wrong contract type was deployed. Ensure:
1. SDK is built with the updated `contracts.ts` (using TokenBridgeOft__factory)
2. Deployment config uses `type: collateralOft`
3. Fresh deployment (not reusing old HypERC20Collateral contracts)

## Key Differences from Previous Attempts

1. **Automatic Domain Configuration**: No manual `addDomain()` calls needed
2. **Correct Factory**: Uses TokenBridgeOft__factory, not HypERC20Collateral__factory
3. **Proper OFT Integration**: Triggers LayerZero's OFT send() for bridging
4. **CLI-Only Solution**: Everything through Hyperlane CLI, no scripts

## Implementation Details

### What Changed in the Code:

1. **OftTokenConfig Schema** (`types.ts`):
   - Added `lzEndpointId` field
   - Added optional `dstVault` and `adapterParams` fields

2. **configureOftDomains Method** (`deploy.ts`):
   - Automatically configures LayerZero domains after deployment
   - Mirrors CCTP's `configureCctpDomains()` pattern

3. **Factory Configuration** (`contracts.ts`):
   - Already fixed: `[TokenType.collateralOft]: new TokenBridgeOft__factory()`

### How It Works:

1. **During Deployment**:
   - TokenBridgeOft contracts deployed with correct factory
   - `configureOftDomains()` called automatically
   - LayerZero domains configured via `addDomains()`

2. **During Rebalancing**:
   - TokenBridgeOftAdapter properly initialized
   - Rebalancer calls router's `rebalance()` function
   - Router triggers LayerZero OFT bridge transfer

## Success Criteria

✅ TokenBridgeOft routers deployed (not HypERC20Collateral)  
✅ LayerZero domains automatically configured  
✅ Rebalancer triggers OFT cross-chain transfers  
✅ Transactions visible on LayerZeroscan  
✅ No "sending to self" transactions  

This setup ensures your MyOFT tokens can be rebalanced across chains using LayerZero bridging, following the exact same pattern as CCTP in the Hyperlane CLI!