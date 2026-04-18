---
name: warp-deploy-init-route
description: First step of deploying a new warp route (steps 1–9). Reads a Linear ticket to extract token details and chain configuration, looks up mailbox addresses from the local registry, generates the deploy.yaml, runs the deploy, and optionally runs a send test. Follow up with /warp-deploy-update-owners.
---

# Warp Route Deploy Init

You are generating the initial `deploy.yaml` for a new Hyperlane warp route deployment.

## Input

The user provides:

- **Linear ticket URL or ID** (required, e.g. `ENG-3516` or `https://linear.app/hyperlane-xyz/issue/ENG-3516/...`)
- **Deployer address** (required — the temporary owner for all chains, e.g. `0xabc...`)

If the ticket is not provided, ask for it now.

If the deployer address is not provided, ask for it before proceeding. The deployer address is always used as the `owner` for every `owner` field in the deploy.yaml (chain-level and tokenFee-level). Real ownership is set later via `/warp-deploy-update-owners` — never use real Safe/ICA addresses in this step.

**Multi-protocol deployer addresses**: if the route spans multiple VM protocols (e.g. EVM + Sealevel), each protocol requires its own deployer address with a different format (EVM: `0x...`, Solana: base58). In this case, ask for a separate deployer address per protocol and use:

- The **EVM deployer address** as `owner` on all EVM chains
- The **Sealevel deployer address** as `owner` on all Sealevel chains (Solana, Eclipse)
- The **Cosmos deployer address** as `owner` on all Cosmos chains (if applicable)

If the route spans multiple VM protocols and only one deployer address was given, check whether it matches the expected format for each protocol — if not, ask for the missing addresses.

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

| Field                            | Description                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| **Token name**                   | Full name (e.g. `RISE`)                                                                       |
| **Token symbol**                 | Symbol (e.g. `RISE`)                                                                          |
| **Decimals**                     | Token decimals (e.g. `18`) — use the reference table below for USDC; query on-chain if unsure |
| **Collateral chain(s)**          | Chain(s) where the real token lives — may be multiple for multi-collateral routes             |
| **Collateral token address(es)** | ERC-20 contract address per collateral chain — use the reference table below for USDC         |
| **Synthetic chains**             | Chains that get a synthetic (bridged) representation                                          |
| **Warp fee**                     | Fee in basis points (bps), if specified (e.g. `6bps`)                                         |
| **Fee owner**                    | Address that receives fees — defaults to the chain's `owner` if not specified                 |
| **Type overrides**               | Any chain that should be `native` instead of `collateral`/`synthetic`                         |
| **Yield route type**             | If the ticket mentions yield/ERC4626/vault, determine the yield subtype (see below)           |

**Yield routes**: if the ticket mentions "yield", "ERC4626", "vault", "rebasing", "Aave", or the token is a known yield-bearing token (sUSDS, sDAI, etc.), it is a yield route. There are two subtypes:

| Ticket language                           | Collateral type         | Synthetic type    | Behavior                                                                      |
| ----------------------------------------- | ----------------------- | ----------------- | ----------------------------------------------------------------------------- |
| "owner yield" / "non-rebasing"            | `collateralVault`       | `synthetic`       | Yield accrues to contract owner; owner calls `sweep()` to claim               |
| "rebasing" / yield distributed to holders | `collateralVaultRebase` | `syntheticRebase` | Yield auto-distributes to all bridged token holders via exchange rate updates |

If the ticket says "owner yield", use `collateralVault` + `synthetic`. If ambiguous, ask the user.

**For `collateralVault` routes — check if the collateral token already implements ERC4626:**

Run this check on the collateral token address from the ticket:

```bash
cast call <collateral-token-address> "asset()" --rpc-url $(cast chain-id <chain>)
```

- **If `asset()` returns a non-zero address** → the token IS an ERC4626 vault. Use it directly as `token` in the deploy.yaml. No vault deployment needed.
- **If `asset()` reverts or returns zero** → the token is a plain ERC20. Warn the user:

  > ⚠️ The collateral token does not implement ERC4626. You must deploy an Aave ERC4626 vault wrapping it first using [hyperlane-xyz/Aave-Vault](https://github.com/hyperlane-xyz/Aave-Vault), then replace `<VAULT_ADDRESS>` in the deploy.yaml with the deployed vault address. The vault owner controls who can `sweep()` yield — confirm the yield beneficiary with product before deploying.
  >
  > Real example: WETH/incentiv vault `0xB1ea329f0B79d0b213957569594ca2a9dE637215` = "Wrapped Aave Ethereum WETH" (waEthWETH), underlying = WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

  Use `<VAULT_ADDRESS>` as a placeholder in the deploy.yaml until the vault is deployed.

**`collateralVaultRebase` constraint**: ALL destination chains MUST be `syntheticRebase` — you cannot mix `syntheticRebase` with `synthetic` in the same route. Each `syntheticRebase` chain requires a `collateralChainName` field pointing to the collateral chain.

**Multi-collateral routes**: when the ticket lists multiple collateral chains, each gets its own `token` address. All `owner` fields use the deployer address — real ICA/multisig addresses are set later in `/warp-deploy-update-owners`.

**Rebalancing**: if the ticket includes liquidity weights (e.g. `35% ethereum, 20% arb…`), the route uses the rebalancer. Add `allowedRebalancers` and `allowedRebalancingBridges` to each **collateral chain** (not synthetic). Use the hardcoded values in the reference tables below — no need to search the registry. The **weights themselves** are NOT in the deploy.yaml — they go in `typescript/infra/config/environments/mainnet3/balances/desiredRebalancerBalances.json` in the monorepo. Flag this to the user as a separate step.

---

## Reference: Known Token Addresses and Bridge Contracts

### USDC (decimals: 6)

| Chain      | Token Address                                |
| ---------- | -------------------------------------------- |
| ethereum   | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| arbitrum   | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| base       | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| optimism   | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| polygon    | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| avalanche  | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| unichain   | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` |
| linea      | `0x176211869cA2b568f2A7D4EE941E073a821EE1ff` |
| worldchain | `0x79A02482A880bCE3F13e09Da970dC34db4CD24d1` |
| hyperevm   | `0xb88339CB7199b77E23DB6E890353E22632Ba630f` |
| ink        | `0x2D270e6886d130D724215A266106e6832161EAEd` |

### Rebalancer

Single rebalancer address used across all multi-collateral routes:

```
0xa3948a15e1d0778a7d53268b651B2411AF198FE3
```

### CCTP Bridge Addresses (per source chain)

Used in `allowedRebalancingBridges` on each collateral chain. The two addresses are the CCTP bridge contracts on that source chain — list them for **every** destination collateral chain in the route.

| Source Chain | Bridge Address 1                             | Bridge Address 2                             |
| ------------ | -------------------------------------------- | -------------------------------------------- |
| ethereum     | `0x8c8D831E1e879604b4B304a2c951B8AEe3aB3a23` | `0x7A576Bb5291567cfDbB4585B1911CF7C9891ea07` |
| arbitrum     | `0x4c19c653a8419A475d9B6735511cB81C15b8d9b2` | `0xE086378F7f0afd5C3ff95E10B5e7806a0901b33f` |
| base         | `0x33e94B6D2ae697c16a750dB7c3d9443622C4405a` | `0x31169ee5A8C0D680de74461d7B5394fFc7C3576B` |
| optimism     | `0x33e94B6D2ae697c16a750dB7c3d9443622C4405a` | `0x4eFaacbf0D3d57b401Cb6B559e84b344448b0C30` |
| polygon      | `0x33e94B6D2ae697c16a750dB7c3d9443622C4405a` | `0x07d89DE0F7E18c9bcAAE81F44aee9CA02EBeE872` |
| avalanche    | `0x33e94B6D2ae697c16a750dB7c3d9443622C4405a` | `0xCB35d7730843F770625bE36A0E4228c17fDcBC09` |
| unichain     | `0x33e94B6D2ae697c16a750dB7c3d9443622C4405a` | `0xCB35d7730843F770625bE36A0E4228c17fDcBC09` |
| linea        | `0x33e94B6D2ae697c16a750dB7c3d9443622C4405a` | `0x89aAa89D36F995b41d929f2D29b8Ee7C9c8e54cA` |
| worldchain   | `0x33e94B6D2ae697c16a750dB7c3d9443622C4405a` | `0x89aAa89D36F995b41d929f2D29b8Ee7C9c8e54cA` |
| hyperevm     | `0xDdf252a063f8c5C399B9ccDBbaDBA55225F53Da1` | `0xe10b7b030C75C80359841CB0ec892E233F03f145` |
| ink          | `0x92dFEB6f7Daa532de0F3c75c2091e1607c6593b7` | `0x70CF23d09784fCA62be304c928BCA9F1801B1F21` |

> Source: extracted from `deployments/warp_routes/USDC/eclipsemainnet-deploy.yaml` (2025-04-02). If a chain is missing from this table, look it up in that file.

---

## Step 3: Look Up Mailbox Addresses

For each chain (collateral + synthetics), read the mailbox address from the local registry:

```bash
REGISTRY_PATH="$(pwd)/../hyperlane-registry"
cat "$REGISTRY_PATH/chains/<chain>/addresses.yaml" | grep "^mailbox:"
```

If a chain is not found in the registry, warn the user — the chain may not have a Hyperlane deployment yet.

**For Sealevel chains (solanamainnet, eclipsemainnet):** also look up the IGP address from the monorepo's program-ids.json (NOT from addresses.yaml):

```bash
cat "rust/sealevel/environments/mainnet3/<chain>/core/program-ids.json" | python3 -c "import sys,json; print(json.load(sys.stdin)['igp_program_id'])"
```

Known values (verify against the file before using):

| Chain          | igp_program_id                                 |
| -------------- | ---------------------------------------------- |
| solanamainnet  | `BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv` |
| eclipsemainnet | `Hs7KVBU67nBnWhDPZkEFwWqrFMUfJbmY2DQ4gmCZfaZp` |

Save this address — it is used as the `hook` field in Step 4.

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

**For `collateralVault` type chains** (owner-yield ERC4626 — yield accrues to owner, not holders):

> ⚠️ **Vault must be deployed before the warp route.** The `token` field is the ERC4626 vault address, NOT the underlying asset. Use [hyperlane-xyz/Aave-Vault](https://github.com/hyperlane-xyz/Aave-Vault) to deploy the vault if one doesn't already exist. Real-world examples: WETH/incentiv vault `0xB1ea329f0B79d0b213957569594ca2a9dE637215` (waEthWETH, wraps WETH), USDT/incentiv vault `0x04DA4b99FFc82f0e44DEd14c3539A6fDaD08E2fE` (wraps USDT).

**Name and symbol**: use the `name` and `symbol` of the **underlying asset** (from `asset()`), NOT the vault token. The vault is an implementation detail; users think of themselves as bridging the underlying token. Look up the underlying's name/symbol on-chain:

```bash
ASSET=$(cast call <vault-address> "asset()(address)" --rpc-url <RPC_URL>)
cast call $ASSET "symbol()(string)" --rpc-url <RPC_URL>
cast call $ASSET "name()(string)" --rpc-url <RPC_URL>
```

The warp route directory and warp route ID also use the **underlying asset symbol** (e.g. `WETH/igra`, not `waEthWETH/igra`).

```yaml
<collateral-chain>:
  decimals: <decimals> # decimals of the underlying asset
  gas: 300000 # REQUIRED: vault withdrawal costs more than default 68k gas
  mailbox: '<mailbox-address>'
  name: <underlying-asset-name> # from asset().name(), NOT vault name
  owner: '<owner-address>'
  symbol: <underlying-symbol> # from asset().symbol(), NOT vault symbol
  token: '<erc4626-vault-address>' # vault address — NOT the underlying asset address
  type: collateralVault

<synthetic-chain>:
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  name: <underlying-asset-name>
  owner: '<owner-address>'
  symbol: <underlying-symbol>
  type: synthetic # standard synthetic — NOT syntheticRebase
```

> ⚠️ **`gas: 300000` is required on the `collateralVault` chain.** Delivering to a collateralVault triggers an ERC4626 vault withdrawal, which costs ~430k gas — far above the default 68k `destinationGas`. Without this override the relayer underpays the IGP and the delivery transaction will revert. 300k was validated empirically on the WETH/igra route (required: ~430k total, IGP overhead: ~160k, so destinationGas needed: ~270k → 300k gives headroom).

**For `collateralVaultRebase` type chains** (rebasing ERC4626 — yield auto-distributes to all bridged holders):

> ⚠️ Same ERC4626 check as `collateralVault`: run `cast call <token> "asset()"` — if it returns a non-zero address, use the token directly; if it reverts, a vault must be deployed first. Same name/symbol rule applies: use the underlying asset's name and symbol.

```yaml
<collateral-chain>:
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  name: <underlying-asset-name>
  owner: '<owner-address>'
  symbol: <underlying-symbol>
  token: '<erc4626-vault-address>'
  type: collateralVaultRebase

<synthetic-chain>:
  collateralChainName: <collateral-chain> # REQUIRED for syntheticRebase
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  name: <underlying-asset-name>
  owner: '<owner-address>'
  symbol: <underlying-symbol>
  type: syntheticRebase # ALL destinations must be syntheticRebase when collateralVaultRebase is used
```

**For `native` type chains** (chain's native gas token is being bridged — no `token`, `name`, or `symbol` field):

```yaml
<chain>:
  decimals: <decimals>
  mailbox: '<mailbox-address>'
  owner: '<owner-address>'
  type: native
```

**If a warp fee is specified**, fee placement depends on route type:

- **Standard routes** (collateral/native → synthetic): `tokenFee` on the **synthetic chain only**. `feeContracts` lists all collateral/native chains. Fee is charged when bridging FROM synthetic TO collateral/native.
- **All-native routes** (every chain is `native`): `tokenFee` on **every chain**, each listing all other chains as `feeContracts`.
- **Multi-collateral with rebalancer**: `tokenFee` on the **synthetic chain** listing all collateral chains (user-facing fee for bridging out of synthetic). Rebalancer-internal fees between collateral chains are NOT part of initial deploy — added later if needed.

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

**Sealevel chain rules (solanamainnet, eclipsemainnet, etc.):** For any Sealevel chain in the route, add two extra fields regardless of token type (`native`, `synthetic`, `collateral`, etc.):

- `hook`: the IGP address looked up in Step 3 (the `interchainGasPaymaster` value from that chain's `addresses.yaml`)
- `gas: 300000`: sending to Solana costs more than the default 68k gas

Example:

```yaml
solanamainnet:
  decimals: 9
  gas: 300000
  hook: '<igp-address-from-registry>'
  mailbox: '<mailbox-address>'
  owner: '<owner-address>'
  type: native
```

**Rules:**

- Chains are listed in alphabetical order
- `token` field only present on `collateral`, `collateralVault`, and `collateralVaultRebase` types
- `name` and `symbol` omitted on `native` type; `decimals` IS included
- `collateralChainName` is REQUIRED on every `syntheticRebase` chain; omit on all other types
- `tokenFee` goes on the synthetic chain only (or all chains if all-native route)
- Do NOT include `interchainSecurityModule`, `proxyAdmin`, or `remoteRouters` — those are added post-deployment

---

## Step 5: Determine Output Path

The deploy.yaml goes in the local registry at:

```
$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<new-chain>-deploy.yaml
```

Where:

- `<TOKEN>` is the token symbol (uppercase)
- `<new-chain>` is the **primary new destination chain** — i.e., the new chain being added, typically the synthetic chain. Do NOT include all chains in the filename; using only the new chain creates a stable ID that doesn't change when additional chains are added later.

Example: for USDS bridging from ethereum (collateral) to igra (synthetic), the file is `deployments/warp_routes/USDS/igra-deploy.yaml` — NOT `ethereum-igra-deploy.yaml`.

Exception: if there is no clear "primary" new chain (e.g., both chains are new/co-equal), use just the synthetic or destination chain name.

Check if a directory and/or file already exists. If it does, show the user the existing file and ask if they want to overwrite.

---

## Step 6: Write the File

Write the deploy.yaml to the registry path, then show the user the final content and full path.

Ask the user: **"Does this deploy.yaml look correct? Type `yes` to proceed to deployment, or describe any changes needed."**

Do not proceed to Step 7 until the user confirms.

---

## Step 7: Prepare Warp Deploy Command

### 7a: Determine Warp Route ID

The warp route ID is derived from the deploy.yaml output path:

```
$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<new-chain>-deploy.yaml
                                        └─────────────────────────────┘
                                        Warp route ID = <TOKEN>/<new-chain>
```

Example: if the file is `deployments/warp_routes/USDS/igra-deploy.yaml`, the warp route ID is `USDS/igra`.

The stable warp route ID uses only the primary new chain name (not all chains), so it stays constant if more chains are added to the route later.

### 7b: Identify Required Protocols

For each chain in the route, determine its VM protocol type:

| Protocol       | Example chains                                              | Key flag         |
| -------------- | ----------------------------------------------------------- | ---------------- |
| EVM (ethereum) | ethereum, arbitrum, base, optimism, polygon, avalanche, bsc | `--key.ethereum` |
| Sealevel       | solana, eclipsemainnet                                      | `--key.sealevel` |
| Cosmos         | neutron, osmosis                                            | `--key.cosmos`   |
| Starknet       | starknet                                                    | `--key.starknet` |

If all chains are EVM, only one key is needed. If the route spans multiple VM types, a separate key flag is needed per protocol.

### 7c: Ask for Key Environment Variables

For each unique protocol needed, ask the user:

> **What environment variable holds your deployer private key for `{protocol}` chains?**
> (Press enter to use the default: `HYP_KEY` for single-protocol routes, or `HYP_KEY_{PROTOCOL}` for multi-protocol)

Use the provided variable name(s) to build the command.

### 7d: Build and Show the Command

Assemble the full deploy command. The command must be run from `typescript/cli`. Always include `--yes` to skip the interactive confirmation prompt:

```bash
cd typescript/cli

pnpm hyperlane warp deploy \
  --registry $REGISTRY_PATH \
  --warp-route-id <TOKEN>/<new-chain> \
  --key.ethereum $MY_ETH_KEY_VAR \
  [--key.sealevel $MY_SOL_KEY_VAR]   # only if sealevel chains present
  [--key.cosmos $MY_COSMOS_KEY_VAR]   # only if cosmos chains present
  --yes
```

Where `<TOKEN>/<new-chain>` is the warp route ID from Step 7a, and `$MY_ETH_KEY_VAR` etc. are the env variable names provided in 7c.

Show the user the exact command with the real values substituted. Then ask:

> **Ready to run the warp deploy?** Type `yes` to execute, or `no` to run it manually.

---

## Step 8: Run Warp Deploy

If the user confirms, first start the HTTP registry in the background to get private RPC URLs from Secret Manager:

```bash
cd <MONOREPO_ROOT> && pnpm -C typescript/infra start:http-registry
```

Run with `run_in_background: true`. Wait for the server to be ready by checking the logs for a line like `Listening on http://localhost:<port>`. Note the port (typically `3333`) and the background task/shell ID — you will need both to stop the server after the skill completes.

Tell the user upfront:

> **Starting warp deploy for `<TOKEN>/<new-chain>`.**
> This deploys contracts on each chain sequentially and typically takes **5–15 minutes**.
> Chains: `<list all chains>`
> You'll see the full output when it completes.

Then run the deploy command from `typescript/cli`. Pass the local registry path **first** and the HTTP registry **second** — later entries take priority for reads (so HTTP private RPCs win), but both are in the merged write set (so local writes succeed when HTTP returns 405). Always use a 10-minute timeout (600000ms). Always include `--yes`:

```bash
cd /path/to/hyperlane-monorepo/typescript/cli && pnpm hyperlane warp deploy \
  --registry $(pwd)/../hyperlane-registry \
  --registry http://localhost:<port> \
  --warp-route-id <TOKEN>/<new-chain> \
  --key.ethereum $MY_ETH_KEY_VAR \
  --yes
```

**On success:** the CLI writes a `<new-chain>-config.yaml` file next to the deploy.yaml in the registry. Show the user the full deploy output so they can see which contracts were deployed and their addresses.

**On failure:** show the error output and stop the HTTP registry (Step 8a), then do not proceed to Step 9. Common issues:

- Insufficient gas → run `/warp-deploy-fund-deployer` first
- RPC errors → check the chain's RPC URL in the registry
- Key not set → confirm the env variable is exported in the shell

---

## Step 9: Warp Send Test

Run the send test **now, while the deployer still owns the contracts** — before transferring ownership in Step 10.

Use the same key environment variable from Step 7c (no need to ask again).

### Amount calculation

Always use `--amount 10000` (in token's smallest units, i.e. wei-equivalent). This is small enough to stay well within any warp fee budget across all legs.

**Warp fee accounting**: if the route has a fee (e.g. 10 bps on withdrawals), the CLI charges `amount + fee` from the sender's balance on the fee leg. After the forward send mints `10000` synthetic tokens on the destination, the return leg needs `10000 + fee` in the synthetic balance. With `--amount 10000` and 10 bps fee:

- fee = `10000 * 10 / 10000 = 10` units
- total needed = `10010` — but the deployer only received `10000` from the forward send

To avoid this, use `--amount 9000` on the return leg (synthetic → collateral/native), which leaves headroom for the fee:

- fee = `9000 * 10 / 10000 = 9` units → total needed = `9009 ≤ 10000` ✓

If the fee bps is known upfront, calculate the safe return amount as: `floor(forward_amount / (1 + fee_bps / 10000))`. With no fee, use the same amount in both directions.

**For native collateral chains**: the IGP payment for each outbound send also costs native gas. Ensure the deployer has enough native token before running all sends — the preflight check only covers deploy gas, not IGP gas per send. If "Insufficient for interchain gas" appears, top up and retry.

### Two-chain routes

Send forward then back. Use the amounts from the calculation above:

```bash
cd /path/to/hyperlane-monorepo/typescript/cli

# Forward (no fee on this direction for standard routes)
pnpm hyperlane warp send \
  --registry $(pwd)/../hyperlane-registry \
  --registry http://localhost:<port> \
  --origin <chain1> --destination <chain2> \
  --amount 10000 --key $MY_PK \
  -w <TOKEN>/<new-chain>

# Return (fee charged — use reduced amount)
pnpm hyperlane warp send \
  --registry $(pwd)/../hyperlane-registry \
  --registry http://localhost:<port> \
  --origin <chain2> --destination <chain1> \
  --amount 9000 --key $MY_PK \
  -w <TOKEN>/<new-chain>
```

### Multi-chain routes (1 native/collateral + multiple synthetics)

Do NOT use `--round-trip`. Test each native ↔ synthetic pair sequentially:

```bash
cd /path/to/hyperlane-monorepo/typescript/cli

# For each synthetic chain: send native → synthetic (forward, no fee)
pnpm hyperlane warp send \
  --registry $(pwd)/../hyperlane-registry \
  --registry http://localhost:<port> \
  --origin <native-chain> --destination <synthetic-chain> \
  --amount 10000 --key $MY_PK \
  -w <TOKEN>/<new-chain>

# Then return: synthetic → native (fee charged — use reduced amount)
pnpm hyperlane warp send \
  --registry $(pwd)/../hyperlane-registry \
  --registry http://localhost:<port> \
  --origin <synthetic-chain> --destination <native-chain> \
  --amount 9000 --key $MY_PK \
  -w <TOKEN>/<new-chain>
```

Skip any leg where the deployer has insufficient balance. After each forward send from a native chain, check the native balance — IGP payments accumulate across sends.

Each send may take a few minutes to relay. After each send, show the user:

- Whether it succeeded or failed
- The **Message ID** (from the CLI output)
- The **Explorer link** (e.g. `https://explorer.hyperlane.xyz/message/<id>`)

If either send fails or times out, show the error and still report the message ID if available so it can be tracked. Do not block on failures — proceed when ready.

### After all sends complete (or on any failure)

Stop the HTTP registry:

```bash
# Kill the background process started in Step 8 using its shell/task ID
```

Use `TaskStop` or `KillShell` with the ID noted when starting the registry. Always stop it — even if sends failed — so no background process is left running.

---

## Next Steps

Once Step 9 is complete, run `/warp-deploy-update-owners` to transfer ownership, add the CoinGecko ID, and open the registry PR.

---

## Notes

- The registry path is `$(pwd)/../hyperlane-registry` when run from the monorepo root. The hyperlane-registry repo is expected to be cloned at the same level as hyperlane-monorepo.
- For USDC, use the token addresses and CCTP bridge addresses from the reference tables above — no need to search the registry
- If the ticket has links to token contracts on block explorers, use those addresses
- All `owner` fields always use the deployer address — never use real Safe/ICA addresses in deploy.yaml. Real ownership is transferred via `/warp-deploy-update-owners` after testing.
- Do NOT search the registry for example deploys to copy from — the reference tables above have the canonical values
