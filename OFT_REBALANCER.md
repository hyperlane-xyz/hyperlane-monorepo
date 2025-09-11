# Hyperlane OFT Rebalancer - Complete Guide

## Overview

The Hyperlane OFT (Omnichain Fungible Token) Rebalancer enables automatic cross-chain token rebalancing using LayerZero OFT protocol. This implementation provides both manual and automatic rebalancing capabilities between supported chains.

## 🚀 Quick Start - See It Working

### Immediate Demo Command
```bash
cd typescript/cli
source ~/.nvm/nvm.sh && nvm use v20.8.1
HYP_KEY=0x1cdf65ac75f477650040ebe272ddaffb6735dcf55bd651869963ada71944e6db npx tsx cli.ts warp rebalancer \
  --config ../../fixed-oft-auto.yaml \
  --warp ../../fixed-oft-warp.json \
  --registry ./local-registry \
  --checkFrequency 10000
```

This will show live automatic rebalancing between Sepolia and Arbitrum Sepolia testnets.

## 📋 Prerequisites

- **Node.js**: v20.8.1+ (managed via nvm)
- **Private Key**: Test account with ETH on both chains
- **OFT Tokens**: Deployed OFT tokens on source chains

## 🔧 Architecture

### Core Components

1. **TokenBridgeOft Contract** (`solidity/contracts/token/TokenBridgeOft.sol`)
   - Extends HypERC20Collateral for OFT integration
   - Includes `rebalance()` function with `onlyRebalancer` modifier
   - SafeERC20 approval reset logic for multiple transfers

2. **TokenBridgeOftAdapter** (`typescript/sdk/src/token/adapters/TokenBridgeOftAdapter.ts`)
   - Handles LayerZero protocol fee calculations
   - Populates rebalance transactions with proper gas limits
   - Integrates with existing rebalancer infrastructure

3. **CLI Integration** (`typescript/cli/src/config/warp.ts`)
   - Supports `collateralOft` token type
   - Enables deployment via standard CLI commands

## 📁 Configuration Files

### Deployment Config (`fixed-oft-deploy.yaml`)
```yaml
sepolia:
  type: collateralOft
  token: "0x85A99C9445a95e4E8220B8dAB8d3e5d8e4c34553"
  # ... LayerZero and Hyperlane settings
```

### Automatic Rebalancer Config (`fixed-oft-auto.yaml`)
```yaml
warpRouteId: OFT
strategy:
  type: automatic
  rebalanceStrategy: minAmount
  chains:
    sepolia:
      bridge: "0x7Ae1D97D2e253271F1f851177B20413c1a954BEf"
      minAmount:
        min: 0.002
        target: 0.006
```

### Warp Route Config (`fixed-oft-warp.json`)
```json
{
  "tokens": [
    {
      "chainName": "sepolia",
      "standard": "TokenBridgeOft",
      "addressOrDenom": "0x7Ae1D97D2e253271F1f851177B20413c1a954BEf"
    }
  ]
}
```

## 🛠️ Complete Setup Guide

### 1. Deploy New OFT Contracts
```bash
cd typescript/cli
HYP_KEY=<your-private-key> npx tsx cli.ts warp deploy \
  --config ../../fixed-oft-deploy.yaml \
  --registry ./local-registry \
  --yes
```

### 2. Setup Router Permissions
```bash
HYP_KEY=<your-private-key> npx tsx cli.ts warp oft-setup \
  --config ../../fixed-oft-auto.yaml \
  --registry ./local-registry
```

### 3. Fund Routers with Tokens
Transfer OFT tokens to the deployed router addresses for testing.

### 4. Test Manual Rebalancing
```bash
HYP_KEY=<your-private-key> npx tsx cli.ts warp rebalancer \
  --config ../../fixed-oft-manual.yaml \
  --warp ../../fixed-oft-warp.json \
  --registry ./local-registry \
  --manual \
  --origin sepolia \
  --destination arbitrumsepolia \
  --amount 0.01
```

### 5. Run Automatic Rebalancing
```bash
HYP_KEY=<your-private-key> npx tsx cli.ts warp rebalancer \
  --config ../../fixed-oft-auto.yaml \
  --warp ../../fixed-oft-warp.json \
  --registry ./local-registry \
  --checkFrequency 15000
```

## 📊 Monitoring & Debugging

### Check Router Balances
```bash
# Sepolia router balance
cast call --rpc-url https://sepolia.drpc.org \
  0x7Ae1D97D2e253271F1f851177B20413c1a954BEf \
  "balanceOf(address)" 0x7Ae1D97D2e253271F1f851177B20413c1a954BEf

# Arbitrum router balance  
cast call --rpc-url https://arbitrum-sepolia.drpc.org \
  0xDcEC4233640D32652f35C35E90143dA37ea78beE \
  "balanceOf(address)" 0xDcEC4233640D32652f35C35E90143dA37ea78beE
```

### Monitor Mode (No Transactions)
```bash
HYP_KEY=<your-private-key> npx tsx cli.ts warp rebalancer \
  --config ../../fixed-oft-auto.yaml \
  --warp ../../fixed-oft-warp.json \
  --registry ./local-registry \
  --monitorOnly \
  --checkFrequency 10000
```

## ✅ Successful Test Results

### Live Transactions
- **Manual Rebalance**: `0x60cd20c477061a4ed4c4708668e7d6f3a0710b766bb37dff6624f9b21fdc9743`
- **Automatic Rebalance**: `0x7d5f23d3ff92b57747440410fb1ffff9dc76ab37237c7783cf5c7988d31e83f5`

### Deployed Contracts
- **Sepolia Router**: `0x7Ae1D97D2e253271F1f851177B20413c1a954BEf`
- **Arbitrum Router**: `0xDcEC4233640D32652f35C35E90143dA37ea78beE`

## 🐛 Troubleshooting

### Common Issues

1. **"approve from non-zero to non-zero allowance"**
   - ✅ **Fixed** in TokenBridgeOft.sol with approval reset logic

2. **"Rebalancer startup error: Consider reducing the targets"**
   - Ensure target amounts don't exceed available collateral
   - Adjust `minAmount.target` values in config

3. **"Bridge must be this router for OFT"**
   - Ensure bridge address matches router address in config

4. **Node.js compatibility errors**
   - Use Node.js v20.8.1+: `nvm use v20.8.1`

### Configuration Tips

- **Target Amounts**: Set targets to ~60% of expected balance
- **Check Frequency**: Use 10-15 seconds for testing, 60+ seconds for production  
- **Gas Limits**: 500k gas limit is recommended for LayerZero operations
- **Bridge Lock Time**: 300 seconds prevents rapid successive rebalances

## 🔐 Security Notes

- **Private Keys**: Never commit private keys to git
- **Rebalancer Permissions**: Only authorized addresses can call `rebalance()`
- **Bridge Validation**: OFT rebalancer validates bridge equals router address
- **Amount Limits**: Configure appropriate min/max thresholds

## 🌐 Supported Networks

Currently tested and working on:
- **Sepolia Testnet** (Ethereum)
- **Arbitrum Sepolia Testnet**

With existing OFT tokens:
- Sepolia OFT: `0x85A99C9445a95e4E8220B8dAB8d3e5d8e4c34553`
- Arbitrum OFT: `0x507153B0975bd45F7E5Db31dEB37Cf8D30968740`

## 🚀 Next Steps

1. **Production Deployment**: Deploy on mainnets with production OFT tokens
2. **Multi-Chain Support**: Extend to additional LayerZero-supported chains  
3. **Advanced Strategies**: Implement percentage-based and other rebalancing strategies
4. **Monitoring Dashboard**: Build UI for real-time rebalancer monitoring

## 📞 Support

For questions or issues:
1. Check the troubleshooting section above
2. Review the configuration files in this repository
3. Test with the provided demo commands
4. Submit issues with detailed logs and configuration