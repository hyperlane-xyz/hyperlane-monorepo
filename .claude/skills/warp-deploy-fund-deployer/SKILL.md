---
name: warp-deploy-fund-deployer
description: Pre-flight gas and balance check before deploying a warp route. Reads a Linear ticket, checks deployer wallet native gas balances per chain (warn if <$10), and checks collateral token balance (need ~$1 for testing).
---

# Warp Route Deploy Preflight Check

You are checking whether a deployer wallet has sufficient funds (gas + collateral tokens) before deploying a new warp route.

## Run Log (mandatory)

Maintain the durable, per-ticket run log per `/warp-run-log` — that skill owns the storage contract (Linear-document-by-title primary, single-writer discipline, local-file fallback), the `chain | protocol | shape | floor | actual | verdict` machine-row + prose entry shape, and the surface-the-URL-as-proof hard gate. Use `warp-deploy-fund-deployer` as the skill name in each prose entry, and do not report this skill complete until the run-log URL has been surfaced.

**Log at least:** (a) skill entry with the ticket ID + deployer address, (b) every `[CONFIRM:]` gate — before showing it to the user AND after their response, (c) every balance-check result per chain (expected floor vs actual balance, in native token units + USD), (d) every funding-command execution (amount, tx hash, wall-clock), (e) skill exit (success or bail-out). Once the deploy runs and the actual on-chain consumption is known, append a post-hoc row per chain so the next floor revision can compare floor to reality. Log smooth steps too — success data grounds the retrospective as much as failure data.

## Input

The user provides:

- **Linear ticket URL or ID** (required, e.g. `ENG-3516`)
- **Deployer address** (optional — auto-loaded from key-context if absent; see below)

### Key Context (Prerequisite)

This skill funds the deployer address(es) the warp-deploy chain will use. It auto-loads `~/.hyperlane/key-contexts/<ticket-id>.yaml` produced by `/warp-deploy-select-keys`. If the artifact does not exist and the user did not provide an explicit deployer address, invoke `/warp-deploy-select-keys <ticket-id>` first.

For each protocol resolved in the artifact, the recipient address for funding on that protocol's chains is `keys.<protocol>.address`. A pure-EVM route funds one EVM address across all EVM chains; a cross-VM route funds the protocol-matching address per chain (e.g. EVM address on EVM chains, SVM address on Solana, etc.). If the user supplied an explicit deployer address that does NOT match any address in the artifact, surface this discrepancy before proceeding.

---

## Step 1: Fetch the Linear Ticket

Fetch the ticket per `/fetch-linear-ticket`. Read the token, chains, and "Did they send funds" details from the returned description.

---

## Step 2: Extract Chains and Token Details

Parse the ticket to extract:

| Field                   | Description                                                     |
| ----------------------- | --------------------------------------------------------------- |
| **Token symbol**        | e.g. `USDC`, `RISE`                                             |
| **Collateral chain(s)** | Chain(s) where the real token lives, with token address         |
| **Synthetic chain(s)**  | Chains getting a synthetic (bridged) representation             |
| **Native chain(s)**     | Chains where the native gas token is bridged (no token address) |

Classify each chain as `collateral`, `synthetic`, or `native`.

---

## Step 3: Get Registry Path and RPC URLs

```bash
REGISTRY_PATH="${HYPERLANE_REGISTRY:-$(pwd)/../hyperlane-registry}"
echo "Registry: $REGISTRY_PATH"
```

For each chain in the warp route, get the RPC URL from the registry:

```bash
# Get the first rpcUrl for a chain
cat "$REGISTRY_PATH/chains/<chain>/metadata.yaml" | grep -A2 "rpcUrls:" | head -3
```

Extract the `http` URL from the first entry under `rpcUrls`. Also extract `nativeCurrency.symbol` and `nativeCurrency.decimals` for display, and the `coingeckoId` field for price lookups.

If a chain is not in the registry, warn the user and skip that chain.

---

## Step 4: Fetch Current Gas Price and Compute Required Balance Per Chain

The CLI uses this exact formula to determine the minimum native balance needed for a warp deploy (from `typescript/cli/src/consts.ts` and `typescript/cli/src/utils/balances.ts`):

```
required_wei = currentGasPrice_wei × WARP_DEPLOY_GAS (30,000,000)
required_native = required_wei / 10^decimals
```

For each EVM chain, fetch the current gas price via JSON-RPC:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1}' \
  <RPC_URL>
# Returns hex gas price in wei, e.g. "0x3B9ACA00" = 1 gwei
```

Then compute:

```python
WARP_DEPLOY_GAS = 30_000_000
gas_price_wei   = int(hex_result, 16)
required_wei    = gas_price_wei * WARP_DEPLOY_GAS
required_native = required_wei / 10**18   # (adjust decimals for non-18-decimal chains)
```

Add a **2× safety buffer** on top of this: gas prices can spike between check time and deploy time, and a multi-collateral route deploys more contracts than a standard route.

```python
required_with_buffer = required_native * 2
```

> **This floor is a deliberate conservative CEILING, not a cost estimate.** `WARP_DEPLOY_GAS = 30_000_000` is the SDK's upper-bound constant; a typical single-chain EVM warp deploy actually burns ~3–5M gas, so `30M × 2×` over-provisions the real single-attempt cost by roughly **5–10×**. That is intentional — an out-of-gas failure mid-deploy is far worse than leaving unused native in the deployer key (the excess is not lost; it stays available for later deploys). Consequences to keep in mind: the balance check may report `⚠️ LOW` and fund a chain that already had enough for the actual burn, and the >10 USD warning below may trip on the ceiling even when the true cost is under $10. Present the number to the operator as a conservative ceiling, never as "this deploy will cost X". The precise per-route-shape figure comes from `getMinGasForWarpDeploy(config)` on `IProtocolProvider` (PR #9075) — once that lands, consume it instead of this flat ceiling. Until then, always log the **actual** post-deploy burn next to this floor (see the Run Log) so the estimate can be tightened.

Fetch native token USD prices via CoinGecko to display USD equivalents (for informational purposes and to trigger the >10 USD warning):

```bash
curl -s "https://api.coingecko.com/api/v3/simple/price?ids=<id1>,<id2>&vs_currencies=usd"
```

Common native token CoinGecko IDs:
| Chain | CoinGecko ID |
|---|---|
| ethereum | `ethereum` |
| arbitrum | `ethereum` |
| base | `ethereum` |
| optimism | `ethereum` |
| polygon | `polygon-ecosystem-token` |
| bsc | `binancecoin` |
| avalanche | `avalanche-2` |
| solana | `solana` |
| celo | `celo` |
| gnosis | `xdai` |

If CoinGecko fails for a chain, **do not silently fall back to 0 USD** — that would bypass the 10 USD warning and the funding script's `MAX_FUNDING_AMOUNT_IN_USD` safety bound. Instead, the agent tries **alternative price venues** in order before escalating to the user:

1. **CoinMarketCap** — `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest` (requires `CMC_API_KEY`).
2. **Binance public API** — `https://api.binance.com/api/v3/ticker/price?symbol=<SYMBOL>USDT` for tokens with active Binance markets.
3. **Uniswap on-chain quote** — query the relevant Uniswap V3 pool's `slot0` against a stablecoin pair (USDC / USDT) on the same chain; useful for tokens with liquidity but no CEX listing.
4. **Only if all of the above fail**: surface the missing price to the user and ask them to supply a manual override via the funding script's `--price` flag (see Step 8).

When an alternative venue produces a price, log which venue and the value (so the operator can audit). The fund-wallet script's `MAX_FUNDING_AMOUNT_IN_USD` safety bound stays in force regardless of which source produced the price.

**⚠️ Warning threshold**: If the required amount (with buffer) exceeds **10 USD**, warn the user explicitly before running funding commands. On gas-market chains this is the conservative ceiling described above, so it may exceed $10 even when the true deploy cost is well under it — frame the warning as "conservative ceiling ≈ $X (actual typically far lower)", not as a firm cost, and still surface it so the operator can sanity-check an unusually high number (e.g. a genuine gas spike).

---

## Step 5: Check Deployer Native Gas Balance Per Chain

For each chain in the warp route, resolve the deployer's per-protocol address from the key-context artifact (`keys.<protocol>.address`) and check the native balance against the chain's required floor **for this route's shape**.

### Cost models — and why "trust the CLI check" is not enough

Chains bill for a warp-deploy in different ways, and the CLI's shared preflight (`nativeBalancesAreSufficient` at `typescript/cli/src/utils/balances.ts`) only handles the linear one:

- **EVM (and any chain with a non-null `gasPrice` in the registry) — linear gas market.** Cost = `gasPrice × units`. The CLI computes this correctly.
- **Sealevel (Solana, Eclipse) — rent-exempt reserve.** Cost = the sum of rent-exempt lamports locked in the accounts the deploy creates (program data, token PDA, ATA payer, fee program if present). Not a `gasPrice × units` product; SVM has `gasPrice: null` in the registry.
- **Tron — energy + bandwidth.** Cost = TRX burned for bandwidth (broadcast) and energy (contract execution). Not a `gasPrice × units` product; Tron has `gasPrice: null` in the registry.

**`nativeBalancesAreSufficient` short-circuits on any chain with `gasPrice: null`** (`if (!gasPrice) return;` at `balances.ts:79-81`) — it reports the chain as "OK" without checking anything. An under-funded SVM or Tron leg sails through the CLI preflight and fails mid-deploy.

**Do NOT treat a silent CLI pass on a null-gasPrice chain as ✅ OK.** For those chains, use the per-protocol / per-route-shape floor tables below and check the balance manually.

### For gas-market chains (EVM, and any non-EVM chain with a non-null `gasPrice`)

Use the CLI's formula (matches `nativeBalancesAreSufficient`):

- `requiredUnits = protocolClient.getMinGas().WARP_DEPLOY_GAS`
- `requiredNative = requiredUnits × gasPrice` — `gasPrice` from `provider.getGasPrice()` (EVM) or `multiProvider.getChainMetadata(chain).gasPrice.amount` (altvm)
- `actualBalance = provider.getBalance(address)` (EVM) or `signer.getBalance({ address, denom })` (altvm)
- Apply a 2× safety buffer on `requiredNative` — gas can spike between preflight and deploy

Interfaces: `getProtocolProvider(protocol).getMinGas()` per altvm SDK (`typescript/<protocol>-sdk/src/clients/protocol.ts`); `IProvider.getBalance` from `typescript/provider-sdk/src/altvm.ts`.

### For null-gasPrice chains (SVM, Tron)

The flat `getMinGas().WARP_DEPLOY_GAS` constant on these SDKs is calibrated for a **vanilla synthetic-or-collateral** router. It's silently wrong for cross-collateral + fee routes: on SVM those add per-program rent-exempt reserves that a single flat number can't express; on Tron the extra energy/bandwidth needed for the additional contracts likewise isn't captured. Use the shape-aware floors below, matched to what the ticket says the route will look like on this chain.

**Determining a chain's route shape from the ticket** (before deploy.yaml exists). "Shape" here is the on-chain **token type** deployed on this chain — that is what sets the floor — NOT the route's topology. Do not confuse a **multi-collateral** route (more than one collateral chain) with the `crossCollateral` token type: multi-collateral is simply several independent plain `collateral` routers, whereas `crossCollateral` is a distinct token type (collateral↔collateral swaps backed by shared cross-collateral routers) with a higher per-chain floor. They are orthogonal — a route can have many collateral chains and none of them be `crossCollateral`.

- Read each chain's token type from its per-chain designation in the ticket (`collateral` / `synthetic` / `native` / `crossCollateral`). Several collateral chains on their own → each is a plain `collateral` router (base floor), **not** `crossCollateral`.
- Classify a chain as `crossCollateral` **only** when the ticket explicitly calls for cross-collateral / collateral-swap behavior on it — never merely because the route lists multiple collateral chains.
- Ticket has a Warp Fee row set → each chain quoting a fee has a fee program.
- Ticket calls for a custom ISM or hook beyond the mailbox default → each such chain deploys an extra program.

**SVM (solanamainnet, eclipsemainnet) — required floor in SOL:**

| Route shape (this chain)                                      | Floor    | Notes                                                                                                                                   |
| ------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Base collateral / synthetic router, no fee                    | 2.6 SOL  | Program + token PDA + ATA payer rent. Empirically validated on prior deploys.                                                           |
| `crossCollateral` router, no fee                              | ≥3.7 SOL | Composed: base 2.6 + cross-collateral extra 1.1. Not yet empirically validated — bias high and log the actual.                          |
| `synthetic` / `collateral` router + fee program on this chain | ≥5.1 SOL | Composed: base 2.6 + fee program 2.5. Not yet empirically validated — bias high and log the actual.                                     |
| `crossCollateral` router + fee program on this chain          | 6.5 SOL  | Composed constants sum to 6.2 (2.6 + 1.1 + 2.5); observed cost exceeds that — use 6.5 until the actual is measured with more precision. |
| Any of the above + custom ISM deployment on this chain        | +?       | Not yet quantified — capture the actual during deploy and log it.                                                                       |
| Any of the above + custom hook deployment on this chain       | +?       | Not yet quantified — capture the actual during deploy and log it.                                                                       |

**Tron (tron) — required floor in TRX:**

| Route shape (this chain)                         | Floor    | Notes                                                                    |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| Base collateral / synthetic router, no fee       | 1000 TRX | Validated empirically on prior Tron warp-route deploys                   |
| Cross-collateral router, or router + fee program | 1500 TRX | Conservative; actual not yet measured — capture during deploy and log it |

Tron bills in energy + bandwidth, not `gasPrice × units`, so no formula generalizes; the table is the source of truth for this skill.

Manual balance checks for null-gasPrice chains:

```bash
# SVM
solana balance <address> --url <mainnet-rpc>

# Tron (via TronGrid)
curl -s "https://api.trongrid.io/v1/accounts/<T-address>" | jq '.data[0].balance / 1e6'
```

### Reporting

Per chain, emit one of:

- ✅ **OK** — actual ≥ floor (gas-market chains include the 2× buffer; null-gasPrice chains use the table floors as-is — they already include headroom)
- ⚠️ **LOW** — 0 < actual < floor (fund + continue)
- ❌ **EMPTY** — actual = 0 (fund + flag)

For null-gasPrice chains, ALWAYS state the applied shape and floor explicitly — the reader must not confuse this with the CLI's silent pass:

```
Chain: ethereum (evm)  [gas-market]
  WARP_DEPLOY_GAS: 30_000_000 × 0.13 gwei → 0.0078 ETH (2× buffer) = ~16.09 USD
  Balance:         0.002 ETH (~4.13 USD)
  ⚠️  SHORT: fund 0.006 ETH (~12.38 USD more)

Chain: solanamainnet (svm)  [null-gasPrice — CLI preflight does NOT apply]
  Route shape on this chain: crossCollateral router + fee program  (example — actual shape comes from the ticket)
  Applied floor:  6.5 SOL (composed 2.6 + 1.1 + 2.5 = 6.2, observed slightly higher; log the actual once known)
  Balance:        0.3 SOL
  ⚠️  SHORT: fund 6.2 SOL more

Chain: tron (tron)  [null-gasPrice — CLI preflight does NOT apply]
  Route shape on this chain: cross-collateral + fee  (example — actual shape comes from the ticket)
  Applied floor:  1500 TRX  (conservative; capture the deploy's actual consumption during the run and log it)
  Balance:        0 TRX
  ❌  EMPTY: fund 1500 TRX
```

**⚠️ Warning threshold**: if any chain's required amount (gas-market chains: with buffer; null-gasPrice chains: floor) exceeds 10 USD, warn explicitly before running funding commands.

---

## Step 6: Check Collateral Token Balance (If Applicable)

For each **collateral chain**, check if the deployer holds the collateral token. For testing, 1 USD worth is sufficient.

### Step 6a: Detect ERC4626 Vault Tokens

Before checking balances, determine whether the collateral token is an ERC4626 vault. Call `asset()` on the token contract:

```bash
cast call <TOKEN_ADDRESS> "asset()(address)" --rpc-url <RPC_URL>
```

- If the call **succeeds and returns a non-zero address**, the token is an ERC4626 vault. Use the returned address as the **source token** for funding — the deployer needs the underlying asset, not the vault share.
- If the call **reverts or returns zero**, the token is a standard ERC20 — proceed as normal.

When an ERC4626 is detected, note it clearly:

```
Chain: ethereum (collateral)
  Token: wsETH (0xAbc...) — ERC4626 vault
  Underlying asset: wstETH (0xDef...)
  → Funding will be requested in wstETH, not wsETH
```

For the rest of Step 6, replace `TOKEN_ADDRESS` with the underlying asset address when an ERC4626 is detected.

### Step 6b: Check Balance

```bash
# Get raw balance (returns token units in smallest denomination)
cast call <TOKEN_ADDRESS> "balanceOf(address)(uint256)" <DEPLOYER_ADDRESS> --rpc-url <RPC_URL>
```

Get token decimals:

```bash
cast call <TOKEN_ADDRESS> "decimals()(uint8)" --rpc-url <RPC_URL>
```

Convert: `balance / 10^decimals` = human-readable amount.

For price of the collateral token, use CoinGecko contract address lookup:

```bash
curl -s "https://api.coingecko.com/api/v3/simple/token_price/<platform>?contract_addresses=<TOKEN_ADDRESS>&vs_currencies=usd"
```

Where `<platform>` is the CoinGecko platform ID for the chain (e.g. `ethereum`, `arbitrum-one`, `base`, `polygon-pos`, `binance-smart-chain`).

If CoinGecko has no price for the collateral token, **do not invent one with hardcoded fallbacks** — those silently bypass the `MAX_FUNDING_AMOUNT_IN_USD` safety bound. The agent uses the same alternative-venue chain as Step 4: CoinMarketCap → Binance → Uniswap on-chain quote → only as a last resort, ask the user for a manual `--price <usd>` override on `fund-wallet-from-deployer-key.ts` (see Step 8). Always log which venue produced the price.

**Threshold: 1 USD worth of collateral token** (or its underlying asset if ERC4626)

Report:

- ✅ **OK** — holds >= 1 USD of collateral token (or underlying asset)
- ⚠️ **LOW** — holds > 0 but < 1 USD (may be enough if price is just unavailable)
- ❌ **NONE** — zero balance — must acquire some for testing

When insufficient:

```
Chain: ethereum (collateral)
  Token: USDC (0xA0b8...)
  Balance: 0 USDC
  ❌  Need at least 1 USD of USDC for testing. Request from faucet or transfer a small amount.
```

For ERC4626 vaults with insufficient underlying asset:

```
Chain: ethereum (collateral)
  Token: wsETH (0xAbc...) — ERC4626 vault → underlying: wstETH (0xDef...)
  Balance: 0 wstETH
  ❌  Need at least 1 USD of wstETH (underlying asset) for testing.
```

---

## Step 7: Summary Report

Print a clear summary table:

```
## Preflight Check: <TOKEN_SYMBOL> Warp Route
Deployer: <ADDRESS>

### Gas Balance Check (min 10 USD per chain)

| Chain     | Type        | Balance          | USD Value | Status |
|-----------|-------------|------------------|-----------|--------|
| ethereum  | collateral  | 0.01 ETH         | 22.00 USD | ✅ OK  |
| arbitrum  | synthetic   | 0.002 ETH        | 4.40 USD  | ⚠️ LOW |
| base      | synthetic   | 0 ETH            | 0.00 USD  | ❌ EMPTY |

### Collateral Token Check (min 1 USD for testing)

| Chain     | Token | Balance    | USD Value | Status |
|-----------|-------|------------|-----------|--------|
| ethereum  | USDC  | 5.00 USDC  | 5.00 USD  | ✅ OK  |
```

**If all balances are sufficient**, say `✅ All chains funded — ready to deploy!` and stop.

If any chain needs funding, proceed to Step 8.

---

## Step 8: Generate and Run Funding Commands

For every chain with insufficient gas or collateral, generate the exact funding commands using the deployer funding script.

**The script must be run from the `typescript/infra` directory**, and every invocation MUST be prefixed with `CI=false` (scoped to the single command — do NOT `export CI=false` globally). Without this, `getRegistryForEnvironment` on Haggis workers and other CI-flagged environments silently loads public rate-limited RPCs (e.g. Tron's trongrid.io at 3 rps → 429 during broadcasts) instead of the private GCP-stored keyed endpoints. See the CI-mode section in `[[reference-haggis-sandbox]]` for the full explanation.

```bash
cd typescript/infra
```

### Gas funding (native token — no `-t` or `-s` flag)

```bash
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient <DEPLOYER_ADDRESS> \
  --amount <AMOUNT> \
  -e mainnet3 \
  -c <CHAIN>
```

### Collateral token funding by symbol (preferred for known tokens like USDC)

```bash
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient <DEPLOYER_ADDRESS> \
  --amount <AMOUNT> \
  -e mainnet3 \
  -c <CHAIN> \
  -s <SYMBOL>
```

### Collateral token funding by contract address (for unknown/custom tokens)

```bash
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient <DEPLOYER_ADDRESS> \
  --amount <AMOUNT> \
  -e mainnet3 \
  -c <CHAIN> \
  -t <TOKEN_ADDRESS>
```

**For tokens not on CoinGecko** (new launches, testnet tokens, internal tokens): the agent should first exhaust the alternative price venues per Step 4 / Step 6 (CoinMarketCap → Binance → Uniswap on-chain quote). Only when **all** of those fail should the agent ask the user for a manual `--price <usd-per-unit>` override. Example, passing a manual price of $0.50 as a last resort:

```bash
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient <DEPLOYER_ADDRESS> \
  --amount <AMOUNT> \
  -e mainnet3 \
  -c <CHAIN> \
  -t <TOKEN_ADDRESS> \
  --price 0.5
```

The script rejects `--price 0` and any non-positive / non-finite value — the safety bound (`MAX_FUNDING_AMOUNT_IN_USD`) requires a positive price. Without `--price` (or with an invalid value), the script hard-fails when CoinGecko has no price for the token. Whenever the agent supplies a price discovered from an alternative venue (CoinMarketCap / Binance / Uniswap), it should pass that via `--price`.

**ERC4626 vaults**: use the **underlying asset address** (from `asset()`) as `<TOKEN_ADDRESS>`, not the vault token address. The deployer needs the underlying asset to test the route; the vault share is not what gets transferred during bridging tests.

### Amount calculation

For **gas**: use the formula from Step 4 — `gasPrice_wei × 30,000,000 × 2 (buffer) / 10^decimals` — to determine the required amount, then subtract what the deployer already holds. Round up to 4 decimal places. This matches exactly what the Hyperlane CLI checks before deploying.

For **collateral**: fund only the **shortfall** — the amount needed to bring the balance up to 1 USD worth. If the deployer already holds 0.20 USDC, fund 0.80 USDC (not the full 1 USDC). Do not over-fund.

Example for the USDC/Igra route with deployer `0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC`:

```bash
cd typescript/infra

# Gas — arbitrum (needs 10 USD / ETH price)
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 0.0053 -e mainnet3 -c arbitrum

# Gas — optimism
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 0.0053 -e mainnet3 -c optimism

# Gas — ethereum (top up to reach 10 USD)
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 0.0031 -e mainnet3 -c ethereum

# Gas — avalanche
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 1.24 -e mainnet3 -c avalanche

# Gas — polygon
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 118 -e mainnet3 -c polygon

# USDC collateral — 1 USDC per collateral chain
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 1 -e mainnet3 -c ethereum -s USDC
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 1 -e mainnet3 -c arbitrum -s USDC
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 1 -e mainnet3 -c base -s USDC
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 1 -e mainnet3 -c optimism -s USDC
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 1 -e mainnet3 -c avalanche -s USDC
CI=false pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0x93842986B424Fda7C9A90A7D2f88602C1c88d7dC --amount 1 -e mainnet3 -c polygon -s USDC
```

### Execution

Show the user all generated commands in a table with the USD equivalent for each transfer, e.g.:

```
| Chain     | Token | Amount     | USD Value  | Command |
|-----------|-------|------------|------------|---------|
| arbitrum  | ETH   | 0.0053     | ~10.94 USD | pnpm tsx scripts/funding/... |
| ethereum  | ETH   | 0.0031     | ~6.40 USD  | pnpm tsx scripts/funding/... |
| optimism  | ETH   | 0.0053     | ~10.94 USD | pnpm tsx scripts/funding/... |
| avalanche | AVAX  | 1.24       | ~11.05 USD | pnpm tsx scripts/funding/... |
| polygon   | POL   | 118        | ~11.02 USD | pnpm tsx scripts/funding/... |
| ethereum  | USDC  | 1          | ~1.00 USD  | pnpm tsx scripts/funding/... |
...
Total: ~XX.XX USD
```

This will transfer funds from the Hyperlane deployer key to the recipient address. End your message with this marker (this MUST be the very last thing in your message):

```test
[CONFIRM: Transfer funds from deployer key to <recipient-address> across <N> chains]
```

When running each command, print a one-line status before and after each transfer:

```
Funding arbitrum gas: 0.0053 ETH (~10.94 USD)... ✅ done (tx: 0x...)
```

If any command fails, stop and report the error — do not continue with remaining commands.

After all commands complete, re-run the balance checks from Steps 5 and 6 to confirm all chains are now funded.

---

## Next Steps

Once all chains are funded, run `/warp-deploy-init-route` to generate the deploy.yaml and start the deployment.

---

## Notes

- The required-gas value comes from two sources depending on the chain's cost model. **Gas-market chains** (EVM, and any non-EVM chain with a non-null `gasPrice` in the registry): units come from `getProtocolProvider(protocol).getMinGas().WARP_DEPLOY_GAS` — EVM's default is 30_000_000 units (conservative upper bound; typical deploys use 3–5M) — and total cost is `units × gasPrice`. **Null-gasPrice chains** (Sealevel and Tron): use the shape-aware floor tables in Step 5. The flat constants on those SDKs (`typescript/svm-sdk/src/clients/protocol.ts` → 2.6 SOL; `typescript/tron-sdk/src/clients/protocol.ts`) are calibrated for a vanilla synthetic-or-collateral router only and undercount cross-collateral + fee-program routes by a factor the flat number can't express — SVM's cost is a sum of rent-exempt reserves for each account the deploy creates; Tron's is energy + bandwidth for the additional contracts.
- The 10 USD threshold is conservative for most chains. Ethereum mainnet and Solana may need significantly more.
- The deployer only needs collateral token for **testing** a transfer after deployment. 1 USD is enough; do not request more.
- If the ticket specifies this is a **mainnet production deploy** (not test), note that the deployer may need significantly more gas than 10 USD per chain.
- The funding script pulls from the Hyperlane deployer key configured in the environment — ensure `HYP_KEY` or equivalent is set, or that the infra environment secrets are accessible.
