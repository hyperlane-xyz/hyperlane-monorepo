---
name: warp-deploy-extend-route
description: Add a new chain to an existing warp route owned by a customer. Reads a Linear ticket, adds the new chain to the deploy.yaml, builds a customer-specific strategy file for existing chains, runs warp apply, and outputs transaction files for the customer to sign via their multisig.
---

# Warp Route Extension

You are adding a new chain to an existing Hyperlane warp route. The route is owned by the customer (their Gnosis Safe on ethereum, ICAs on other chains). You will deploy the new chain contracts with a deployer key, and generate transaction files for existing chains that the customer must sign.

## Input

The user provides:

- **Linear ticket URL or ID** (required, e.g. `ENG-3516`)

If missing, ask now.

### Key Context (Prerequisite)

This skill runs `warp apply` to extend a warp route to a new chain. It needs a deployer key matching the new chain's protocol to sign the new-chain deployment txs. It auto-loads `~/.hyperlane/key-contexts/<ticket-id>.yaml` produced by `/warp-deploy-select-keys`. If the artifact does not exist, invoke `/warp-deploy-select-keys <ticket-id>` first.

For each unique protocol touched by the extension (typically just the new chain's protocol, but `warp apply` may also need to sign on existing chains when re-applying their state), read `keys.<protocol>.name` and `keys.<protocol>.source` from the artifact. Expand `<KEY_<PROTOCOL>_VALUE>` placeholders in the commands below per the key-value expansion legend in `/warp-deploy-validate-owners`. The deployer address used as the new chain's temporary `owner` is `keys.<new-chain-protocol>.address` from the artifact — never use the customer's real ICA/Safe address as the temporary owner.

---

## Step 1: Fetch the Linear Ticket

Extract the issue ID (e.g. `ENG-3516`) and query:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ issue(id: \"<ISSUE_ID>\") { title description } }"}'
```

**If `LINEAR_API_KEY` is not set or returns 401:** Stop and tell the user to export it and restart.

Show the ticket title and description.

---

## Step 2: Extract Extension Details

Parse the ticket to extract:

| Field                        | Description                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------ |
| **Existing warp route ID**   | e.g. `USDC/igra` — look for "warp route ID" or derive from token + chain names |
| **New chain(s) to add**      | The chain(s) being added to the route                                          |
| **Token details**            | Symbol, decimals, name — usually carried from existing route                   |
| **Customer's ethereum Safe** | The multisig that owns the route on ethereum                                   |
| **Customer's ICA addresses** | Per-chain ICA addresses if the ticket lists them                               |
| **Owner type**               | Whether existing chains are owned by a Safe directly or via ICAs               |

Ask the user to clarify anything ambiguous.

---

## Step 3: Find Existing Route Files

Locate the existing deploy.yaml and config.yaml in the registry:

```bash
REGISTRY_PATH="$(pwd)/../hyperlane-registry"
ls "$REGISTRY_PATH/deployments/warp_routes/<TOKEN>/"
```

Read both files and show the user:

- Existing chains and their types
- Contract addresses (from config.yaml)
- Current owner addresses per chain

Identify all existing chains — these are the ones the customer controls and for which we need to generate transaction proposals.

---

## Step 4: Look Up Mailbox for New Chain

```bash
REGISTRY_PATH="$(pwd)/../hyperlane-registry"
cat "$REGISTRY_PATH/chains/<new-chain>/addresses.yaml" | grep "^mailbox:"
```

For Sealevel chains, also look up the IGP from `rust/sealevel/environments/mainnet3/<chain>/core/program-ids.json`.

**Tron address note**: Tron uses base58 `T...` addresses externally (e.g., TronScan, user-provided), but the Hyperlane contracts and deploy.yaml use EVM hex `0x...` format internally. Tron is EVM-like (`isEVMLike() = true`). Always convert any Tron base58 address to hex before putting it in deploy.yaml:

```bash
python3 -c "
import base58, sys
addr = base58.b58decode_check(sys.argv[1])
print('0x' + addr[1:].hex())
" TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
# → 0xa614f803b6fd780986a42c78ec9c7f77e6ded13c
```

This applies to: token address, mailbox address, owner address — anything going into deploy.yaml for Tron.

---

## Step 5: Determine Owner for the New Chain

The new chain's contract must be owned by the customer from the start — **never use the deployer address as owner**. Match the customer's existing ownership structure.

**Case A — Customer uses ICAs on non-ethereum chains (most common):**

The new chain needs an ICA owned by the customer's ethereum Safe. Run without `--deploy` first to compute the address deterministically, confirm it looks right, then re-run with `--deploy` to create it on-chain (ICAs are permissionless — anyone can deploy one):

```bash
cd typescript/infra

# Dry-run first (no gas spent):
pnpm tsx scripts/keys/get-owner-ica.ts \
  --environment mainnet3 \
  --ownerChain ethereum \
  --owner <CUSTOMER_ETHEREUM_SAFE> \
  --chains <new-chain>

# Then deploy:
pnpm tsx scripts/keys/get-owner-ica.ts \
  --environment mainnet3 \
  --ownerChain ethereum \
  --owner <CUSTOMER_ETHEREUM_SAFE> \
  --chains <new-chain> \
  --deploy
```

This prints the ICA address. Use it as the `owner` for the new chain in deploy.yaml.

**Tron ICA deployment caveat**: On Tron, `get-owner-ica.ts` may fail with `invalid BytesLike value` — see Tron-specific notes at the bottom.

**Tron TRX funding**: The deployer key needs ≥ **1000 TRX** before any Tron transaction — see Tron-specific notes.

**Case B — Customer owns directly with a Safe per chain (no ICAs):**

Use the customer's Safe address on the new chain directly as owner. Ask the user for that address if the ticket doesn't list it.

Ask the user which case applies if not clear from the ticket.

---

## Step 6: Add New Chain to deploy.yaml

Update the existing deploy.yaml to add the new chain. The new chain is almost always `synthetic`.

**Standard synthetic addition:**

```yaml
<new-chain>:
  decimals: <decimals> # from existing route
  mailbox: '<mailbox-address>'
  name: <token-name>
  owner: '<customer-ica-or-safe-address>'
  symbol: <token-symbol>
  type: synthetic
```

**If the new chain is Tron (collateral):**

```yaml
tron:
  decimals: <decimals> # typically 6 for USDT
  mailbox: '<mailbox-address-in-0x-hex>' # convert from base58 if needed
  name: <token-name>
  owner: '<customer-ica-address-in-0x-hex>' # EVM hex, not base58
  scale: <scale-factor-if-needed> # e.g. 1000000000000 if bridging to 18-decimal chain
  symbol: <token-symbol>
  token: '<token-contract-in-0x-hex>' # MUST be EVM hex, not Tron base58
  type: collateral
```

**If the new chain is Sealevel (solanamainnet, eclipsemainnet):**

```yaml
<new-chain>:
  decimals: <9-if-18-decimals-collateral-else-match>
  gas: 300000
  hook: '<igp-address-from-program-ids.json>'
  mailbox: '<mailbox-address>'
  metadataUri: 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/deployments/warp_routes/<TOKEN>/metadata.json'
  name: <token-name>
  owner: '<customer-owner-address>'
  symbol: <token-symbol>
  scale: <10^(collateral_decimals - 9) if collateral decimals > 9, else omit>
  type: synthetic
```

**Rules:**

- **Only append the new chain — do NOT modify any existing chain entries**
- **Top-level chain entries must be in alphabetical order by chain name.** Insert the new chain at its alphabetical position; do NOT append at the top or bottom. E.g. adding `kava` to an `arbitrum + ethereum` route produces `arbitrum`, `ethereum`, `kava` — but inserting `base` into the same route would produce `arbitrum`, `base`, `ethereum`. Re-sort if needed; CI blocks PRs where chains aren't sorted.
- **Keys within the new chain entry must also be in strict alphabetical order.** E.g. `decimals` before `mailbox` before `name` before `owner` before `symbol` before `token` before `type`. (Re-sort the inline template above if you edit it.)
- Copy `decimals`, `name`, `symbol` from existing entries
- `owner` is always the customer's ICA or Safe address from Step 5 — never the deployer

Write the updated deploy.yaml back to the registry. Show the user the diff (new chain entry only), then end your message with this marker (this MUST be the very last thing in your message):

```test
[CONFIRM: Proceed with deploy.yaml extension for <new-chain>]
```

Do not proceed until confirmed.

---

## Step 7: Build the Customer Strategy File

Determine the customer's ownership structure from Step 2 and the existing deploy.yaml owners.

**Output strategy file:** `~/.hyperlane/strategies/<customer-name>-strategy.yaml`
(Derive `<customer-name>` from the ticket/token/customer — e.g. `moonpay`, `nexus`, `eni`)

**Strategy structure depends on owner type:**

### If customer uses ICAs on non-ethereum chains (most common pattern):

The ethereum chain has a Gnosis Safe. All other chains have ICA submitters routing through that Safe.

```yaml
ethereum:
  submitter:
    type: gnosisSafeTxBuilder
    chain: ethereum
    version: '1.0'
    safeAddress: '<CUSTOMER_ETHEREUM_SAFE>'

<chain1>: # existing non-ethereum chain
  submitter:
    type: interchainAccount
    chain: ethereum
    destinationChain: <chain1>
    owner: '<CUSTOMER_ETHEREUM_SAFE>'
    internalSubmitter:
      type: gnosisSafeTxBuilder
      chain: ethereum
      safeAddress: '<CUSTOMER_ETHEREUM_SAFE>'

# ... repeat for all existing chains except the NEW chain
# Do NOT add the new chain to the strategy — it's deployed directly with our key
```

**Do NOT include the new chain** in the strategy. The strategy covers only existing chains (owned by customer). The new chain is deployed with our deployer key.

### If the route has a fee contract with a separate fee Safe (common for AW-managed routes):

Some routes have a `tokenFee.feeContracts` section in deploy.yaml with a separate owner (the AW fee Safe). Add a `feeSubmitter` to each chain entry — it mirrors the main submitter structure but uses the fee Safe address instead.

The fee Safe ethereum address is in `typescript/infra/config/environments/mainnet3/governance/safe/warpFees.ts` (`ethereum` entry = `0x8Ff4c563f26db00e65bD93d9f662A51c304C09b0`). Per-chain ICA addresses (what goes in `feeContracts[chain].owner` in deploy.yaml) are in `typescript/infra/config/environments/mainnet3/governance/ica/warpFees.ts`. These are different: deploy.yaml uses the ICA address per chain, the strategy `feeSubmitter` uses the ethereum Safe as the controlling account.

```yaml
ethereum:
  submitter:
    type: gnosisSafeTxBuilder
    chain: ethereum
    version: '1.0'
    safeAddress: '<CUSTOMER_ETHEREUM_SAFE>'
  feeSubmitter:
    type: gnosisSafeTxBuilder
    chain: ethereum
    version: '1.0'
    safeAddress: '<FEE_SAFE>'

<chain1>:
  submitter:
    type: interchainAccount
    chain: ethereum
    destinationChain: <chain1>
    owner: '<CUSTOMER_ETHEREUM_SAFE>'
    internalSubmitter:
      type: gnosisSafeTxBuilder
      chain: ethereum
      safeAddress: '<CUSTOMER_ETHEREUM_SAFE>'
  feeSubmitter:
    type: interchainAccount
    chain: ethereum
    destinationChain: <chain1>
    owner: '<FEE_SAFE>'
    internalSubmitter:
      type: gnosisSafeTxBuilder
      chain: ethereum
      safeAddress: '<FEE_SAFE>'
```

The fee submitter generates a separate combined Safe TX Builder bundle for the fee Safe (distinct from the customer's main bundle).

### If customer has a Solana/Sealevel chain:

Add a `file` submitter for that chain — the transactions will need to be executed by the customer using their Solana tooling:

```yaml
solanamainnet:
  submitter:
    type: file
    chain: solanamainnet
    filepath: /tmp/<customer>-solanamainnet-txs.json
```

### If the new chain is also ICA-owned:

If in Step 5 we deployed a new ICA for the customer on the new chain, we should still NOT include the new chain in the strategy (the new chain's contracts don't exist yet — `warp apply` will deploy them with our key). After deployment, we'll separately need to transfer ownership if we used the deployer as temp owner.

Write the strategy file.

---

## Step 8: Load Keys from the Key-Context Artifact

Read `keys.<protocol>.name` and `keys.<protocol>.source` from `~/.hyperlane/key-contexts/<ticket-id>.yaml` for every protocol touched by the extension. Do NOT ask the user for env var names inline — the artifact is the source of truth (see the "Key Context (Prerequisite)" section at the top of this skill).

---

## Step 9: Run Warp Apply

### 9a: Start the HTTP Registry

```bash
cd <MONOREPO_ROOT> && pnpm -C typescript/infra start:http-registry --writeMode
```

Run with `run_in_background: true`. Wait for `Listening on http://localhost:<port>`. Note the port and task ID.

### 9b: Build and Show the Command

The command runs from `typescript/cli`. Expand `<KEY_<PROTOCOL>_VALUE>` per the artifact's `source` field (see the key-value expansion legend in `/warp-deploy-validate-owners`):

```bash
pnpm --silent -C typescript/cli hyperlane warp apply \
  --registry http://localhost:<port> \
  --key.ethereum <KEY_ETHEREUM_VALUE> \
  [--key.sealevel <KEY_SEALEVEL_VALUE>]  # only if new chain is Sealevel
  [--key.tron <KEY_TRON_VALUE>]          # only if new chain is Tron
  --strategy ~/.hyperlane/strategies/<customer>-strategy.yaml \
  --receipts-dir /tmp/<customer>-<warp-route-id>-txs \
  -w <WARP_ROUTE_ID> \
  --yes
```

**Key flag rule**: NEVER combine `--key` (legacy) with `--key.<protocol>`. Always use `--key.ethereum` (and `--key.<protocol>` for other protocols) together. Using both `--key` and `--key.tron` will error: _"make sure to use --key.{protocol} or the legacy flag --key but not both"_.

Tell the user:

> **Starting warp apply to extend `<WARP_ROUTE_ID>`.**
> This deploys contracts on `<new-chain>` and generates transaction proposals for existing chains.
> Existing chains requiring customer signature: `<list>`
> New chain being deployed: `<new-chain>`

End your message with this marker (this MUST be the very last thing in your message):

```test
[CONFIRM: Run warp apply to extend route to <new-chain>]
```

### 9c: Run the Command

Run it from `typescript/cli`. Show full output on completion.

**On success:** the CLI deploys new contracts and writes tx proposal files to the receipts-dir.

**After success — verify no `transferOwnership` to deployer:**

```bash
grep -r "transferOwnership" /tmp/<customer>-<warp-route-id>-txs/
```

If you see `transferOwnership` calls targeting the deployer address in files for **existing** chains, the deploy.yaml `owner` fields were corrupted (likely by a previous run). **Stop immediately — do not send these files to the customer.** To fix:

1. Restore correct ICA owners in `deploy.yaml` for existing chains (check git history for original values)
2. Restart the HTTP registry and re-run `warp apply`

`transferOwnership` to the **new chain's deployer address** in the new chain's jsonRpc receipt is expected (the deployer owns the new contract and can manage it).

**On failure:** stop the HTTP registry and show the error. Common issues:

- Deployer key not funded → run `/warp-deploy-fund-deployer` first
- Strategy chain not in config → verify all existing chains appear in the strategy
- ICA not deployed → go back to Step 5 and deploy the ICA

### 9d: Stop the HTTP Registry

```bash
# Kill background task noted in 9a
```

Always stop it even on failure.

---

## Step 10: Collect TX Files and Send to Customer

### 10a: Find the Output Files

The strategy submitters write transaction proposals to the receipts-dir:

```bash
ls -la /tmp/<customer>-<warp-route-id>-txs/
```

For `gnosisSafeTxBuilder`: the output JSON is a Safe Transaction Builder batch importable to the Gnosis Safe UI (`https://app.safe.global` → Apps → Transaction Builder → Import).

For `interchainAccount` submitter: generates **one separate Safe TX Builder JSON per destination chain**, all with `chainId: "1"` (all destined for the ethereum Safe). The customer must import and execute each file separately — they are NOT combined into one file.

For `file` submitter: raw transaction JSON for that chain.

**New chain receipt file is NOT for the customer**: The `<new-chain>-jsonRpc-*.json` file contains transactions that were already executed directly by the deployer key during `warp apply` (e.g. setting destination gas on the new contract). Do NOT send this to the customer.

Show the user the full path of each output file and clarify which ones go to the customer.

### 10b: Summarize Deployment Results

Show the user:

1. **New contracts deployed** (from the `warp apply` output):
   | Chain | Contract Type | Address |
   | ----- | ------------- | ------- |
   | `<new-chain>` | `HypSynthetic` | `0x...` |

2. **Transaction files for customer** (in receipts-dir):
   | File | Chain(s) | Action Required |
   | ---- | -------- | --------------- |
   | `ethereum-txs.json` | ethereum + ICA chains | Import to Safe UI and sign |
   | `solanamainnet-txs.json` | solanamainnet | Execute using Solana tooling |

3. **What the customer transactions do:**
   - `enrollRemoteRouter` on existing chain contracts to recognize the new chain
   - (If ICA was just deployed) Initialize the new ICA on each destination

---

## Step 11: Registry PR (Extension)

After the customer executes their transactions and the route is live, update the registry:

### 11a: Update config.yaml

The `warp apply` run should have updated the config.yaml with the new chain's deployed address. Verify:

```bash
cat $REGISTRY_PATH/deployments/warp_routes/<TOKEN>/<file>-config.yaml
```

If it wasn't updated (e.g., due to registry write failures), manually add the new chain's contract address to config.yaml following the existing format.

### 11b: Commit and Open PR

```bash
cd $REGISTRY_PATH
git checkout -b feat/extend-<TOKEN>-<new-chain>
git add deployments/warp_routes/<TOKEN>/
git commit -m "feat: extend <WARP_ROUTE_ID> to <new-chain>"
git push -u origin HEAD

gh pr create \
  --base main \
  --title "feat: extend <WARP_ROUTE_ID> to <new-chain>" \
  --body "$(cat <<'EOF'
## Summary

Extends the `<WARP_ROUTE_ID>` warp route to `<new-chain>`.

| Field | Value |
| ----- | ----- |
| **Linear** | <linear-issue-url> |
| **Warp route ID** | `<WARP_ROUTE_ID>` |
| **New chain** | `<new-chain>` |
| **Customer Safe** | `<safe-address>` |

### New contracts deployed

| Chain | Contract | Address |
| ----- | -------- | ------- |
| `<new-chain>` | `HypERC20` / `HypSynthetic` | `0x...` |

### ICAs deployed

| Chain | ICA Address | Owner Safe |
| ----- | ----------- | ---------- |
| `<new-chain>` | `0x...` | `<safe-address>` |

### Customer action required

The customer must sign and execute the transaction proposals in:
- `<path-to-txs-file>`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Show the user the PR URL.

---

## Notes

- The registry path is `$(pwd)/../hyperlane-registry` from the monorepo root.
- The strategy file covers only **existing** chains (customer-owned). The new chain uses the deployer key directly.
- `gnosisSafeTxBuilder` output is importable to Gnosis Safe UI: Apps → Transaction Builder → "Import".
- `interchainAccount` submitter generates **one file per destination chain** (all `chainId: "1"`, all for the ethereum Safe) — NOT a single bundled file.
- If the customer has an `apiKey` for the Safe (from the strategy yaml pattern in nexus-strategy.yaml), ask if they need it included.
- The `file` submitter for Sealevel chains writes raw transactions — the customer executes these with their Solana CLI or tooling.
- After this skill, run `/warp-deploy-register-route` once the registry PR is merged to update warpIds.ts and agent config.
- **`warp apply` re-runs corrupt deploy.yaml owners (bug, fixed in monorepo):** `runWarpRouteApply` previously set ALL chain owners to the deployer in `intermediateOwnerConfig` and wrote that back to the registry — meaning a second run would generate `transferOwnership(deployer)` for every existing chain. The fix scopes this override to new chains only. If working with an older CLI, always check for unexpected `transferOwnership` calls after running (see Step 9c).

### Tron-specific notes

- Tron is EVM-like: same deployer key (EVM private key) works, standard ICA scripts work.
- **Always use EVM hex `0x...` in deploy.yaml** — never Tron base58 `T...`. Passing a base58 address to ethers.js causes `invalid address` error.
- Convert base58 → hex: `python3 -c "import base58, sys; a = base58.b58decode_check(sys.argv[1]); print('0x'+a[1:].hex())" <TRON_ADDR>`
- Deployer needs ≥ 1000 TRX before any Tron transaction (feeLimit cap in TronWallet.ts).
- If `get-owner-ica.ts --deploy` fails on Tron with `invalid BytesLike value`, it's a `TronWallet.buildContractCall` bug — write a custom script calling `triggerSmartContract` with individually typed params and `feeLimit: 15_000_000`.
