---
name: warp-deploy-validate-owners
description: Ownership-validation preflight for a warp route. For each chain in the route, determine the owner type (ICA / Safe / Squads / other multisig), confirm it exists on chain (or deploy if missing for ICAs), and reject EOAs. Run before /warp-deploy-init-route generates the deploy.yaml so the deployment never proceeds against an invalid owner set.
---

# Warp Route Deploy — Validate Owners

You are running the ownership-validation preflight for a warp route. For each chain in the route, you confirm that the configured owner is a valid multisig (ICA, Safe, Squads, or other) that exists on chain. EOAs are rejected outright.

## Input

The user provides:

- **Linear ticket URL or ID** (required, e.g. `AW-652`) — the structured `Multisig for Ownership` table in the ticket is the source of truth for owner addresses + types.

If the ticket is not provided, ask for it.

If the user provides explicit per-chain owner addresses (overriding the ticket), use those.

### Key Context (Prerequisite)

Before running Step 3a (`hyperlane ica deploy`), this skill needs a deployer key with permission to sign on the origin chain (typically `ethereum`). It auto-loads `~/.hyperlane/key-contexts/<ticket-id>.yaml` produced by `/warp-deploy-select-keys`. If the artifact does not exist, invoke `/warp-deploy-select-keys <ticket-id>` first. Read `keys.ethereum.name`, `keys.ethereum.source`, and `keys.ethereum.address` from the artifact — see `/warp-key-value-expansion` for how to substitute these into the `--key.<protocol>` flag based on `source`.

---

## Step 1: Fetch the Linear Ticket

Use the Linear MCP `get_issue` tool to fetch the ticket and read the `Multisig for Ownership` table. For each chain row, extract:

- Chain name
- Owner address
- Owner-type checkboxes: `ICA controlling account` / `ICA deployment needed` / `ICA exists` (or none — implies Safe / Squads / other)

For tickets where the table is sparse or unclear, ask the user to confirm owner type per chain before proceeding.

---

## Step 2: Classify Each Chain's Owner Type

For each chain, classify the owner as one of:

| Type               | How to detect                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **ICA**            | One of the `ICA controlling account` / `ICA exists` / `ICA deployment needed` checkboxes is set on the Linear row             |
| **Safe (EVM)**     | No ICA checkbox; address is an EVM address; ticket implies Safe ownership (e.g. an AW Safe / Foundation Safe / customer Safe) |
| **Squads (SVM)**   | No ICA checkbox; address is a Solana base58 pubkey; ticket implies Squads multisig                                            |
| **Other multisig** | Anything not matching the above (e.g. custom multisig dashboard)                                                              |

Show the user the classification table and ask for confirmation if anything is ambiguous.

---

## Step 3: Per-chain validation

For each chain, run the validation appropriate to its owner type.

### 3a. ICA — `hyperlane ica deploy` (idempotent exists-or-deploys)

For chains where the owner is an ICA controlled by an origin Safe (typically `ethereum`):

```bash
pnpm --silent -C typescript/cli hyperlane ica deploy \
  --registry <local-registry-path-or-http-url> \
  --origin <origin-chain> \
  --chains <chain> \
  --owner <owner-address-on-origin> \
  --key.ethereum <KEY_ETHEREUM_VALUE>
```

**Key flag is required.** `ica deploy` is a sign command (it submits an `enrollRemoteRouter` tx on the origin chain). Read `keys.ethereum.name` and `keys.ethereum.source` from the key-context artifact and expand `<KEY_ETHEREUM_VALUE>` per the canonical legend in `/warp-key-value-expansion` — which also carries the mandatory `pnpm --silent` rule and the requirement to display the resolved key name + derived address before the `[CONFIRM:]` gate. Never combine `--key` (legacy) with `--key.<protocol>`. Before running, end your message with a `[CONFIRM:]` marker because deploying ICAs is destructive (spends gas + creates contracts).

```test
[CONFIRM: Deploy ICA on <chain> from <origin> owner <owner>]
```

- The command derives the ICA address deterministically from `(origin chain ID, owner, ICA router, ISM)`.
- If the ICA already exists at the deterministic address, the command logs `exists` and exits without deploying. This is the canonical existence check.
- If the ICA doesn't exist and `--deploy` is implied by the command shape, the command deploys it. (For Phase A: we want existence-or-deploy in one call; ICA deployment is permissionless and cheap.)
- Capture the deterministic ICA address from the output and confirm it matches the ticket's address. If they differ, **stop** — there's a derivation mismatch (probably wrong origin chain or wrong Safe address in the ticket).

**On any failure** (e.g. ICA router missing in the registry, RPC error): stop, surface the error, do not proceed downstream.

### 3b. Safe (EVM) — on-chain code + interface check

For chains where the owner is a Gnosis Safe directly (not via ICA):

```bash
cast call <safe-address> "VERSION()(string)" --rpc-url <chain-rpc-url>
```

- A valid Gnosis Safe returns a version string (e.g. `"1.3.0"`). If the call succeeds and returns a version, the Safe is valid.
- If the call reverts or returns empty, the address either has no code (an EOA — see 3d) or is some other contract. **Stop and surface to the user.**

Get the RPC URL from the local registry: `cat $REGISTRY_PATH/chains/<chain>/metadata.yaml | grep -A2 rpcUrls`.

### 3c. Squads (SVM) — multisig PDA + Squads layout check

For chains where the owner is a Squads multisig:

- Phase A: surface this as a **`Squads validation TODO — Phase 2`** warning row for now. EVM routes that touch SVM via Squads owners still proceed (the EVM-side validation passes); the SVM-side Squads validation requires per-protocol skill work that lands in Phase 2.
- For Phase 2 (future): use the SVM SDK to read the multisig PDA on Solana and confirm the Squads V4 layout. If invalid, reject.

### 3d. Reject if EOA (including EIP-7702 delegations), with ticket-labeled non-prod exceptions

If a chain's owner is an EVM address, run `cast code <address> --rpc-url <rpc>` (or the per-protocol equivalent — SVM `getAccountInfo`, Tron `wallet_getAccount`, etc.) and check whether the result indicates an EOA. Two EVM EOA shapes to catch:

1. **Plain EOA** — `cast code` returns `0x` (no code). Classic externally-owned account.
2. **EIP-7702-delegated EOA** — `cast code` returns `0xef0100<20-byte-delegate-address>` (46 chars total, starts with `0xef0100`). Post-EIP-7702 EOAs that have delegated to a smart account contract still have a private key behind them and remain EOAs for ownership purposes. Detect by checking that the code matches the regex `^0xef0100[0-9a-fA-F]{40}$`.

**Ticket-label check (do this FIRST).** Fetch the ticket title + description (already loaded from the Linear MCP earlier in the skill). Classify the deploy mode by scanning for a non-prod label:

- Ticket title starts with `[STAGING]`, `[TEST]`, or `[NON-PROD]` → **non-prod mode**
- Ticket description explicitly marks the route as staging / test / non-production (e.g. "staging test", "haggis test run", "not for production") → **non-prod mode**
- Otherwise → **production mode**

Then apply the EOA policy per mode:

| Mode           | EOA owner detection outcome                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| **production** | Hard reject. Halt the flow with the error message below.                                                |
| **non-prod**   | Classify as `⚠️ NON-PROD EOA` and continue. Downstream skills accept the ⚠️ classification and proceed. |

Under **production mode**, the halt message includes:

- Which chain
- Which address
- Whether it's a plain EOA or an EIP-7702-delegated EOA
- Why this is rejected (EOAs are never valid as long-term production owners — even delegated ones can be drained by the EOA private key holder)
- What the operator should do (replace with a Safe / ICA / Squads / other multisig / timelock address; update the Linear ticket; rerun)

Under **non-prod mode**, surface a warning with:

- Which chain
- Which address
- Whether it matches the deployer's own address (`keys.<protocol>.address` in the key-context artifact) or a different EOA
- A reminder that this route MUST NOT be treated as production; if it graduates to prod later, ownership needs transfer to a real multisig

Apply the mode uniformly across protocols. The label parse is the single source of truth — don't second-guess it per chain.

The intent: production routes always require multisig / contract owners (the hard-reject prevents an accidental EOA slip). Non-prod routes explicitly acknowledged by the operator via the ticket label can proceed with EOA owners — typical for Haggis test runs, integration tests, and Sebastiano's manual staging deploys. The label parse is deliberate friction on the operator's part (they have to label the ticket) and creates an audit trail.

### 3e. Confirm address format per protocol

For every chain, also confirm the address format matches the protocol:

- **EVM**: 20-byte hex starting with `0x`, length 42 chars
- **SVM**: base58 32-byte (typically 32-44 char base58)
- **Tron**: base58 starting with `T` OR EVM hex `0x` (Tron contracts in `deploy.yaml` use the hex form per `warp-update-extend` conventions — convert if needed)
- **Cosmos**: bech32 with chain-specific prefix

A format mismatch is a stop condition — surface to the user.

---

## Step 4: Emit Resolution Report

Output a per-chain resolution table summarizing the validation:

```
Deploy mode: non-prod (ticket labeled [STAGING])

Chain         | Owner Type   | Address                                       | Status             | Notes
ethereum      | Safe         | 0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6    | ✅ VALID            | AW Safe; VERSION() = "1.3.0"
arbitrum      | ICA          | 0xD2757B…1A45                                 | ✅ EXISTS           | derived from ethereum Safe
solanamainnet | Squads       | BNGDJ1h…URwJ                                  | ⚠️ TODO             | Phase 2 Squads validation pending
mode          | EOA          | 0x3f13C1…0913                                 | ⚠️ NON-PROD EOA     | ticket [STAGING] label allows EOA; matches user's own EOA
bsc           | EOA          | 0x3f13C1…0913                                 | ⚠️ NON-PROD EOA     | ticket [STAGING] label allows EOA
```

The first line of the resolution table always states the resolved deploy mode + which label triggered it (or "production — no non-prod label detected"). Downstream skills read this to decide their own behavior.

If any row is ❌, **stop** — surface the rejections to the user. Do not proceed to `/warp-deploy-init-route` until every row is ✅ or ⚠️.

If every row is ✅ or ⚠️ (TODO / NON-PROD EOA), the route is cleared for the downstream `init-route` step. Persist the deploy mode + per-chain classifications to the resolution artifact so downstream skills can adjust their behavior (e.g. init-route / update-owners CONFIRM policy under non-prod mode).

---

## Step 5: Next

Tell the user:

> **Ownership validation complete.** Resolved owners per chain are in the table above. If all chains are ✅ (or ⚠️ Phase-2-TODO), proceed to `/warp-deploy-init-route` with the same Linear ticket. The init-route skill will use the same owner addresses as the deploy targets.

---

## Notes

- This skill is read-only on the chain side (except for the idempotent `hyperlane ica deploy` which exists-or-deploys ICAs; deploying an ICA is permissionless and cheap and the right thing to do as part of a preflight).
- Run this skill **before** `/warp-deploy-init-route`, not after. Catching an EOA before deploy saves redoing the deploy.yaml + a wasted deploy.
- For updates (not new deployments), use a different validation flow — the update checklist's per-artifact owner enumeration is per-artifact, not per-chain. This skill is deployment-scope only for Phase A.
