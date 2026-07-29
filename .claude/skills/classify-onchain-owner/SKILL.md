---
name: classify-onchain-owner
description: The low-level on-chain probes for identifying what an owner address is — cast code → EOA / EIP-7702-delegated EOA / contract, VERSION() → Gnosis Safe, hyperlane ica deploy → ICA derivation, getAccountInfo → Sealevel account existence — with how to interpret each result. The primitive layer beneath validate-owners / resolve-artifacts / update-owners, which each apply their own per-chain or per-artifact policy on top.
---

# Classify On-Chain Owner (primitive probes)

These are the raw probes for determining what an owner address IS on chain. A caller runs the relevant probe, interprets the result per the tables below, then applies its OWN policy (reject EOA, ask-the-user for non-Safe, existence-only sanity check, controller classification, etc.). This skill supplies the primitives and their interpretation only — it does not decide policy.

## EVM / Tron — code probe (EOA vs EIP-7702 vs contract)

`cast code <address> --rpc-url <rpc>` (or the multiProvider equivalent):

| Result                                                                       | Meaning                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `0x` (no code)                                                               | **Plain EOA.**                                                                                         |
| `0xef0100<20-byte-delegate>` — 46 chars, matches `^0xef0100[0-9a-fA-F]{40}$` | **EIP-7702-delegated EOA.** Still has a private key behind it; treat as an EOA for ownership purposes. |
| any other bytecode                                                           | **Contract** (Safe / ICA / timelock / custom multisig / …) — probe further.                            |

## EVM — Safe probe

`cast call <address> "VERSION()(string)" --rpc-url <rpc>`:

| Result                            | Meaning                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| a version string (e.g. `"1.3.0"`) | **Gnosis Safe** — record the version.                            |
| reverts / no return               | Not a Safe — some other contract; probe further or ask the user. |

## EVM — ICA derivation

`pnpm --silent -C typescript/cli hyperlane ica deploy --origin <origin> --chains <chain> --owner <controlling-owner> …` (key flag per `/warp-key-value-expansion`). The call is idempotent — it derives the deterministic ICA address for `(origin, controlling-owner)` and only deploys if the caller's command shape requests it:

| Result                                | Meaning                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| derived address == the on-chain owner | The owner is an **ICA** controlled by `<controlling-owner>` on `<origin>`. Classify the controller by re-running the code + Safe probes on it. |
| derived address != the owner          | Not an ICA from that origin/controller — try another origin/controller, or ask the user.                                                       |

## Sealevel — account existence

`getAccountInfo(<pubkey>)` via the SVM SDK provider:

| Result   | Meaning                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------- |
| null     | Address has **never had state** on this chain (transferring ownership here would brick the route). |
| non-null | Account **exists** (may be executable / PDA / plain wallet).                                       |

## Open-set note

Contract-but-not-a-Safe is NOT automatically an ICA. These probes cover only the cheap cases (EOA via code, Safe via `VERSION()`, ICA via a known origin/controller derivation). Everything else — Squads multisig PDA, Turnkey, Privy, MPC, custom multisig, timelock — the caller must resolve with the user; never guess.

## Consumers

`/warp-deploy-validate-owners` (per-chain classify + reject-EOA policy), `/warp-update-resolve-artifacts` (per-artifact classify + governance-map shortcut + open-set + controller classification), `/warp-deploy-update-owners` (target-owner existence sanity check).
