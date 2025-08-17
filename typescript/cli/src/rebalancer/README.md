OFT rebalancer quickstart

Prereqs

- Deployed Hyperlane Warp Route over LayerZero OFT routers
- Local or public registry available to the CLI
- Funded OFT balances on the route’s router addresses to avoid zero readings when starting

Monitor-only run
node ./typescript/cli/cli-bundle/index.js warp rebalancer --config /path/to/rebalancer.oft.json --monitorOnly --checkFrequency 30

Docker run
docker run --rm -e HYP_KEY=&lt;PK&gt; -v ~/.hyperlane:/root/.hyperlane -v /path/config:/config fravlaca/hyperlane-monorepo:1.0.0 warp rebalancer --config /config/rebalancer.oft.json --monitorOnly --registry /root/.hyperlane --registry https://github.com/hyperlane-xyz/hyperlane-registry

Funding OFT balances for testing

- The rebalancer reads balances held by the route’s router contracts. Fresh deployments will read as zero.
- Fund the routers on each chain with the OFT token. Example using cast:

Sepolia
export ETH_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
cast call 0x2F6982D259243974a9426b8E4B008974D4F8E1b9 "balanceOf(address)(uint256)" 0x9758d902Dbc295BB993bbDc1f2591247a5C6634b
cast send 0x2F6982D259243974a9426b8E4B008974D4F8E1b9 "mint(address,uint256)" 0x9758d902Dbc295BB993bbDc1f2591247a5C6634b 100000000000000000000 --private-key &lt;PK&gt; --legacy --gas-price 15000000
cast call 0x2F6982D259243974a9426b8E4B008974D4F8E1b9 "balanceOf(address)(uint256)" 0x9758d902Dbc295BB993bbDc1f2591247a5C6634b

Arbitrum Sepolia
export ETH_RPC_URL=https://api.zan.top/arb-sepolia
cast call 0x733445C319DEe346673F7d37B19F81Ea2Bf58f85 "balanceOf(address)(uint256)" 0x4A27ca16753C8524Ed31762aE1ECA7355Dc195b1
cast send 0x733445C319DEe346673F7d37B19F81Ea2Bf58f85 "mint(address,uint256)" 0x4A27ca16753C8524Ed31762aE1ECA7355Dc195b1 50000000000000000000 --private-key &lt;PK&gt; --legacy --gas-price 250000
cast call 0x733445C319DEe346673F7d37B19F81Ea2Bf58f85 "balanceOf(address)(uint256)" 0x4A27ca16753C8524Ed31762aE1ECA7355Dc195b1

Replace token and router addresses with your deployment values.

On-chain mappings

- Ensure router enrollments are set both ways on the warp route (remoteRouters populated).
- Ensure LayerZero EID mappings are set on TokenBridgeOft via owner-only addDomain on each chain.

Executing a small rebalance

- Set monitorOnly to false in the CLI args.
- Ensure bridgeMinAcceptedAmount and lock times in config allow a small transfer.
- Start the rebalancer; verify a transfer executes and post-balances converge toward weights.

Troubleshooting

- If balances appear zero, fund the router contracts with the OFT.
- If transfers revert, verify router allow-list and EID mappings are set on-chain.
- Mount both the public and local registries when running in Docker so the CLI can find your route artifacts.
  OFT Rebalancer support

- The CLI rebalancer supports both CCTP and OFT bridges.
- Bridge selection is config-driven; providing per-chain TokenBridgeOft addresses selects the OFT adapter.
- Authoritative LayerZero mappings (Hyperlane domain → LZ EID) are configured on-chain via owner-only addDomain in TokenBridgeOft.
- Optional visibility-only CLI block: you may include "oft.domains" to document EIDs/endpoints; the agent will not use this for routing, but may log mismatches with on-chain mappings in future versions.

Example config snippet:
{
"warpRouteId": "0x...",
"strategy": { "rebalanceStrategy": "weighted", "chains": { "sepolia": { "bridge": "0xTokenBridgeOft..." } } },
"oft": {
"domains": {
"sepolia": { "lzEid": 10161, "endpoint": "0xEndpointIfTracked" },
"arbitrumsepolia": { "lzEid": 10143, "endpoint": "0xEndpointIfTracked" }
}
}
}

Run monitor-only:
node ./typescript/cli/cli-bundle/index.js warp rebalancer --config ./typescript/cli/examples/rebalancer.oft.example.json --monitorOnly --checkFrequency 30

# Hyperlane Warp Rebalancer

The Hyperlane Warp Rebalancer is a tool that automatically manages the balance of collateral across chains in a Warp Route. It ensures that each chain maintains an optimal balance of tokens based on the configured strategy.

## Configuration

The rebalancer uses a configuration file that defines both global settings and chain-specific configurations. The configuration file can be in either YAML or JSON format.

The basic structure of the configuration is as follows:

```yaml
# Required: Unique identifier for the Warp Route. This is used to identify the
# HypERC20 token that is being rebalanced.
# The format is <TOKEN>/<LABEL>
warpRouteId: ...

# Required: The rebalancing strategy and chain-specific configurations
strategy:
  # Required: Rebalancing strategy ('weighted' or 'minAmount')
  rebalanceStrategy: ...

  # Required: Configuration for each chain involved in the rebalancing.
  # Only chains included here will be considered for rebalancing.
  chains:
    <chainName1>:
      # ... chain-specific config
    <chainName2>:
      # ... chain-specific config
```

Below are examples for each rebalancing strategy.

### Weighted Strategy

This strategy aims to maintain a weighted distribution of tokens across chains.

```yaml
# Required: Unique identifier for the Warp Route
warpRouteId: USDC/arbitrumsepolia-modetestnet-optimismsepolia-sepolia

strategy:
  # Required: Rebalancing strategy ('weighted', 'minAmount')
  rebalanceStrategy: weighted

  # Chain configurations
  chains:
    sepolia:
      # Required: The address of the bridge for cross-chain transfers
      bridge: '0x1234...'
      # Required: Expected time in seconds for a bridge transfer to complete.
      # This prevents new rebalances while a transfer is in progress.
      bridgeLockTime: 300 # 5 minutes
      # Optional: Minimum amount to bridge (in token units). Prevents dust transfers.
      bridgeMinAcceptedAmount: 1 # 1 USDC
      # Optional: Set to true if the bridge is another Warp Route.
      bridgeIsWarp: false

      # Optional: Override configurations for specific destination chains
      override:
        arbitrumsepolia: # Chain to override settings for
          bridge: '0x4321...' # Use a different bridge when sending to this chain
          bridgeLockTime: 600 # 10 minutes
          bridgeMinAcceptedAmount: 2 # 2 USDC
          bridgeIsWarp: true

      # Strategy-specific parameters for 'weighted'
      weighted:
        # Required: Relative weight for this chain. If all chains have equal
        # weight, rebalancing will aim for equal collateral on all chains.
        weight: 100
        # Required: Percentage of deviation from the target amount allowed before
        # a rebalance is triggered (0-100). For a target of 100 USDC, a 5%
        # tolerance allows the amount to drop to 95 before rebalancing.
        tolerance: 5

    arbitrumsepolia:
      bridge: '0xabcd...'
      bridgeLockTime: 300
      weighted:
        weight: 50
        tolerance: 10
```

### MinAmount Strategy

This strategy ensures that each chain maintains a minimum amount of tokens. It can be configured in two ways: `absolute` and `relative`.

**Note:** All chains must use the same `minAmount` type (`absolute` or `relative`).

#### Absolute `minAmount`

Uses absolute token amounts for thresholds.

```yaml
warpRouteId: USDC/arbitrumsepolia-modetestnet-optimismsepolia-sepolia
strategy:
  rebalanceStrategy: minAmount
  chains:
    sepolia:
      bridge: '0x1234...'
      bridgeLockTime: 300
      minAmount:
        type: 'absolute'
        # Required: Minimum amount to maintain on this chain (in token units).
        min: 100 # 100 USDC
        # Required: The target amount to rebalance to. Must be > min.
        target: 110 # 110 USDC
```

#### Relative `minAmount`

Uses percentages of the total rebalanceable amount for thresholds.

```yaml
warpRouteId: USDC/arbitrumsepolia-modetestnet-optimismsepolia-sepolia
strategy:
  rebalanceStrategy: minAmount
  chains:
    sepolia:
      bridge: '0x1234...'
      bridgeLockTime: 300
      minAmount:
        type: 'relative'
        # Required: Minimum percentage to maintain (0.0 to 1.0).
        # 1.0 represents the total collateral of all rebalanceable chains.
        min: 0.3 # 30%
        # Required: The target percentage to rebalance to. Must be > min.
        target: 0.35 # 35%
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

### Additional Options

`--checkFrequency`: Frequency to check balances in ms (defaults: 30 seconds)

`--monitorOnly`: Run in monitor-only mode (no transactions will be sent)

`--withMetrics`: Enabled by default. Can provide a COINGECKO_API_KEY environment variable to fetch token prices from CoinGecko.

### Manual Rebalance

A manual rebalance allows you to execute an immediate rebalance. Once the rebalance is executed, the process finishes.

Requires providing the following options to the execution command:

`--manual`: Flag that determines that a one off rebalance should be executed

`--origin`: The origin chain of the rebalance

`--destination`: The destination chain of the rebalance

`--amount`: The amount of tokens to transfer (in token units)

For instance, if you need to move `100` USDC from `sepolia` to `arbitrumsepolia`:

```bash
hyperlane warp rebalancer \
  --config ./rebalancer-config.yaml \
  --manual \
  --origin sepolia \
  --destination arbitrumsepolia \
  --amount 100
```

## Selecting a bridge (CCTP vs OFT)

The rebalancer uses a per-chain bridge address from your config. To use LayerZero OFT, deploy and configure a TokenBridgeOft contract per chain and set its address as the `bridge` for that chain. You can optionally use `override` to specify a different bridge when sending to particular destination chains.

- Keep `bridgeIsWarp: false` for OFT (default).
- Continue to use rebalance(domain, amount, bridge) via the SDK; no signature changes are required.

See an OFT example config at:

- typescript/cli/examples/rebalancer.oft.example.json
