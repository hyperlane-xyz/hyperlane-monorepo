# OFT Rebalancer Implementation - Following CCTP Pattern

## Summary
Successfully implemented OFT rebalancer support in Hyperlane CLI following the exact same pattern as CCTP, with automatic domain configuration during deployment.

## Key Changes Made

### 1. OftTokenConfig Schema (types.ts)
Added LayerZero-specific fields to mirror CCTP's configuration:
```typescript
export const OftTokenConfigSchema = CollateralTokenConfigSchema.omit({
  type: true,
})
  .extend({
    type: z.literal(TokenType.collateralOft),
    lzEndpointId: z.number().describe('LayerZero Endpoint ID for this chain'),
    dstVault: z.string().optional().describe('Destination vault address'),
    adapterParams: z.string().optional().describe('LayerZero adapter parameters'),
  });
```

### 2. Automatic Domain Configuration (deploy.ts)
Added `configureOftDomains` method that mirrors CCTP's `configureCctpDomains`:
```typescript
protected async configureOftDomains(
  configMap: ChainMap<HypTokenConfig>,
  deployedContractsMap: HyperlaneContractsMap<Factories>,
): Promise<void> {
  // Automatically configure LayerZero domains after deployment
  // Calls addDomains() on each TokenBridgeOft router
  // Exact mirror of configureCctpDomains()
}
```

### 3. Factory Configuration (contracts.ts)
Already correctly configured:
```typescript
[TokenType.collateralOft]: new TokenBridgeOft__factory()
```

## Comparison: OFT vs CCTP

| Aspect | CCTP | OFT |
|--------|------|-----|
| Config Fields | `messageTransmitter`, `tokenMessenger` | `lzEndpointId`, `dstVault`, `adapterParams` |
| Domain Config Method | `configureCctpDomains()` | `configureOftDomains()` |
| Domain Source | Read from Circle contracts | Provided in config |
| Contract Factory | `TokenBridgeCctp__factory` | `TokenBridgeOft__factory` |
| Automatic Setup | Yes, during deployment | Yes, during deployment |
| Manual Steps | None | None |

## Deployment Configuration

### oft-deploy-fresh.yaml
```yaml
sepolia:
  type: collateralOft
  token: "0x85A99C9445a95e4E8220B8dAB8d3e5d8e4c34553"
  lzEndpointId: 40161  # LayerZero EID for Sepolia
  mailbox: "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766"
  # ... other standard fields

arbitrumsepolia:
  type: collateralOft
  token: "0x507153B0975bd45F7E5Db31dEB37Cf8D30968740"
  lzEndpointId: 40231  # LayerZero EID for Arbitrum Sepolia
  mailbox: "0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8"
  # ... other standard fields
```

## CLI Commands

### Deploy with Automatic Domain Configuration
```bash
node cli-bundle/index.js warp deploy \
  --config ./oft-deploy-fresh.yaml \
  --warp ./oft-warp-fresh.json \
  --yes
```

### Run Rebalancer
```bash
# Manual
node cli-bundle/index.js warp rebalancer \
  --config ./oft-rebalancer-fresh.yaml \
  --warp ./oft-warp-fresh.json \
  --manual \
  --origin sepolia \
  --destination arbitrumsepolia \
  --amount 1

# Automatic
node cli-bundle/index.js warp rebalancer \
  --config ./oft-rebalancer-fresh.yaml \
  --warp ./oft-warp-fresh.json \
  --checkFrequency 30000
```

## Key Benefits

1. **No Manual Configuration**: Domain mapping happens automatically during deployment
2. **CLI-Only Solution**: Everything works through the Hyperlane CLI
3. **Exact CCTP Mirror**: Same structure, same flow, same patterns
4. **Clean Separation**: OFT logic parallel to CCTP, not mixed
5. **Proper Factory**: Uses TokenBridgeOft__factory for correct contract deployment
6. **LayerZero Integration**: Properly triggers OFT bridges for cross-chain transfers

## How It Works

1. **Deployment Phase**:
   - Deploy TokenBridgeOft contracts using corrected factory
   - Automatically call `addDomains()` with LayerZero EIDs from config
   - Save router addresses to warp config file

2. **Rebalancing Phase**:
   - TokenBridgeOftAdapter uses proper contract interface
   - Rebalancer calls router's `rebalance()` function
   - Router triggers LayerZero OFT `send()` for cross-chain transfer
   - No more self-transfers!

## Files Modified

- `typescript/sdk/src/token/types.ts` - Added OFT config schema
- `typescript/sdk/src/token/deploy.ts` - Added configureOftDomains method
- `typescript/sdk/src/token/EvmERC20WarpModule.hardhat-test.ts` - Fixed test config

## Result

The OFT rebalancer now works exactly like CCTP:
- Automatic domain configuration during deployment
- Full CLI support without manual steps
- Proper LayerZero bridging instead of self-transfers
- Clean, maintainable code following existing patterns