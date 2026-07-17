---
name: fund-key
description: Autonomously remediate a low-balance PagerDuty/Grafana alert for a Hyperlane agent key (relayer / key-funder EOA) by bridging native funds from the Turnkey funder key (TaggisFunder, arbitrum) to the underfunded address, with independent on-chain receipt verification. Use ONLY after confirming the shortfall is real (not a stale-burn false positive). The live broadcast is gated behind explicit human [CONFIRM:].
---

# Fund Key

Top up an underfunded Hyperlane agent key in response to a balance alert. The
funder signs an EVM-origin transaction from the Turnkey **TaggisFunder** key on
arbitrum and bridges/swaps native funds to the underfunded address on any
destination chain (EVM **or** alt-VM such as Tron). Rail priority: warp routes →
swaps.xyz → LiFi. Delivery is independently verified on-chain.

The funding mechanism lives in the private-agents repo:
`typescript/stableswap-rebalancer/src/funding/fundKeyLive.ts`.

## When to Use

- A `HighUrgencyRelayerBalance`, `LowUrgencyKeyFunderBalance`, or
  `LowUrgencyEngKeyFunderBalance` PagerDuty/Grafana alert has fired, AND
- You have **confirmed the shortfall is real** (see Step 0), AND
- The underfunded address is fundable via a resolvable rail.

## When NOT to Use (escalate to a human instead)

- **Stale-burn false positive** — the alert is early because `dailyRelayerBurn.json`
  is a stale high-water mark, not a real funding gap. Per
  `learning/relayer-balance-alert-stale-daily-burn`, verify true burn first. If
  runway is actually fine, fix the threshold — do NOT fund.
- **Funder itself is underfunded** — the preflight aborts with an ESCALATION
  message; a human must top up TaggisFunder. Do not attempt a partial transfer.
- **Non-EVM with a free refill source** — for non-EVM chains, first check for
  claimable IGP/ProtocolFee fees we already own (`learning/nonevm-key-funding-claim-igp`).
  Those are the preferred, free refill and avoid spending funder USDC.
- **No route resolves** for the destination chain/asset.

## Prerequisites: Credentials

The live harness needs these environment variables. Source them at run time —
never hardcode secrets.

| Env var                         | Source                                                               |
| ------------------------------- | -------------------------------------------------------------------- |
| `TURNKEY_API_PUBLIC_KEY`        | `haggis-turnkey-api-key` GCP secret → `.publicKey`                   |
| `TURNKEY_API_PRIVATE_KEY`       | `haggis-turnkey-api-key` GCP secret → `.privateKey`                  |
| `TURNKEY_ORGANIZATION_ID`       | `haggis-key-funder-env` GCP secret → `TURNKEY_ORGANIZATION_ID`       |
| `TURNKEY_FUNDER_PRIVATE_KEY_ID` | `haggis-key-funder-env` GCP secret → `TURNKEY_FUNDER_PRIVATE_KEY_ID` |
| `TURNKEY_FUNDER_ADDRESS`        | `haggis-key-funder-env` GCP secret → `TURNKEY_FUNDER_ADDRESS`        |
| `SWAPSXYZ_API_KEY`              | `mainnet3-stableswap-rebalancer-env` GCP secret                      |
| `RPC_URL_ARBITRUM`              | `mainnet3-stableswap-rebalancer-env` GCP secret (funder-chain RPC)   |

> **Setup note:** if the `haggis-key-funder-env` secret does not yet exist,
> the funder org id / key id / address must be provisioned into it before this
> skill can run unattended. That is a one-time shared-infra change requiring
> explicit confirmation.

GCP project: `abacus-labs-dev`.

## Workflow

### Step 0: Confirm the shortfall is real (MANDATORY)

Follow `learning/relayer-balance-alert-stale-daily-burn`:

- Range-query `hyperlane_wallet_balance{chain="<chain>",wallet_name="<wallet_name>"}`
  over ~14d for a clean drawdown → true daily burn.
- Compare against the threshold's implied burn. If real runway is comfortable,
  this is a stale-burn false positive → **do not fund**; propose the threshold
  fix and stop.

### Step 1: Extract alert parameters

From the PagerDuty incident (`fetch_pagerduty_incident`) `customDetails.labels`:

- `chain` → destination chain
- `wallet_address` → destination address (the key to fund)
- `wallet_name` → which key (relayer / key-funder)
- current balance + threshold from `annotations`

### Step 2: Compute the target and shortfall

Target = the chain's `DesiredRelayerBalance` (or the alerting threshold if
funding a key-funder). **Shortfall (native, in whole units) = target − current**.
This is the amount to DELIVER on the destination chain.

Pick a `--max-source-spend` cap: a bounded USDC ceiling comfortably above the
expected quote (the guardrail aborts if a re-quote drifts above it).

### Step 3: Source credentials (see Prerequisites) and run PLAN-ONLY

From the private-agents repo, run WITHOUT `--broadcast` first:

```bash
cd /workspace/sandbox/private-agents/typescript/stableswap-rebalancer
# ...export the env vars from the GCP secrets above...
npx tsx src/funding/fundKeyLive.ts \
  --dest-chain <chain> \
  --dest-address <wallet_address> \
  --shortfall <native amount to deliver> \
  --funder-chain arbitrum \
  --source-token 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  --max-source-spend <USDC cap> \
  --min-native-reserve 0.0005
```

`--source-token` is the funder's pay token (arbitrum USDC above). Omit it to pay
in native ETH. Plan-only resolves the route, applies the guardrail + funder
balance preflight, prints the plan, and exits WITHOUT signing.

If the plan reports `NO ROUTE` or preflight `ESCALATION`, stop and escalate.

### Step 4: Present the plan and gate on confirmation

Surface the resolved plan (rail, spend, deliver amount, guardrail cap, funder
balances, preflight result). Because this moves funds irreversibly, end your
message with `[CONFIRM: Broadcast key funding — <deliver> to <address> on <chain>, spending ~<quote> USDC (cap <cap>)]`
and do NOT broadcast yet.

### Step 5: Broadcast on approval

After the human approves, re-run the EXACT same command with `--broadcast`
appended. The harness re-quotes fresh calldata, re-applies the guardrail +
preflight at broadcast time, Turnkey-signs and broadcasts each tx in order,
registers alt-VM broadcasts (swaps.xyz), polls settlement, then independently
verifies the destination receipt on-chain.

### Step 6: Report

Report from the harness output:

- origin tx hash(es) and (for bridges) the destination receiving tx
- spent (source token) and delivered (native)
- **Destination receipt: VERIFIED yes/no** (on-chain balance delta ≥ guaranteed
  minimum — not the bridge's own claim)

Exit codes: `0` settled + verified, `1` failed, `2` preflight escalation,
`3` settled but receipt NOT verified (treat as needs-human-review).

## Escalation / Error Handling

| Condition                                   | Action                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Stale-burn false positive (Step 0)          | Do not fund. Propose threshold fix; stop.                                                            |
| `NO ROUTE`                                  | Escalate — no rail resolves for this chain/asset.                                                    |
| Preflight `ESCALATION` (funder underfunded) | Escalate — human must top up TaggisFunder. No tx signed.                                             |
| Non-EVM with claimable IGP/ProtocolFee      | Prefer the free refill (`learning/nonevm-key-funding-claim-igp`).                                    |
| Exit code 3 (settled, unverified)           | Report to human — funds broadcast but on-chain delta did not reach the minimum in the verify window. |

## Important Notes

- **Funder is EVM-origin (arbitrum).** The destination may be EVM or alt-VM
  (Tron proven live; other alt-VM chains depend on swaps.xyz support).
- **Broadcast is human-gated.** Per the Haggis confirmation convention,
  irreversible fund movement requires an explicit `[CONFIRM:]`. This skill does
  not auto-broadcast. (A fully autonomous no-confirm mode is possible but is a
  deliberate policy choice, not the default.)
- **Cap discipline.** Always pass a bounded `--max-source-spend`; the guardrail
  re-checks it against the freshly re-quoted route right before signing.
- All three rails (warp, LiFi, swaps.xyz) are validated live with independent
  on-chain receipt verification.
