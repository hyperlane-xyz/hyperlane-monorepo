---
name: warp-deploy-init-route
description: First step of deploying a new warp route (steps 1–9). Reads a Linear ticket to extract token details and chain configuration, looks up mailbox addresses from the local registry, generates the deploy.yaml, runs the deploy, and optionally runs a send test. Follow up with /warp-deploy-update-owners.
---

# Warp Route Deploy Init

You are generating the initial `deploy.yaml` for a new Hyperlane warp route deployment.

## Input

The user provides:

- **Linear ticket URL or ID** (required, e.g. `ENG-3516` or `https://linear.app/hyperlane-xyz/issue/ENG-3516/...`)

If the ticket is not provided, ask for it now.

### Key Context (Prerequisite)

This skill needs deployer key(s) per protocol to sign the warp-deploy txs, and the matching deployer address per protocol to fill `owner` fields in the deploy.yaml. It auto-loads `~/.hyperlane/key-contexts/<ticket-id>.yaml` produced by `/warp-deploy-select-keys`. If the artifact does not exist, invoke `/warp-deploy-select-keys <ticket-id>` first — do not ask the user for an env var name or a deployer address inline.

From the artifact, read per protocol:

- `keys.<protocol>.name` — the GCP secret name (or env var name) for the signer
- `keys.<protocol>.address` — the derived address used as `owner` in the deploy.yaml on all chains of that protocol

A pure-EVM route uses one ethereum key + one EVM owner address across all EVM chains. A cross-VM route uses one key + address per protocol. Real ownership is transferred later via `/warp-deploy-update-owners` — never use real Safe/ICA addresses in this step.

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

| Field                            | Description                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Token name**                   | Full name (e.g. `RISE`)                                                                                                                                                                       |
| **Token symbol**                 | Symbol (e.g. `RISE`)                                                                                                                                                                          |
| **Decimals**                     | Token decimals (e.g. `18`) — use the reference table below for USDC; query on-chain if unsure                                                                                                 |
| **Collateral chain(s)**          | Chain(s) where the real token lives — may be multiple for multi-collateral routes                                                                                                             |
| **Collateral token address(es)** | ERC-20 contract address per collateral chain — use the reference table below for USDC                                                                                                         |
| **Synthetic chains**             | Chains that get a synthetic (bridged) representation                                                                                                                                          |
| **Warp fee**                     | Fee in basis points (bps) + direction (`deposits` / `withdrawals`) from the ticket's `Warp Fee` checkboxes                                                                                    |
| **Fee owner**                    | Address that receives fees — defaults to "Standard AW controlled ICA" per the ticket                                                                                                          |
| **Type overrides**               | Any chain that should be `native` instead of `collateral`/`synthetic`                                                                                                                         |
| **Yield route type**             | If the ticket mentions yield/ERC4626/vault, determine the yield subtype (see below)                                                                                                           |
| **Daily Rate Limit**             | Optional amount (e.g. `200,000,000`) — present in the structured `Daily Rate Limit` row on newer tickets. If present, the route adds a rate-limited hook on the synthetic chain (see Step 4). |

**Yield routes**: if the ticket mentions "yield", "ERC4626", "vault", "rebasing", "Aave", or the token is a known yield-bearing token (sUSDS, sDAI, etc.), it is a yield route. There are two subtypes:

| Ticket language                           | Collateral type         | Synthetic type    | Behavior                                                                      |
| ----------------------------------------- | ----------------------- | ----------------- | ----------------------------------------------------------------------------- |
| "owner yield" / "non-rebasing"            | `collateralVault`       | `synthetic`       | Yield accrues to contract owner; owner calls `sweep()` to claim               |
| "rebasing" / yield distributed to holders | `collateralVaultRebase` | `syntheticRebase` | Yield auto-distributes to all bridged token holders via exchange rate updates |

If the ticket says "owner yield", use `collateralVault` + `synthetic`. If ambiguous, ask the user.

**For `collateralVault` routes — check if the collateral token already implements ERC4626:**

Run this check on the collateral token address from the ticket:

```bash
cast call <collateral-token-address> "asset()(address)" --rpc-url <RPC_URL>
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

**Daily Rate Limit**: if the ticket's `Daily Rate Limit` row is set (e.g. `200,000,000`), the route needs a rate-limited hook on the synthetic chain. Add the hook config to that chain's entry in deploy.yaml. The value is the daily rate limit cap in the token's smallest unit (i.e. apply `× 10^decimals` to the human-readable number from the ticket).

**Ownership validation prerequisite**: before generating the deploy.yaml in Step 4, **the agent invokes** `/warp-deploy-validate-owners` with the same Linear ticket as input. That skill produces a per-chain owner resolution table (ICA / Safe / Squads / EOA-rejected). The deploy.yaml in Step 4 uses the same deployer address for `owner` fields (real owner transfer happens later in `/warp-deploy-update-owners`), but the validation pass ensures the eventual owners are valid before any chain is touched. If `/warp-deploy-validate-owners` reports any ❌ row, abort — don't proceed to deploy against rejected owners.

**Logo handling**: the Linear ticket's `SVG logo` row links to a Linear upload URL with `?signature=…&exp=…` JWT parameters that expire (typically ~5 minutes). To prevent 401s mid-flow on longer runs, **download the logo eagerly right after fetching the ticket** in Step 1 and cache it locally to `<registry>/deployments/warp_routes/<TOKEN>/logo.<ext>`:

```bash
# After mcp__plugin_linear_linear__get_issue returns, grab the SVG/PNG row's image URL
curl -sSL -o "$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/logo.<ext>" "<signed-url>"
```

Use `logo.svg` if the upload is SVG; `logo.png` otherwise. The local file is then referenced by `logoURI` in `<chain>-config.yaml` later (`/warp-deploy-update-owners` Step 11b). Eagerly downloading prevents the signed URL from expiring before that later step needs to read it.

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

**Canonical schema files — read these before authoring nested ISM / hook / fee configs.** A `deploy.yaml` that fails Zod validation never reaches on-chain state — `warp apply` rejects it at parse time, but the resulting error output is voluminous; start from a correct shape:

- Per-chain router config (token type + ISM + hook + fee + proxyAdmin + remoteRouters + destinationGas): `typescript/sdk/src/token/types.ts` — `HypTokenRouterConfigSchema` is the per-chain entry; `HypTokenConfig` is the token-type discriminated union (collateral, native, synthetic, xerc20, opL1/L2, cctp, everclear, depositAddress, crossCollateral, unknown).
- ISMs: `typescript/sdk/src/ism/types.ts` — `IsmConfigSchema` union, plus per-type schemas (`PausableIsmConfigSchema`, `RateLimitedIsmConfigSchema`, `AggregationIsmConfigSchema`, `RoutingIsmConfigSchema`, etc.). Threshold semantics: `staticAggregationIsm` with `threshold = modules.length` is AND across all modules; `threshold: 1` is OR.
- Hooks: `typescript/sdk/src/hook/types.ts` — `HookConfigSchema` union. Note `defaultHook` is the sentinel that means "use mailbox default"; `fallbackRoutingHook` is the standard pattern for "default hook on most chains, custom hook on a specific chain".
- Fees: `typescript/sdk/src/fee/types.ts` — `TokenFeeConfigSchema` discriminated union (`LinearFee`, `OffchainQuotedLinearFee`, `RoutingFee`, `CrossCollateralRoutingFee`, etc.). The `bps` field on `LinearFee` is immutable at the contract level so a bps edit redeploys the contract.
- Shared mixins: `typescript/sdk/src/types.ts` — `OwnableSchema` (`owner` + optional `ownerOverrides`) and `PausableSchema` (Ownable + `paused: boolean`). Many ISM / hook configs extend these, so `owner` is required on more types than the schema name alone suggests.

**Token-type ⇔ fee-wrapper coupling (mandatory pairing).** The outer fee wrapper on a chain's `tokenFee` block is constrained by the chain's token `type`:

| Chain `type`                         | Outer `tokenFee.type`         | Inner (per-destination) fee shape                                                                                           |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `synthetic` / `syntheticRebase`      | `RoutingFee`                  | `feeContracts: Record<destChain, LinearFee \| OffchainQuotedLinearFee \| …>` — single-level nesting                         |
| `collateral` / `collateralVault` / … | `RoutingFee`                  | Same as synthetic                                                                                                           |
| `crossCollateral`                    | `CrossCollateralRoutingFee`   | `feeContracts: Record<destChain, Record<routerKey-bytes32, LinearFee \| OffchainQuotedLinearFee \| …>>` — two-level nesting |
| `native` / `nativeScaled`            | `RoutingFee` (if fees needed) | Same as synthetic                                                                                                           |

Cross-collateral routers MUST be paired with `CrossCollateralRoutingFee` — the inner `routerKey` layer maps the on-chain router (per `crossCollateralRouters` in the same chain block) to its fee contract. Attempting to use `RoutingFee` on a `crossCollateral` chain (or `CrossCollateralRoutingFee` on a plain collateral / synthetic chain) fails Zod validation at parse time.

**SVM-specific fields on fee configs**: on Sealevel chains, fee contracts can carry `beneficiary: <base58>` (the account that accrues collected fees, distinct from `owner` which controls limits). `OffchainQuotedLinearFee` also takes `quoteSigners: [EVM hex address, …]` — EVM addresses regardless of the fee contract's own protocol. Both fields visible in `USDCFEE/sol-deploy.yaml` and `USDTFEE/sol-deploy.yaml` on internal test branches; grep the registry for `OffchainQuotedLinearFee` for the current live shape.

Reference existing production deploy.yamls in the registry (`deployments/warp_routes/*/*-deploy.yaml`) — grep for the token type + protocol combination you want (e.g. a `crossCollateral` chain with `type: LinearFee` inside `RoutingFee` on a `synthetic` chain in the same route), then copy the canonical shape. Different protocols may need different fields (e.g. `foreignDeployment` on Sealevel synthetics, `gas: 300000` on Sealevel entries, `contractVersion` on newer Sealevel deploys); the schema is protocol-aware.

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

**Sealevel chain rules (solanamainnet, eclipsemainnet, etc.):** For any Sealevel chain in the route, add extra fields depending on token type:

**All Sealevel chains** (any type):

- `hook`: the IGP address looked up in Step 3 (from `program-ids.json`, NOT `addresses.yaml`)
- `gas: 300000`: sending to Solana costs more than the default 68k gas

**Sealevel `synthetic` chains only** (additional required fields):

- **`decimals`**: Solana SPL tokens are capped at 9 decimals. If the collateral token has more than 9 decimals (e.g. 18 on EVM), set `decimals: 9` on the Sealevel synthetic and add `scale: 1000000000` (i.e. `10^(collateral_decimals - 9)`). For 6-decimal tokens (e.g. USDC), use `decimals: 6` with no scale needed.

- `metadataUri`: a URL that will be stored in the Token 2022 on-chain metadata extension. This is **never fetched at deploy time** — any valid URL works, including a placeholder. The URI length affects rent (longer = marginally more SOL needed). Use the registry raw URL pattern so it resolves correctly after the registry PR is merged:

  ```
  https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/warp_routes/<TOKEN>/metadata.json
  ```

  Also create a `metadata.json` file next to the deploy.yaml in the registry:

  ```json
  {
    "name": "<TOKEN_NAME>",
    "symbol": "<TOKEN_SYMBOL>",
    "image": "https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/warp_routes/<TOKEN>/logo.svg"
  }
  ```

  This JSON is the Metaplex-compatible metadata that Solana wallets (Phantom, etc.) use to display the token. If an SVG logo is attached to the Linear ticket, reference it via the registry raw URL.

Example (collateral has 18 decimals → Solana synthetic uses 9 with scale):

```yaml
solanamainnet:
  decimals: 9
  gas: 300000
  hook: '<igp-address-from-registry>'
  mailbox: '<mailbox-address>'
  metadataUri: 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/warp_routes/TOKEN/metadata.json'
  name: TOKEN
  owner: '<solana-owner-address>'
  scale: 1000000000
  symbol: TOKEN
  type: synthetic
```

Example (collateral has 6 decimals → Solana synthetic uses 6, no scale needed):

```yaml
solanamainnet:
  decimals: 6
  gas: 300000
  hook: '<igp-address-from-registry>'
  mailbox: '<mailbox-address>'
  metadataUri: 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/warp_routes/TOKEN/metadata.json'
  name: TOKEN
  owner: '<solana-owner-address>'
  symbol: TOKEN
  type: synthetic
```

**Rules:**

- **Top-level chain entries must be in alphabetical order by chain name.** E.g. `arbitrum:` before `base:` before `ethereum:`. The registry CI / CodeRabbit blocks PRs where chain entries aren't sorted.
- **Keys within each chain entry must also be in strict alphabetical order.** E.g. `decimals` before `mailbox` before `name` before `owner` before `symbol` before `token` before `tokenFee` before `type`. When adding any field, insert it at its alphabetical position; never tack new keys onto the top or bottom of an entry.
- `token` field only present on `collateral`, `collateralVault`, and `collateralVaultRebase` types
- `name` and `symbol` omitted on `native` type; `decimals` IS included
- `collateralChainName` is REQUIRED on every `syntheticRebase` chain; omit on all other types
- `tokenFee` goes on the synthetic chain only (or all chains if all-native route)
- Do NOT include `interchainSecurityModule`, `proxyAdmin`, or `remoteRouters` — those are added post-deployment

---

## Step 5: Determine Output Path

The deploy.yaml goes in the local registry at:

```
$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chains-alphabetical>-deploy.yaml
```

Where:

- `<TOKEN>` is the token symbol (uppercase)
- `<chains-alphabetical>` is **every chain in the route**, lowercase, joined with `-` in alphabetical order.

Examples (matching current registry convention):

- `base` + `arbitrum` → `arbitrum-base-deploy.yaml`
- `ethereum` + `coti` → `coti-ethereum-deploy.yaml`
- `arbitrum` + `base` + `blast` + `bsc` → `arbitrum-base-blast-bsc-deploy.yaml`
- single chain (no other legs deployed yet) → `<chain>-deploy.yaml`

This matches existing multi-chain routes in the registry (e.g. `arbitrum-base-blast-…`). Naming the file after every chain — rather than just the "new" or synthetic chain — prevents collisions when more routes with the same token are added later (e.g. a future `ETH/arbitrum-only` route wouldn't conflict with this one).

Before writing, **scan `deployments/warp_routes/<TOKEN>/` for existing routes** and check that the alphabetical-joined filename you're about to write doesn't already exist. If it does, show the user the existing file and ask if they want to overwrite.

---

## Step 6: Write the File

Write the deploy.yaml to the registry path, then show the user the final content and full path.

Ask the user to review the deploy.yaml and confirm or describe any changes needed. End your message with this marker (this MUST be the very last thing in your message):

```test
[CONFIRM: Proceed with deploy.yaml as written]
```

Do not proceed to Step 7 until the user confirms.

> **Note:** `[CONFIRM: ...]` is a Haggis-specific harness primitive — Haggis renders it as an inline approve/reject button. In other Claude Code contexts it is just text.

---

## Step 7: Prepare Warp Deploy Command

### 7a: Determine Warp Route ID

The warp route ID is derived from the deploy.yaml output path:

```
$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chains-alphabetical>-deploy.yaml
                                        └────────────────────────────────────┘
                                        Warp route ID = <TOKEN>/<chains-alphabetical>
```

Examples:

- `deployments/warp_routes/ETH/arbitrum-base-deploy.yaml` → warp route ID `ETH/arbitrum-base`
- `deployments/warp_routes/USDC/eclipsemainnet-ethereum-solanamainnet-deploy.yaml` → `USDC/eclipsemainnet-ethereum-solanamainnet`

The route ID matches the filename suffix (without `-deploy.yaml`). It includes every chain in the route, lowercase, joined by `-` in alphabetical order — the same convention Step 5 uses for the filename.

### 7b: Identify Required Protocols

For each chain in the route, determine its VM protocol type:

| Protocol       | Example chains                                              | Key flag         |
| -------------- | ----------------------------------------------------------- | ---------------- |
| EVM (ethereum) | ethereum, arbitrum, base, optimism, polygon, avalanche, bsc | `--key.ethereum` |
| Sealevel       | solana, eclipsemainnet                                      | `--key.sealevel` |
| Cosmos         | neutron, osmosis                                            | `--key.cosmos`   |
| Starknet       | starknet                                                    | `--key.starknet` |

If all chains are EVM, only one key is needed. If the route spans multiple VM types, a separate key flag is needed per protocol.

### 7c: Load Keys from the Key-Context Artifact

For each unique protocol in the route, read `keys.<protocol>.name` and `keys.<protocol>.source` from `~/.hyperlane/key-contexts/<ticket-id>.yaml`. Do NOT ask the user for env var names inline — the artifact is the source of truth.

### 7d: Build and Show the Command (preview only — do NOT run yet)

Assemble the full deploy command and **show it to the user as a preview** for the `[CONFIRM:]` gate below. Do NOT execute the deploy in this step — Step 8 starts the HTTP registry first and then runs the deploy. Running the command here against the filesystem registry would skip the private-RPC injection, exposing the deploy to flaky public-RPC gas estimates (stale-gas underflow → mid-deploy out-of-gas on opstack chains in particular).

The command must be run from `typescript/cli`. Always include `--yes` to skip the interactive confirmation prompt. For each protocol, expand `<KEY_<PROTOCOL>_VALUE>` per the artifact's `source` field using the key-value expansion legend (see `/warp-deploy-validate-owners` for the canonical table; the same mapping applies here).

```bash
pnpm --silent -C typescript/cli hyperlane warp deploy \
  --registry http://localhost:<port> \
  --warp-route-id <TOKEN>/<chains-alphabetical> \
  --key.ethereum <KEY_ETHEREUM_VALUE> \
  [--key.sealevel <KEY_SEALEVEL_VALUE>]   # only if sealevel chains present
  [--key.cosmos <KEY_COSMOS_VALUE>]       # only if cosmos chains present
  --yes
```

Where `<TOKEN>/<chains-alphabetical>` is the warp route ID from Step 7a, `<port>` is the HTTP registry port (typically `3333`), and `<KEY_<PROTOCOL>_VALUE>` is expanded per the artifact's `source` for that protocol (e.g. `"$(gcloud secrets versions access latest --secret=<name>)"` for `gcp-secret`, `"$<name>"` for `env-var`).

Show the user the exact command with the resolved secret/env-var NAMES substituted (from the artifact), never private-key values. Also show the corresponding derived `address` per protocol so the human can spot a wrong-key foot-gun at the gate. End your message with this marker (this MUST be the very last thing in your message):

```test
[CONFIRM: Run warp deploy for <warp-route-id>]
```

---

## Step 8: Run Warp Deploy

### 8a: Start the HTTP Registry FIRST

The HTTP registry MUST be running before the deploy command. Starting it later or skipping it means the deploy falls back to public-RPC gas estimates and is exposed to OOG / nonce errors on chains with flaky public free-tier RPCs (notably base, optimism, drpc-routed chains).

```bash
cd <MONOREPO_ROOT> && pnpm -C typescript/infra start:http-registry --writeMode
```

Run with `run_in_background: true`. Wait for the log line `Server running` (the actual line emitted by `typescript/http-registry-server/HttpServer.ts`; it includes the port in JSON metadata). Note the port (typically `3333`) and the background task/shell ID — you will need both to stop the server after the skill completes.

### 8b: Run the Deploy Command

Tell the user upfront:

> **Starting warp deploy for `<TOKEN>/<chains-alphabetical>`.**
> This deploys contracts on each chain sequentially and typically takes **5–15 minutes**.
> Chains: `<list all chains>`
> You'll see the full output when it completes.

Then run the deploy command from `typescript/cli`, with the port substituted from Step 8a. Always include `--yes`. Expand `<KEY_<PROTOCOL>_VALUE>` per the artifact's `source` field (see the key-value expansion legend in `/warp-deploy-validate-owners`):

```bash
pnpm --silent -C typescript/cli hyperlane warp deploy \
  --registry http://localhost:<port> \
  --warp-route-id <TOKEN>/<chains-alphabetical> \
  --key.ethereum <KEY_ETHEREUM_VALUE> \
  [--key.sealevel <KEY_SEALEVEL_VALUE>]   # only if sealevel chains present
  [--key.cosmos <KEY_COSMOS_VALUE>]       # only if cosmos chains present
  --yes
```

**On success:** the CLI writes a `<chains-alphabetical>-config.yaml` file next to the deploy.yaml in the registry. Show the user the full deploy output so they can see which contracts were deployed and their addresses.

**On failure:** show the error output and stop the HTTP registry (Step 8a), then do not proceed to Step 9. Common issues:

- Insufficient gas → run `/warp-deploy-fund-deployer` first
- RPC errors → check the chain's RPC URL in the registry
- Key not set → confirm the env variable is exported in the shell

---

## Step 9: Warp Send Test

Run the send test **now, while the deployer still owns the contracts** — before transferring ownership in Step 10.

Use the same key from the key-context artifact (loaded in Step 7c).

### HTTP-registry cache lag — wait before first send

The HTTP registry caches route configs in memory. Right after `warp deploy` writes the new `<chains-alphabetical>-config.yaml`, the running HTTP registry server may not have refreshed its cache yet — the first `warp send` will 404 with `route not found`. Wait ~5 seconds before the first send, and if the first send still 404's, verify the route is visible via `curl http://localhost:<port>/deployments/warp_routes/<TOKEN>/<chains-alphabetical>-config.yaml`, sleep another 5s, and retry.

```bash
sleep 5
# Then run the first send. If it 404's, verify with curl + sleep 5 + retry once before giving up.
```

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

# Forward (no fee on this direction for standard routes)
pnpm --silent -C typescript/cli hyperlane warp send \
  --registry http://localhost:<port> \
  --origin <chain1> --destination <chain2> \
  --amount 10000 --key.ethereum <KEY_ETHEREUM_VALUE> \
  -w <TOKEN>/<chains-alphabetical>

# Return (fee charged — use reduced amount)
pnpm --silent -C typescript/cli hyperlane warp send \
  --registry http://localhost:<port> \
  --origin <chain2> --destination <chain1> \
  --amount 9000 --key.ethereum <KEY_ETHEREUM_VALUE> \
  -w <TOKEN>/<chains-alphabetical>
```

### Multi-chain routes (1 native/collateral + multiple synthetics)

Do NOT use `--round-trip`. Test each native ↔ synthetic pair sequentially:

```bash

# For each synthetic chain: send native → synthetic (forward, no fee)
pnpm --silent -C typescript/cli hyperlane warp send \
  --registry http://localhost:<port> \
  --origin <native-chain> --destination <synthetic-chain> \
  --amount 10000 --key.ethereum <KEY_ETHEREUM_VALUE> \
  -w <TOKEN>/<chains-alphabetical>

# Then return: synthetic → native (fee charged — use reduced amount)
pnpm --silent -C typescript/cli hyperlane warp send \
  --registry http://localhost:<port> \
  --origin <synthetic-chain> --destination <native-chain> \
  --amount 9000 --key.ethereum <KEY_ETHEREUM_VALUE> \
  -w <TOKEN>/<chains-alphabetical>
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

If `TaskStop` doesn't clean up the underlying process (some sandboxes leave the registry running) and `ps`/`lsof`/`pkill`/`fuser` aren't available either, fall back to a `/proc` cmdline scan:

```bash
# Find PIDs matching the registry process — exclude the scanning shell itself
SELF_PID=$$
for pid in $(ls /proc | grep -E '^[0-9]+$'); do
  [ "$pid" = "$SELF_PID" ] && continue
  if grep -aql 'http-registry-server\|start:http-registry' /proc/$pid/cmdline 2>/dev/null; then
    echo "killing http-registry pid=$pid"
    kill "$pid" 2>/dev/null || true
  fi
done
```

This is the durable fallback for minimal-tool sandboxes. Always run after `TaskStop` regardless — idempotent if the process is already gone.

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
