---
name: fund-key
description: Autonomously remediate a low-balance PagerDuty/Grafana alert for a Hyperlane agent key (relayer / key-funder EOA) by bridging native funds from the Turnkey funder key (TaggisFunder, arbitrum) to the underfunded address, with independent on-chain receipt verification. Use ONLY after confirming the shortfall is real (not a stale-burn false positive). Broadcasts autonomously within a bounded source-spend cap; escalates instead of broadcasting on any guardrail failure.
---

# Fund Key

Top up an underfunded Hyperlane agent key in response to a balance alert. The
funder signs an EVM-origin transaction from the Turnkey **TaggisFunder** key on
arbitrum and bridges/swaps native funds to the underfunded address. Executable
destinations are **EVM chains and Tron ONLY** — the harness's receipt verifier
(`buildReceiptVerifier` in `fundKeyLive.ts`) reads native balance for
`ProtocolType.Ethereum` and `ProtocolType.Tron` and throws for any other VM
(Solana, Starknet, Cosmos, …). A run targeting an unsupported VM resolves a
route and then fails at the pre-broadcast baseline read, so for those
destinations escalate to the manual non-EVM refill path
(`learning/nonevm-key-funding-claim-igp`) instead. Rail priority: warp routes →
swaps.xyz → LiFi. Delivery is independently verified on-chain.

**Autonomous by default.** Once the shortfall is confirmed real (Step 0) and a
route resolves within the `--max-source-spend` cap, this skill broadcasts
WITHOUT a human confirmation gate. The safety envelope is the bounded spend cap,
the funder-balance preflight, and the automated escalation conditions below — a
guardrail failure escalates to a human instead of broadcasting. This full-auto
policy is a deliberate decision by Nam (2026-07-17); the cap + preflight +
receipt verification are what keep it safe.

The funding mechanism lives in the private-agents repo:
`typescript/key-funder/src/funding/fundKeyLive.ts`.

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
- **ATA-payer alert** — `wallet_name` matches `*/ata-payer` (the Solana / Eclipse
  / SOON / SonicSVM ATA-payer series in `alert-query-templates.ts`). These are
  SVM accounts with their own small per-route thresholds, NOT a
  `DesiredRelayerBalance`, and are non-EVM (unsupported by the EVM/Tron receipt
  verifier). Do NOT treat one as a relayer and compute a relayer-style target;
  escalate to the manual non-EVM refill path (`learning/nonevm-key-funding-claim-igp`).
- **Destination VM is not EVM or Tron** — the receipt verifier only supports
  those two; escalate rather than resolving a route that will fail before signing.
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

> **Setup note:** the `haggis-key-funder-env` secret holds the funder org id /
> key id / address. It must exist before this skill can run unattended. The
> `haggis@abacus-labs-dev` service account can READ secrets but cannot CREATE
> them, so first-time provisioning requires a human with
> `secretmanager.secrets.create` (or an IAM grant to the SA).

GCP project: `abacus-labs-dev`.

## Workflow

### Step 0: Confirm the shortfall is real (MANDATORY)

Follow `learning/relayer-balance-alert-stale-daily-burn`:

- Range-query the EXACT alerting series. The alert groups by
  `min by (chain, wallet_address, wallet_name)`, so pin all three plus
  `hyperlane_context` — a query that omits `wallet_address`/context can return a
  different relayer or context and classify the shortfall from the wrong
  drawdown before an irreversible transfer:
  `hyperlane_wallet_balance{chain="<chain>",wallet_address="<wallet_address>",wallet_name="<wallet_name>",hyperlane_context="<context>"}`
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

First confirm `wallet_name` is a relayer or key-funder — if it matches
`*/ata-payer`, STOP and escalate (see "When NOT to Use"; ATA payers have their
own small per-route threshold in `alert-query-templates.ts`, not a
`DesiredRelayerBalance`).

Target = the chain's `DesiredRelayerBalance` (or the alerting threshold if
funding a key-funder). **Shortfall (native, in whole units) = target − current**.
This is the amount to DELIVER on the destination chain.

Pick a `--max-source-spend` cap: a bounded USDC ceiling comfortably above the
expected quote (the guardrail aborts if a re-quote drifts above it).

### Step 3: Source credentials (see Prerequisites) and run PLAN-ONLY

From the private-agents repo, run WITHOUT `--broadcast` first:

```bash
cd /workspace/sandbox/private-agents/typescript/key-funder
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

### Step 4: Confirm the plan is inside the safety envelope

Surface the resolved plan (rail, spend, deliver amount, guardrail cap, funder
balances, preflight result). Then verify the automated envelope before
broadcasting:

- Plan-only exited `0` (route resolved, guardrail + funder preflight passed).
  Note: in plan-only mode `0` means "plan resolved, NOTHING signed" — it is NOT
  a delivery success. (`2` = preflight escalation can also occur here.)
- The re-quote is comfortably under `--max-source-spend`.
- No escalation condition from the table below is triggered.

If any of these fails, **escalate to a human — do NOT broadcast**. Otherwise
proceed directly to Step 5 (no `[CONFIRM:]` gate).

### Step 5: Broadcast autonomously

Re-run the EXACT same command with `--broadcast` appended. The harness re-quotes
fresh calldata, re-applies the guardrail + preflight at broadcast time (aborting
if the fresh quote exceeds the cap), Turnkey-signs and broadcasts each tx in
order, registers alt-VM broadcasts (swaps.xyz), polls settlement, then
independently verifies the destination receipt on-chain.

### Step 6: Report

Report from the harness output:

- origin tx hash(es) and (for bridges) the destination receiving tx
- spent (source token) and delivered (native)
- **Destination receipt: VERIFIED yes/no** (on-chain balance delta ≥ guaranteed
  minimum — not the bridge's own claim)

Exit codes (broadcast mode): `0` settled + verified, `1` failed, `2` preflight
escalation, `3` settled but receipt NOT verified (treat as needs-human-review).
**In plan-only mode (no `--broadcast`) exit `0` means the plan resolved and
NOTHING was signed or delivered** — never report a plan-only `0` as successful
funding.

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
- **Broadcast is autonomous (no `[CONFIRM:]`).** Per Nam's deliberate policy
  decision (2026-07-17), this skill broadcasts without a human confirmation gate
  once Step 0 confirms the shortfall is real and the plan clears the safety
  envelope. The human-in-the-loop is replaced by the bounded `--max-source-spend`
  cap, the funder-balance preflight, and the escalation table — any guardrail
  failure escalates instead of broadcasting. Revisit this policy if the funder's
  blast radius grows.
- **Cap discipline.** Always pass a bounded `--max-source-spend`; the guardrail
  re-checks it against the freshly re-quoted route right before signing.
- All three rails (warp, LiFi, swaps.xyz) are validated live with independent
  on-chain receipt verification.
