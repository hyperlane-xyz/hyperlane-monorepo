# feat: Add LayerZero OFT Bridge Support for Hyperlane Rebalancer

## Overview

This PR adds support for LayerZero OFT (Omnichain Fungible Token) bridging to the Hyperlane warp route rebalancer. The implementation follows the exact same architectural pattern as CCTP (Circle Cross-Chain Transfer Protocol), providing a clean and proven approach.

## Architecture

### Core Component

**TokenBridgeOft** (`solidity/contracts/token/TokenBridgeOft.sol`)
- Purpose-built router for OFT tokens (analogous to TokenBridgeCctp for USDC)
- Uses LayerZero protocol for ALL cross-chain transfers (users and rebalancing)
- Extends HypERC20Collateral to hold OFT tokens as collateral
- Acts as its own bridge for rebalancing (following CCTP pattern)

### Key Design Decision: Following CCTP Pattern

Just like CCTP, OFT support is implemented with a single integrated router:
- **TokenBridgeOft** integrates LayerZero directly (like TokenBridgeCctp integrates Circle)
- **No custom rebalance() needed** - uses standard MovableCollateralRouter functionality
- **No separate bridge adapter** - router acts as its own bridge via ITokenBridge interface

## How It Works

### User Transfers
```
User → TokenBridgeOft.transferRemote() → LayerZero → Destination
```

### Rebalancing
```
Rebalancer → Router.rebalance(domain, amount, router_address) → Router acts as bridge → LayerZero → Destination
```

The router can act as its own bridge because:
1. TokenRouter (parent class) implements ITokenBridge interface
2. ITokenBridge has the same signature as ValueTransferBridge
3. When router calls itself as bridge, it already has the tokens
4. This is exactly how CCTP works!

## Implementation Details

### TokenBridgeOft Key Features

```solidity
contract TokenBridgeOft extends HypERC20Collateral {
    // Domain mapping for LayerZero endpoints
    mapping(uint32 => Domain) internal _domainMap;
    
    // Overrides _transferRemote to use LayerZero instead of Hyperlane
    function _transferRemote(...) internal override {
        // Pull tokens from sender
        // Send via LayerZero to destination
    }
    
    // Standard quote function for fee estimation
    function quoteTransferRemote(...) returns (Quote[] memory) {
        // Quote LayerZero fees
    }
}
```

### Configuration Example

```yaml
# Rebalancer configuration - use router address as bridge
strategy:
  chains:
    sepolia:
      bridge: '0x...TokenBridgeOft...'  # Router acts as its own bridge
      targetBalance: '1000000000000000000'
    arbitrumsepolia:
      bridge: '0x...TokenBridgeOft...'  # Same pattern as CCTP
      targetBalance: '1000000000000000000'
```

## Addressing Reviewer Feedback

### Original Concern: "Separation of OFT wrapping from rebalancing"

**Resolution**: Following CCTP's proven pattern, we use a single integrated router that handles both user transfers and rebalancing. This is the standard Hyperlane approach.

### Original Concern: "Why custom rebalance() function?"

**Resolution**: Removed! No custom rebalance() needed. The router uses the standard MovableCollateralRouter.rebalance() and acts as its own bridge.

### Why This Approach Is Correct

1. **Proven Pattern**: CCTP uses this exact architecture successfully
2. **Simplicity**: Single contract handles all OFT operations
3. **Standard Compliance**: Uses existing MovableCollateralRouter functionality
4. **No Code Duplication**: Reuses standard rebalancing logic

## Key Benefits

✅ **Follows Established Patterns**: Identical architecture to CCTP
✅ **Simple and Clean**: Single router contract, no unnecessary complexity
✅ **Standard Rebalancing**: Uses MovableCollateralRouter without modifications
✅ **Production Ready**: Based on proven CCTP implementation

## Testing

- Tested on Sepolia and Arbitrum Sepolia with existing OFT tokens
- Both monitoring and manual rebalancing modes functional
- Successful cross-chain transfers via LayerZero

## Files Changed

### Core Contract
- `solidity/contracts/token/TokenBridgeOft.sol` - OFT router implementation
- `solidity/contracts/token/interfaces/IOFTV2.sol` - LayerZero V2 interface

### SDK Integration
- `typescript/sdk/src/token/adapters/TokenBridgeOftAdapter.ts` - SDK adapter

### CLI Support
- `typescript/cli/src/commands/warp.ts` - OFT commands
- `typescript/cli/src/rebalancer/README.md` - Documentation

## Summary

This implementation provides comprehensive OFT support for Hyperlane by following the exact same successful pattern used for CCTP. The architecture is clean, simple, and proven - using a single integrated router that acts as its own bridge for rebalancing, without requiring any custom rebalance functions or separate adapters.