---
name: check-balances
description: Read warp route collateral balances across all configured chains and assets
allowed-tools: bash read
---

# Check Balances

Read the config file at `./rebalancer-config.json` for chain/asset addresses.

For each chain in the config, get the collateral balance held by the warp token contract:

```bash
cast call <collateralToken> 'balanceOf(address)(uint256)' <warpTokenAddress> --rpc-url <rpcUrl>
```

If the chain has multi-asset deployments (the `assets` field), check each asset's collateral balance:

```bash
cast call <asset.collateralToken> 'balanceOf(address)(uint256)' <asset.warpToken> --rpc-url <rpcUrl>
```

Convert from wei using the asset's decimals (default 18). Report results as a table:

```
Chain        | Asset | Balance (tokens) | Balance (wei)
-------------|-------|------------------|---------------
chain1       | USDC  | 500.00           | 500000000000000000000
chain2       | USDC  | 300.00           | 300000000000000000000
```

Also compute total supply per asset and each chain's share percentage.
