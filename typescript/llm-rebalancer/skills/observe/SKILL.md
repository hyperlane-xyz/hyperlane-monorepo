# observe

Purpose: collect current router collateral and inventory balances for all configured warp routes.

Inputs:
- `warpRouteIds[]`
- `registryUri`

Actions:
- Read warp route artifacts from registry.
- Query onchain router balances and inventory signer balances.
- Return normalized node balances for classic and multi-collateral routes.

Output JSON:
```json
{
  "observedAt": 1730000000000,
  "routerBalances": [
    {
      "routeId": "USDC/anvil2-anvil3",
      "chain": "anvil2",
      "symbol": "USDC",
      "router": "0x...",
      "collateral": "1000000",
      "inventory": "500000"
    }
  ],
  "metadata": {}
}
```

Required writes:
- None. Caller persists observation.
