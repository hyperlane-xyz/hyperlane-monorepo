---
name: warp-deploy-init
description: First step of deploying a new warp route. Reads a Linear ticket to extract token details and chain configuration, looks up mailbox addresses from the local registry, and generates the deploy.yaml file.
---

# Warp Route Deploy Init

You are generating the initial `deploy.yaml` for a new Hyperlane warp route deployment.

## Input

The user provides:

- **Linear ticket URL or ID** (required, e.g. `ENG-3516` or `https://linear.app/hyperlane-xyz/issue/ENG-3516/...`)
- **Deployer address** (optional, e.g. `--deployer 0xabc...` or just an address after the ticket ID)

If the ticket is not provided, ask for it now.

If a deployer address is provided, use it as the `owner` for **all chains** in the deploy.yaml instead of the real owner addresses from the ticket. This is the "test deploy" mode — ownership will be transferred to real owners after testing. When using deployer mode:

- Set every `owner` field (chain-level and tokenFee-level) to the deployer address
- Do NOT use `<ICA_ADDRESS>` placeholders — deployer address applies everywhere
- Tell the user clearly that this config uses the deployer address as temporary owner

If no deployer address is provided, ask: **"Do you want to use a temporary deployer address for all owners, or use the real owners from the ticket?"** If they choose deployer, ask for the address. If they choose real owners, proceed normally (with `<ICA_ADDRESS>` placeholders where ICAs are unknown).

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
| **Owner address**                | Address per chain — may differ if ICA addresses are used on non-Ethereum chains               |
| **Warp fee**                     | Fee in basis points (bps), if specified (e.g. `6bps`)                                         |
| **Fee owner**                    | Address that receives fees — defaults to the chain's `owner` if not specified                 |
| **Type overrides**               | Any chain that should be `native` instead of `collateral`/`synthetic`                         |

**Multi-collateral routes**: when the ticket lists multiple collateral chains, each gets its own `token` address. ICA owner addresses for non-Ethereum chains are often not yet known — use `<ICA_ADDRESS>` as a placeholder and flag clearly to the user.

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
REGISTRY_PATH="$(dirname $(pwd))/../hyperlane-registry"
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

**Rules:**

- Chains are listed in alphabetical order
- `token` field only present on `collateral` type
- `name` and `symbol` omitted on `native` type; `decimals` IS included
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

Ask the user: **"Does this deploy.yaml look correct? Type `yes` to proceed to deployment, or describe any changes needed."**

Do not proceed to Step 7 until the user confirms.

---

## Step 7: Prepare Warp Deploy Command

### 7a: Determine Warp Route ID

The warp route ID is derived from the deploy.yaml output path:

```
$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<chain1>-<chain2>-deploy.yaml
                                        └──────────────────────────────────┘
                                        Warp route ID = <TOKEN>/<chain1>-<chain2>
```

Example: if the file is `deployments/warp_routes/RISE/bsc-ethereum-deploy.yaml`, the warp route ID is `RISE/bsc-ethereum`.

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

### 7d: Ownership Warning

**If the deploy.yaml uses real owner addresses** (i.e., NOT the deployer address for all owners — meaning real Safe/ICA addresses appear in `owner` fields):

> ⚠️ **WARNING: This config uses real owner addresses, not a temporary deployer address.**
> Deploying directly with real owners means contracts will be owned by the multisig/ICA from day one.
> This is fine for production, but make sure you have verified each owner address exists on its chain before proceeding.
> If this is a test deploy, consider re-running with a deployer address as temporary owner.

If all `owner` fields equal the deployer address (deployer mode), no warning is needed.

### 7e: Build and Show the Command

Assemble the full deploy command. The command must be run from `typescript/cli`. Always include `--yes` to skip the interactive confirmation prompt:

```bash
cd typescript/cli

pnpm hyperlane warp deploy \
  --registry $REGISTRY_PATH \
  --warp-route-id <TOKEN>/<chain1>-<chain2> \
  --key.ethereum $MY_ETH_KEY_VAR \
  [--key.sealevel $MY_SOL_KEY_VAR]   # only if sealevel chains present
  [--key.cosmos $MY_COSMOS_KEY_VAR]   # only if cosmos chains present
  --yes
```

Where `$MY_ETH_KEY_VAR` etc. are the env variable names provided in 7c.

Show the user the exact command with the real values substituted. Then ask:

> **Ready to run the warp deploy?** Type `yes` to execute, or `no` to run it manually.

---

## Step 8: Run Warp Deploy

If the user confirms, tell the user upfront:

> **Starting warp deploy for `<TOKEN>/<chain1>-<chain2>`.**
> This deploys contracts on each chain sequentially and typically takes **5–15 minutes**.
> Chains: `<list all chains>`
> You'll see the full output when it completes.

Then run the deploy command from `typescript/cli`. Always use a 10-minute timeout (600000ms). Always include `--yes`:

```bash
cd /path/to/hyperlane-monorepo/typescript/cli && pnpm hyperlane warp deploy \
  --registry $REGISTRY_PATH \
  --warp-route-id <TOKEN>/<chain1>-<chain2> \
  --key.ethereum $MY_ETH_KEY_VAR \
  --yes
```

**On success:** the CLI writes a `<chain1>-<chain2>-config.yaml` file next to the deploy.yaml in the registry. Show the user the full deploy output so they can see which contracts were deployed and their addresses.

**On failure:** show the error output and stop. Do not proceed to Step 9. Common issues:

- Insufficient gas → run `/warp-deploy-preflight` first
- RPC errors → check the chain's RPC URL in the registry
- Key not set → confirm the env variable is exported in the shell

---

## Step 9: Warp Send Test (deployer mode, two-chain routes only)

**Skip this step if:** the route has more than 2 chains, or the deploy did NOT use a deployer address as owner.

Run the send test **now, while the deployer still owns the contracts** — before transferring ownership in Step 10.

Ask:

> **What environment variable holds your private key for sending test transactions?**
> (This is the actual private key value, not an address — e.g. `MY_PK`)

Then send a test transfer in **each direction** — chain A → chain B, then chain B → chain A. Run each send sequentially (wait for the first to complete before the second). Use `--amount 100000` (adjustable by user):

```bash
cd /path/to/hyperlane-monorepo/typescript/cli

# Send from chain1 → chain2
pnpm hyperlane warp send \
  --origin <chain1> \
  --destination <chain2> \
  --amount 100000 \
  --key $MY_PK \
  -w <TOKEN>/<chain1>-<chain2>

# Send from chain2 → chain1
pnpm hyperlane warp send \
  --origin <chain2> \
  --destination <chain1> \
  --amount 100000 \
  --key $MY_PK \
  -w <TOKEN>/<chain1>-<chain2>
```

Each send may take a few minutes to relay. After each send, show the user:

- Whether it succeeded or failed
- The **Message ID** (from the CLI output)
- The **Explorer link** (e.g. `https://explorer.hyperlane.xyz/message/<id>`)

If either send fails or times out, show the error and still report the message ID if available so it can be tracked. Do not block on failures — continue to Step 10 regardless.

---

## Step 10: Transfer Ownership to Real Owners (deployer mode only)

**Skip this step entirely if the deploy did NOT use a deployer address as temporary owner** (i.e., the deploy.yaml already has real owner addresses).

If the deploy used a deployer address, the deployed contracts are currently owned by the deployer. This step transfers ownership to the real owners from the ticket.

### 10a: Confirm Real Owners

Show the user the real owner addresses extracted from the ticket in Step 2. Present them clearly per chain, e.g.:

```
Real owners from ticket:
  ethereum:  0xSafe...
  arbitrum:  0xICA... (ICA address — confirm this has been deployed)
  base:      0xICA...
```

Ask the user:

> **Are these the correct real owner addresses?** Type `yes` to proceed, or provide corrections.

Wait for confirmation before proceeding. If the user provides corrections, update your record of owner addresses accordingly.

### 10b: Update deploy.yaml with Real Owners

Replace every occurrence of the deployer address in the deploy.yaml with the correct real owner per chain. Update `owner` fields at the chain level and inside any `tokenFee` blocks.

Write the updated deploy.yaml back to the registry path. Show the user the diff (old → new owners).

### 10c: Build and Run Warp Apply

Assemble the warp apply command. Use the same key environment variable(s) from Step 7c. Run from `typescript/cli`:

```bash
cd typescript/cli

pnpm hyperlane warp apply \
  --registry $REGISTRY_PATH \
  --key.ethereum $MY_ETH_KEY_VAR \
  [--key.sealevel $MY_SOL_KEY_VAR]  # only if sealevel chains present
  [--key.cosmos $MY_COSMOS_KEY_VAR]  # only if cosmos chains present
  -w <TOKEN>/<chain1>-<chain2>
```

Show the user the exact command and ask:

> **Ready to run warp apply to transfer ownership?** Type `yes` to execute, or `no` to run manually.

If the user confirms, run it with a 10-minute timeout (600000ms). Show the full output on completion.

**On failure:** show the error and stop. Do not proceed to Step 11. Common issues:

- Deployer key no longer has funds → top up and retry
- ICA address not yet deployed → deploy ICA first, then retry

### 10d: Verify Ownership with Warp Read

After warp apply completes, run warp read to confirm all ownership transfers took effect:

```bash
cd /path/to/hyperlane-monorepo/typescript/cli

pnpm hyperlane warp read \
  --registry $REGISTRY_PATH \
  -w <TOKEN>/<chain1>-<chain2>
```

Show the user the output and verify that each chain's `owner` matches the expected real owner address. Flag any discrepancies.

---

## Step 11: Add CoinGecko ID and Finalize Config

### 11a: Look Up CoinGecko ID

Search CoinGecko for the token symbol/name in the registry core-config.yaml.

If found, add `coinGeckoId: <api-id>` to each **non-synthetic** token entry in the config.yaml (i.e., `collateral` and `native` entries only — NOT `synthetic` entries).

Update the config.yaml file with the coinGeckoId field added after `addressOrDenom` (or at the end of each matching token block, before `connections`).

If not found on CoinGecko, note this to the user and skip.

### 11b: Show Final Config for Review

Show the user the complete final content of `<chains>-config.yaml`. Ask:

> **Does this config.yaml look correct?** Type `yes` to proceed, or describe any changes needed.

Do not proceed to Step 12 until the user confirms.

---

## Step 12: Commit, Push, and Open Registry PR

### 12a: Check Registry Git Status

```bash
cd $REGISTRY_PATH && git status
```

Show the user the list of changed/new files. There should be at minimum:

- `deployments/warp_routes/<TOKEN>/<chains>-deploy.yaml`
- `deployments/warp_routes/<TOKEN>/<chains>-config.yaml`

### 12b: Write Changeset

Write a changeset file directly to `$REGISTRY_PATH/.changeset/` — do NOT run the interactive CLI. Use a filename derived from the warp route (e.g. `add-ikas-ethereum-igra.md`):

```markdown
---
'@hyperlane-xyz/registry': minor
---

added <token-name> warp route on <chain1> and <chain2>
```

Follow the changeset style from CLAUDE.md: past tense, lowercase, concise. The bump is always `minor` for new warp routes.

### 12c: Create a Branch and Commit

Check out a new branch named after the warp route ID (replace `/` with `-`):

```bash
cd $REGISTRY_PATH
git checkout -b feat/<token-chains>
git add deployments/warp_routes/<TOKEN>/
git add .changeset/
git commit -m "feat: add <TOKEN>/<chain1>-<chain2> warp route"
```

### 12d: Push and Open PR

Push the branch and open a PR on GitHub:

```bash
cd $REGISTRY_PATH
git push -u origin HEAD
gh pr create \
  --title "feat: add <TOKEN>/<chain1>-<chain2> warp route" \
  --body "$(cat <<'EOF'
## Summary

Adds the `<TOKEN>/<chain1>-<chain2>` warp route.

| Field | Value |
| ----- | ----- |
| **Token** | <token-name> (<TOKEN>) |
| **Route type** | <e.g. native → synthetic, collateral → synthetic> |
| **Chains** | <chain1> (<type>), <chain2> (<type>), ... |
| **Decimals** | <decimals> |
| **Warp fee** | <fee in bps, or "none"> |
| **Owners** | <chain>: `<owner-address>`, ... |

### Contracts deployed

| Chain | Contract | Address |
| ----- | -------- | ------- |
| <chain> | <HypNative / HypSynthetic / HypERC20Collateral / ...> | `<address>` |
| ... | ... | ... |

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Fill in the PR body with real values from the deployment:

- Route type: describe the chain types (e.g. "igra (native) → ethereum (synthetic)")
- Contracts: list each deployed contract address from the config.yaml `addressOrDenom` fields
- Owners: list per-chain real owner addresses from the final deploy.yaml

Show the user the PR URL when done.

---

## Notes

- The registry path is `$(dirname $(pwd))/../hyperlane-registry` relative to the monorepo root. The hyperlane-registry repo is expected to be cloned at the same level as hyperlane-monorepo.
- For USDC, use the token addresses and CCTP bridge addresses from the reference tables above — no need to search the registry
- If the ticket has links to token contracts on block explorers, use those addresses
- `owner` is typically an Abacus Works Safe address specified in the ticket; for non-Ethereum chains managed via ICA, use `<ICA_ADDRESS>` as placeholder
- Do NOT search the registry for example deploys to copy from — the reference tables above have the canonical values
