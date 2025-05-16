# Hyperlane Warp Rebalancer

The Hyperlane Warp Rebalancer is a tool that automatically manages the balance of collateral across chains in a Warp Route. It ensures that each chain maintains an optimal balance of tokens based on the configured strategy.

## Configuration

The rebalancer uses a configuration file that defines both global settings and chain-specific configurations. The configuration file can be in either YAML or JSON format.

### Global Configuration

```yaml
# Required: Unique identifier for the Warp Route
warpRouteId: USDC/arbitrumsepolia-modetestnet-optimismsepolia-sepolia

# Required: How often the monitor should check for imbalances (in milliseconds)
checkFrequency: 300000 # 5 minutes

# Required: Rebalancing strategy ('weighted' or 'minAmount')
rebalanceStrategy: weighted

# Optional: Only monitor balances without executing rebalancing
monitorOnly: false

# Optional: Enable metrics collection
withMetrics: false

# Optional: CoinGecko API key (required if withMetrics is true)
coingeckoApiKey: your-coingecko-api-key
```
