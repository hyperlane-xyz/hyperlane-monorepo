# Hyperlane Warp Rebalancer

The Hyperlane Warp Rebalancer is a tool that automatically manages the balance of collateral across chains in a Warp Route. It ensures that each chain maintains an optimal balance of tokens based on the configured strategy.

## Configuration

The rebalancer uses a configuration file that defines both global settings and chain-specific configurations. The configuration file can be in either YAML or JSON format.

This is required to run the rebalancer.

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

# Chain configurations
# All chains that contain collateral hyp contracts must be configured
# In this example, the collateral chains are: sepolia, optimism-sepolia, and arbitrum-sepolia
# For simplicity, only the sepolia chain is configured
sepolia:
  # Required: The address of the bridge that will be used to perform cross-chain transfers
  bridge: '0x1234...'

  # Required: Expected time in milliseconds for bridge to process a transfer
  # Used to prevent triggering new rebalances while a transfer is in progress
  bridgeTolerance: 300000 # 5 minutes in ms

  # Optional: Minimum amount to bridge (in wei)
  # Used to prevent transfering small amounts that are not worth the gas cost
  bridgeMinAcceptedAmount: 1000000 # 1 USDC (6 decimals)

  # Optional: Set to true if the bridge is another Warp Route
  # This is because bridges composed of other warp routes are interacted with differently
  bridgeIsWarp: false

  # Strategy-specific parameters (depending on rebalanceStrategy)
  # Use one set of values for the strategy you are using

  # For weighted strategy:
  # Required: Relative weight for this chain
  weight: 100 # (e.g All chains have equal weight, rebalancing will balance all chains to have the same amounts of collateral)
  # Required: Determines how much deviation from the target amount is allowed before a rebalance is triggered (in percentage 0-100)
  tolerance: 5 # 5% allows a 5% deviation from the target amount before a rebalance is needed

  # For minAmount strategy:
  # Required: Minimum amount to maintain on this chain (in wei)
  minAmount: 100000000 # 100 USDC (6 decimals)
  # Optional: Determines an extra amount of tokens over the minimum amount to maintain on this chain (in basis points)
  # This allows the chain to be rebalanced over the minimum amount to prevent constant rebalancing
  buffer: 1000 # 10% buffer (0-10_000 basis points)
```
