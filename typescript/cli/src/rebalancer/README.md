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
  bridgeLockTime: 300000 # 5 minutes in ms

  # Optional: Minimum amount to bridge (in wei)
  # Used to prevent transferring small amounts that are not worth the gas cost
  bridgeMinAcceptedAmount: 1000000 # 1 USDC (6 decimals)

  # Optional: Set to true if the bridge is another Warp Route
  # This is because bridges composed of other warp routes are interacted with differently
  bridgeIsWarp: false

  # Optional: Specify override configurations for specific chains
  # This allows you to customize how this chain interacts with other particular chains
  override:
    arbitrumsepolia: # Chain name to override settings for
      bridge: '0x4321...' # Use a different bridge when sending to this chain
      bridgeLockTime: 300000 # 5 minutes in ms
      bridgeMinAcceptedAmount: 1000000 # 1 USDC (6 decimals)
      bridgeIsWarp: true

  # Strategy-specific parameters (depending on rebalanceStrategy)
  # Use one set of values for the strategy you are using

  # For weighted strategy:
  # Required: Relative weight for this chain
  weight: 100 # (e.g All chains have equal weight, rebalancing will balance all chains to have the same amounts of collateral)
  # Required: Determines how much deviation from the target amount is allowed before a rebalance is triggered (in percentage 0-100)
  tolerance: 5 # 5% allows a 5% deviation from the target amount before a rebalance is needed

  # For minAmount strategy (absolute):
  # Absolute requires exact token amounts
  # Required: Minimum amount to maintain on this chain (in wei)
  minAmount: 100000000 # 100 USDC (6 decimals)
  # Required: The objective value to rebalance to.
  target: 110000000 # It should be bigger than `minAmount` to prevent immediate rebalance (110 USDC in this case)

  # For minAmount strategy (relative):
  # Relative requires percentage values. 0 = 0%, 0.5 = 50%, 1 = 100%.
  # 100% represent a the sum of collaterals of rebalanceable amounts.
  # Required: Minimum percentage to maintain on this chain.
  minAmount: 0.3 # 30%
  # Required: The objective value to rebalance to.
  target: 0.35 # It should be bigger than `minAmount` to prevent immediate rebalance (35% in this case)
```

## Basic Usage

To run the rebalancer, you need to provide:

1. A configuration file
2. A private key to sign rebalance transactions

```bash
# Using environment variable for private key
HYP_KEY=your_private_key hyperlane warp rebalancer --config ./rebalancer-config.yaml

# Using CLI option for private key
hyperlane warp rebalancer --config ./rebalancer-config.yaml --key your_private_key
```

> **IMPORTANT**: A private key is REQUIRED for the rebalancer to function correctly. You can provide it either via the `--key` parameter or the `HYP_KEY` environment variable.

### Overriding Configuration Options

You can override specific configuration values from the command line:

```bash
# Override the warp route ID
hyperlane warp rebalancer --config ./rebalancer-config.yaml --key your_key --warpRouteId USDC/arbitrum-polygon

# Override the check frequency (milliseconds)
hyperlane warp rebalancer --config ./rebalancer-config.yaml --key your_key --checkFrequency 60000

# Override the rebalance strategy
hyperlane warp rebalancer --config ./rebalancer-config.yaml --key your_key --rebalanceStrategy minAmount
```

### Additional Options

```bash
# Run in monitor-only mode (no transactions will be sent)
hyperlane warp rebalancer --config ./rebalancer-config.yaml --key your_key --monitorOnly

# Enable metrics collection (requires CoinGecko API key)
hyperlane warp rebalancer --config ./rebalancer-config.yaml --key your_key --withMetrics --coingeckoApiKey your_coingecko_api_key
```

### Manual Rebalance

A manual rebalance allows you to execute one rebalance by specifying the execution route.

> [!NOTE]
> It won't rely on strategies, but will use the configuration file properly execute the rebalance, i.e.: bridge address.

For instance, if you need to move `1000` USDC from `sepolia` to `arbitrumsepolia`:

```bash
# --amount must be expressed in token units
hyperlane warp rebalance --config ./rebalancer-config.yaml --origin sepolia --destination arbitrumsepolia --amount '1000000000'
```

### Environment Variables

Instead of CLI parameters, you can use these environment variables:

```bash
# Set your environment variables
export HYP_KEY=your_private_key_here
export COINGECKO_API_KEY=your_coingecko_api_key

# Run with metrics enabled
hyperlane warp rebalancer --config ./rebalancer-config.yaml --withMetrics
```
