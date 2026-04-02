---
name: warp-deploy-init
description: First step of deploying a new warp route. Reads a Linear ticket to extract token details and chain configuration, looks up mailbox addresses from the local registry, and generates the deploy.yaml file.
---

# Warp Route Deploy Init

You are generating the initial `deploy.yaml` for a new Hyperlane warp route deployment.

## Input

The user provides a Linear ticket URL or ID (e.g. `ENG-3516` or `https://linear.app/hyperlane-xyz/issue/ENG-3516/...`).

If not provided, ask for it now.

---

## Step 1: Fetch the Linear Ticket

Extract the issue ID from the URL or input (e.g. `ENG-3516`).

Query the Linear GraphQL API:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ issue(id: \"<ISSUE_ID>\") { title description } }"}'
```

**If `LINEAR_API_KEY` is not set or returns 401:** Stop and tell the user:

> `LINEAR_API_KEY` is not set or invalid. Please export it in your shell: `export LINEAR_API_KEY=<your-key>` and restart Claude Code, then try again.

Show the user the ticket title and description before proceeding.

---

## Step 2: Extract Warp Route Details

Parse the ticket description to extract the following. Ask the user to clarify anything that is ambiguous or missing:

| Field                            | Description                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Token name**                   | Full name (e.g. `RISE`)                                                                                |
| **Token symbol**                 | Symbol (e.g. `RISE`)                                                                                   |
| **Decimals**                     | Token decimals (e.g. `18`) — query on-chain if unsure                                                  |
| **Collateral chain(s)**          | Chain(s) where the real token lives — may be multiple for multi-collateral routes                      |
| **Collateral token address(es)** | ERC-20 contract address per collateral chain — tokens like USDC have different addresses on each chain |
| **Synthetic chains**             | Chains that get a synthetic (bridged) representation                                                   |
| **Owner address**                | Address per chain — may differ if ICA addresses are used on non-Ethereum chains                        |
| **Warp fee**                     | Fee in basis points (bps), if specified (e.g. `6bps`)                                                  |
| **Fee owner**                    | Address that receives fees — defaults to the chain's `owner` if not speciffied                         |
| **Type overrides**               | Any chain that should be `native` instead of `collateral`/`synthetic`                                  |

**Multi-collateral routes**: when the ticket lists multiple collateral chains, each gets its own `token` address (look up per-chain contract addresses for well-known tokens like USDC). ICA owner addresses for non-Ethereum chains are often not yet known — use `<ICA_ADDRESS>` as a placeholder and flag clearly to the user.

**Rebalancing**: if the ticket includes liquidity weights (e.g. `35% ethereum, 20% arb…`), the route uses the rebalancer. Add `allowedRebalancers` and `allowedRebalancingBridges` to each **collateral chain** (not synthetic). Bridge addresses are CCTP bridge contracts specific to each source chain — copy them from an existing multi-collateral USDC deploy in the registry (e.g. `eclipsemainnet-deploy.yaml`). The **weights themselves** are NOT in the deploy.yaml — they go in `typescript/infra/config/environments/mainnet3/balances/desiredRebalancerBalances.json` in the monorepo. Flag this to the user as a separate step.

---

## Step 3: Look Up Mailbox Addresses

For each chain (collateral + synthetics), read the mailbox address from the local registry:

```bash
REGISTRY_PATH="$(dirname $(pwd))/hyperlane-registry"
cat "$REGISTRY_PATH/chains/<chain>/addresses.yaml" | grep "^mailbox:"
```

If a chain is not found in the registry, warn the user — the chain may not have a Hyperlane deployment yet.

---

## Step 4: Generate deploy.yaml

Compose the deploy.yaml using the extracted details and mailbox addresses.

**Multi-collateral format** (multiple collateral chains + one synthetic): same as standard but repeated for each collateral chain, each with its own `token` address and `owner`:

```yaml
<collateral-chain-1>:
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  name: <token-name>
  owner: '<owner-or-ica-address>'
  symbol: <token-symbol>
  token: '<token-address-on-this-chain>'
  type: collateral

<collateral-chain-2>:
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  name: <token-name>
  owner: '<owner-or-ica-address>'
  symbol: <token-symbol>
  token: '<token-address-on-this-chain>'
  type: collateral

<synthetic-chain>:
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  name: <token-name>
  owner: '<owner-or-ica-address>'
  symbol: <token-symbol>
  type: synthetic
```

The `tokenFee` on the synthetic chain lists ALL collateral chains in `feeContracts` (each may have a different `owner` if per-chain ICAs differ).

**Standard format** (single collateral + synthetic chains):

```yaml
<collateral-chain>:
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  name: <token-name>
  owner: '<owner-address>'
  symbol: <token-symbol>
  token: '<token-contract-address>'
  type: collateral

<synthetic-chain>:
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  name: <token-name>
  owner: '<owner-address>'
  symbol: <token-symbol>
  type: synthetic
```

**For `native` type chains** (chain's native gas token is being bridged — no `token` field, no `decimals` from ERC-20):

```yaml
<chain>:
  mailbox: '<mailbox-address>'
  owner: '<owner-address>'
  type: native
```

**If a warp fee is specified**, add a `tokenFee` block on the **synthetic chain only** (fee is charged when bridging back from synthetic → collateral/native). The `feeContracts` lists the destination chains the fee applies to:

```yaml
<synthetic-chain>:
  ...
  tokenFee:
    feeContracts:
      <collateral-or-native-chain>:
        bps: <fee-in-bps>
        owner: "<fee-owner-address>"
        type: LinearFee
    owner: "<fee-owner-address>"
    type: RoutingFee
  type: synthetic
```

The `fee-owner-address` defaults to the chain's `owner` unless separately specified.

**Exception**: routes where all chains are `native` type (no clear collateral) get `tokenFee` on every chain, each listing all other chains.

**Rules:**

- Chains are listed in alphabetical order
- `token` field only present on `collateral` type
- `decimals`, `name`, `symbol` omitted on `native` type
- `tokenFee` goes on the synthetic chain only (or all chains if all-native route)
- Do NOT include `interchainSecurityModule`, `proxyAdmin`, or `remoteRouters` — those are added post-deployment

---

## Step 5: Determine Output Path

The deploy.yaml goes in the local registry at:

```
$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chain1>-<chain2>-deploy.yaml
```

Where:

- `<TOKEN>` is the token symbol (uppercase)
- `<chain1>-<chain2>` are the chain names sorted alphabetically and joined with `-`

Example for RISE on ethereum + bsc: `deployments/warp_routes/RISE/bsc-ethereum-deploy.yaml`

Check if a directory and/or file already exists. If it does, show the user the existing file and ask if they want to overwrite.

---

## Step 6: Write the File

Write the deploy.yaml to the registry path, then show the user the final content and full path.

Tell the user the next steps:

1. Review the generated deploy.yaml
2. Run the Hyperlane CLI to deploy: `hyperlane warp deploy --config <path-to-deploy.yaml>`
3. After deployment, the config.yaml will be generated — merge both into the registry via PR

---

## Notes

- The registry path is `$(dirname $(pwd))/hyperlane-registry` relative to the monorepo root
- Always check the existing registry for similar routes to use as reference (e.g. same token on other chains)
- If the ticket has links to token contracts on block explorers, use those addresses
- `owner` is typically an Abacus Works Safe address — check similar routes in the registry if not specified in the ticket
