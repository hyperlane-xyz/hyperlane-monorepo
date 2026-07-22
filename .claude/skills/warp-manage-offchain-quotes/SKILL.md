---
name: warp-manage-offchain-quotes
description: Create and read offchain-signed standing warp fee quotes on a deployed warp route, on both EVM and SVM chains. Use when asked to set, submit, update, or inspect standing (reusable, on-chain-expiring) offchain fee quotes for a warp route via the hyperlane warp quote command. One secp256k1 signer key works across EVM and SVM.
---

# Manage Offchain-Signed Warp Fee Quotes

Create and read **standing** offchain-signed fee quotes on a deployed warp route using `hyperlane warp quote` (`typescript/cli/src/commands/warp-quote.ts`). Works on both EVM and SVM chains — the quote signature is secp256k1 ECDSA (Ethereum-style, recovers to an H160), so a **single signer key** is valid across protocols.

> This is the general-purpose quote tool. The `set-moonpay-standing-quotes` skill is a purpose-built wrapper for the CROSS/moonpay route specifically; use that one for MoonPay, this one for everything else.

## Standing vs Transient

- **Standing quote** (`--ttl > 0`): reusable until its on-chain expiry, stored on-chain. It can be signed with a wildcard recipient/amount (broadly reusable) OR with a concrete recipient/amount (scoped) — the command accepts both, so don't reach for wildcard when a concrete scope was requested. This is the only kind this command can create.
- **Transient quote** (`ttl = 0`, one-shot at submission time): **NOT usable from this standalone command.** Its storage is scoped to the create tx (EIP-1153 transient storage on EVM; on SVM an internally-generated client salt that is never returned), so it only exists inside the transfer tx that carries it. `--ttl` therefore must be `> 0` (the CLI demands it).

## Two-Key Model (critical)

There are two distinct keys, do not conflate them:

| Key              | Flag / env                                                   | Role                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quote signer** | `--quote-signer-key` or `HYP_QUOTE_SIGNER_KEY`               | 0x-hex secp256k1 private key that **signs the quote**. Its derived address MUST be in the route's `quoteSigners` allowlist (`typescript/sdk/src/fee/types.ts`) or the on-chain verification rejects the quote. |
| **Tx submitter** | `--key.<protocol>` (e.g. `--key.ethereum`, `--key.sealevel`) | Pays for and sends the on-chain submission transaction. Unrelated to signing.                                                                                                                                  |

If the signer address is not in `quoteSigners`, the submission will revert — verify membership first.

## Commands

Run from `typescript/cli`. Both require `--warp-route-id`.

### create — submit a standing quote

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp quote create \
  --registry http://localhost:<port> \
  --key.<protocol> "$SUBMITTER_KEY_VAR" \
  --quote-signer-key $HYP_QUOTE_SIGNER_KEY \
  -w <WARP_ROUTE_ID> \
  --chain <origin-chain> \
  --destination <remote-chain> \
  --recipient <wildcard | native-address> \
  --amount <wildcard | amount> \
  --max-fee <wei-or-lamports> \
  --half-amount <wei-or-lamports> \
  --ttl <seconds, > 0> \
  [--target-router <native-router-address>]
```

Flag notes:

- `--chain` = origin chain the quote is submitted on; `--destination` = the remote chain the quote applies to.
- `--recipient` / `--amount`: for a broadly reusable standing quote, use the wildcard sentinel (`WarpQuoteAmountKind.wildcard`) for both. Recipient, when concrete, is in the **destination chain's native format** (0x… EVM, base58 Solana).
  - **When unsure which recipient to use, ask the user — do not silently default to `wildcard`.** A recipient is only valid in the destination chain's native format, so a value that worked for one destination (e.g. a Solana base58 key) is invalid when the destination is a different protocol (e.g. an EVM chain). If the user's requested recipient can't apply to this destination, or they said "same params" but the address format doesn't fit, stop and confirm the intended recipient (concrete address vs. `wildcard`) before submitting.
- `--max-fee` + `--half-amount`: the raw linear fee-curve parameters (wei on EVM, lamports on SVM). If the ask is in **bps**, convert to these raw params via `bpsToRawFeeParams` (EVM uses `MaxUint256` / 10^36, SVM uses `u64` max / 10^8) rather than asking the user for raw numbers — but never invent fee economics if given neither bps nor raw values.
- `--ttl`: seconds; on-chain expiry = now + ttl. Must be `> 0`.
- `--target-router`: **cross-collateral only.** Submits against a specific router-keyed leaf, in the destination chain's native address format. Omitting it auto-resolves ONLY when the destination has a single match (the one router-keyed leaf if exactly one matches, else the `DEFAULT` leaf); if MORE than one router-keyed leaf matches the destination, the CLI does NOT guess — it exits asking for `--target-router`, so pass the specific leaf. On SVM there is no cascade: the signed `targetRouter` must exactly match a deployed leaf, so only target a router that actually exists (else drop the flag to hit `DEFAULT`). Don't set it for single-collateral routes.

### read — inspect standing quotes

```bash
cd <MONOREPO_ROOT>/typescript/cli && pnpm hyperlane warp quote read \
  --registry http://localhost:<port> \
  -w <WARP_ROUTE_ID> \
  [--chain <chain>] \
  [--recipients <native-addr> --recipients <native-addr> ...] \
  [--out <file.yaml>]
```

- Read-only, no keys.
- `--chain` scopes to one chain (defaults to all chains in the route).
- `--recipients`: extra recipient addresses to **probe** on protocols whose standing-quote storage is **non-enumerable** (EVM — you must know the recipient to look it up). Ignored on protocols that enumerate on-chain (SVM lists them for you). Accepts native format per chain (0x… / base58); the CLI auto-detects protocol and converts to bytes32, skipping anything that isn't a valid address.

## Execution Flow

1. **Verify the signer is allowlisted.** Derive the address from the quote signer key and confirm it appears in the route's `quoteSigners`. If not, stop — the quote would be rejected on-chain.
2. **Start the HTTP registry** per `/start-http-registry` — add `--writeMode` for `create` (it writes the quote on-chain); `read` needs no `--writeMode`. Note the port + task ID.
3. **For create:** first `read` the current standing quotes for the lane so you can show old→new. **Confirm the recipient is valid for the destination protocol; if it's ambiguous or a format mismatch, ask the user before submitting rather than defaulting to `wildcard`.** Then run `create`. Summarize the lane (origin→destination, recipient/amount scope, maxFee/halfAmount, TTL) in plain language before the raw output.
4. **For read:** run and show output directly (no confirmation — read-only). On EVM, remember concrete recipients must be supplied via `--recipients` to be visible.
5. **Stop the HTTP registry** per `/stop-http-registry`, even on failure.

## Caveats

- **One signer key, all protocols.** Because verification recovers an H160 from a secp256k1 signature, the same `--quote-signer-key` works for EVM and SVM. The address just has to be in `quoteSigners`.
- **Signer ≠ submitter.** `--quote-signer-key` signs; `--key.<protocol>` pays. Supplying only one of them is a common mistake.
- **`--ttl` must be > 0.** Transient (ttl=0) quotes cannot be created from this command — they only live inside a transfer tx.
- **`--target-router` is cross-collateral only** and expects the destination chain's native router address; leave it off otherwise and rely on auto-resolution.
- **EVM reads need `--recipients`** for concrete (non-wildcard) recipients since EVM storage isn't enumerable; SVM reads enumerate on-chain.
- For the CROSS/moonpay route specifically, prefer `/set-moonpay-standing-quotes`.
