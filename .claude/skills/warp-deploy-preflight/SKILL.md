---
name: warp-deploy-preflight
description: Pre-flight gas and balance check before deploying a warp route. Reads a Linear ticket, checks deployer wallet native gas balances per chain (warn if <$10), and checks collateral token balance (need ~$1 for testing).
---

# Warp Route Deploy Preflight Check

You are checking whether a deployer wallet has sufficient funds (gas + collateral tokens) before deploying a new warp route.

## Input

The user provides:

- **Linear ticket URL or ID** (required, e.g. `ENG-3516`)
- **Deployer address** (required, e.g. `0xabc...`)

If either is missing, ask for them before proceeding.

---

## Step 1: Fetch the Linear Ticket

Extract the issue ID from the URL or input (e.g. `ENG-3516`).

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ issue(id: \"<ISSUE_ID>\") { title description } }"}'
```

**If `LINEAR_API_KEY` is not set or returns 401:** Stop and tell the user:

> `LINEAR_API_KEY` is not set or invalid. Please export it: `export LINEAR_API_KEY=<your-key>` and restart Claude Code.

Show the ticket title and description to the user before proceeding.

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
REGISTRY_PATH="${HYPERLANE_REGISTRY:-$(dirname $(pwd))/../hyperlane-registry}"
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

If CoinGecko fails, fall back to 0 USD — still fund based on the gas price calculation, just omit the USD column.

**⚠️ Warning threshold**: If the required amount (with buffer) exceeds **10 USD**, warn the user explicitly before running funding commands. This is a signal that gas is unusually expensive on that chain right now.

---

## Step 5: Check Deployer Native Gas Balance Per Chain

For each chain in the warp route, check the deployer's native token balance:

```bash
cast balance <DEPLOYER_ADDRESS> --rpc-url <RPC_URL> --ether
```

Compare against `required_with_buffer` from Step 4.

For each chain, report one of:

- ✅ **OK** — balance >= required (with buffer)
- ⚠️ **LOW** — balance > 0 but < required (warn + include in funding)
- ❌ **EMPTY** — balance = 0 (critical + include in funding)

When reporting, always show both the native amount and USD value:

```
Chain: ethereum
  Gas price: 0.13 gwei → requires 0.0078 ETH (2x buffer) = ~16.09 USD
  Balance:   0.002 ETH (~4.13 USD)
  ⚠️  SHORT: fund 0.006 ETH (~12.38 USD more)
  ⚠️  WARNING: >10 USD needed — gas is currently elevated on ethereum
```

**Note for Solana (Sealevel)**: `cast balance` and `eth_gasPrice` do not apply. Solana requires ~2.5 SOL for rent on new deployments (~500 USD+). Warn the user to fund manually if Solana is in the route.

---

## Step 6: Check Collateral Token Balance (If Applicable)

For each **collateral chain**, check if the deployer holds the collateral token. For testing, 1 USD worth is sufficient.

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

For well-known tokens, use these approximate prices if CoinGecko fails:

- USDC / USDT / DAI: $1.00
- WETH: same as ETH price
- WBTC: check ETH price × ~15 (rough ratio, not reliable — prefer API)

**Threshold: 1 USD worth of collateral token**

Report:

- ✅ **OK** — holds >= 1 USD of collateral token
- ⚠️ **LOW** — holds > 0 but < 1 USD (may be enough if price is just unavailable)
- ❌ **NONE** — zero balance — must acquire some collateral token for testing

When insufficient:

```
Chain: ethereum (collateral)
  Token: USDC (0xA0b8...)
  Balance: 0 USDC
  ❌  Need at least 1 USD of USDC for testing. Request from faucet or transfer a small amount.
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

**The script must be run from the `typescript/infra` directory:**

```bash
cd typescript/infra
```

### Gas funding (native token — no `-t` or `-s` flag)

```bash
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient <DEPLOYER_ADDRESS> \
  --amount <AMOUNT> \
  -e mainnet3 \
  -c <CHAIN>
```

### Collateral token funding by symbol (preferred for known tokens like USDC)

```bash
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient <DEPLOYER_ADDRESS> \
  --amount <AMOUNT> \
  -e mainnet3 \
  -c <CHAIN> \
  -s <SYMBOL>
```

### Collateral token funding by contract address (for unknown/custom tokens)

```bash
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient <DEPLOYER_ADDRESS> \
  --amount <AMOUNT> \
  -e mainnet3 \
  -c <CHAIN> \
  -t <TOKEN_ADDRESS>
```

### Amount calculation

For **gas**: use the formula from Step 4 — `gasPrice_wei × 30,000,000 × 2 (buffer) / 10^decimals` — to determine the required amount, then subtract what the deployer already holds. Round up to 4 decimal places. This matches exactly what the Hyperlane CLI checks before deploying.

For **collateral**: fund only the **shortfall** — the amount needed to bring the balance up to 1 USD worth. If the deployer already holds 0.20 USDC, fund 0.80 USDC (not the full 1 USDC). Do not over-fund.

Example for the USDC/Igra route with deployer `0xCB527F2e62458409A2B6B71fD587FABD01b20776`:

```bash
cd typescript/infra

# Gas — arbitrum (needs 10 USD / ETH price)
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 0.0053 -e mainnet3 -c arbitrum

# Gas — optimism
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 0.0053 -e mainnet3 -c optimism

# Gas — ethereum (top up to reach 10 USD)
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 0.0031 -e mainnet3 -c ethereum

# Gas — avalanche
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 1.24 -e mainnet3 -c avalanche

# Gas — polygon
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 118 -e mainnet3 -c polygon

# USDC collateral — 1 USDC per collateral chain
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 1 -e mainnet3 -c ethereum -s USDC
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 1 -e mainnet3 -c arbitrum -s USDC
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 1 -e mainnet3 -c base -s USDC
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 1 -e mainnet3 -c optimism -s USDC
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 1 -e mainnet3 -c avalanche -s USDC
pnpm tsx scripts/funding/fund-wallet-from-deployer-key.ts \
  --recipient 0xCB527F2e62458409A2B6B71fD587FABD01b20776 --amount 1 -e mainnet3 -c polygon -s USDC
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

Then ask:

> **Ready to run these funding commands?** This will transfer funds from the Hyperlane deployer key to the recipient address. Type `yes` to proceed or `no` to skip.

When running each command, print a one-line status before and after each transfer:

```
Funding arbitrum gas: 0.0053 ETH (~10.94 USD)... ✅ done (tx: 0x...)
```

If any command fails, stop and report the error — do not continue with remaining commands.

After all commands complete, re-run the balance checks from Steps 5 and 6 to confirm all chains are now funded.

---

## Notes

- Gas estimates assume typical EVM warp route deployment (~3–5M gas units). Actual cost depends on gas price at deploy time.
- The 10 USD threshold is conservative for most chains. Ethereum mainnet and Solana may need significantly more.
- For Solana (Sealevel), `cast balance` does not work — use `solana balance <ADDRESS>` if the Solana CLI is available, otherwise skip and warn the user to check manually.
- The deployer only needs collateral token for **testing** a transfer after deployment. 1 USD is enough; do not request more.
- If the ticket specifies this is a **mainnet production deploy** (not test), note that the deployer may need significantly more gas than 10 USD per chain.
- The funding script pulls from the Hyperlane deployer key configured in the environment — ensure `HYP_KEY` or equivalent is set, or that the infra environment secrets are accessible.
