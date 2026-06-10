---
name: warp-deploy-select-keys
description: Preflight that resolves which private key(s) to use for the warp-deploy chain across every protocol in the route (EVM / Sealevel / Cosmos / Starknet / Tron). Either accepts a user-supplied key spec per protocol or enumerates candidate GCP secret names — never values — and asks the user to pick. Persists the resolution as a key-context artifact at `~/.hyperlane/key-contexts/<ticket-id>.yaml` that downstream warp-deploy skills auto-load.
---

# Warp Route Deploy — Select Keys

You are resolving which private key(s) the warp-deploy chain should use for signing across every protocol in the route. Run this BEFORE any of `/warp-deploy-fund-deployer`, `/warp-deploy-validate-owners`, `/warp-deploy-init-route`, `/warp-deploy-update-owners`, `/warp-deploy-extend-route` — or have those skills invoke this one when the artifact is missing.

A single route can span multiple protocols (e.g., `ethereum` + `sealevel` + `cosmos`) — each needs its own key. This skill walks every required protocol and resolves them in one pass.

## Input

The user provides:

- **Linear ticket ID** (required, e.g. `AW-680`) — namespaces the resolved key-context artifact.
- **Key spec(s)** (optional, per protocol) — any of:
  - GCP secret name (e.g. `hyp-mainnet-deployer-test`, `hyp-svm-deployer`, `hyp-cosmos-signer`)
  - Environment variable name (e.g. `HYP_KEY`, `HYP_KEY_SVM`)
  - Keystore file path

The user may supply specs for some protocols and leave others unspecified — the skill enumerates GCP candidates only for the protocols still missing.

---

## Step 1: Enumerate Required Protocols

Read the Linear ticket's connected chains and map each to its protocol. The protocol determines both the candidate-secret naming convention and the address-derivation command in Step 5.

| Protocol   | Chain examples                                                      | CLI flag         |
| ---------- | ------------------------------------------------------------------- | ---------------- |
| `ethereum` | EVM: ethereum, arbitrum, base, optimism, polygon, avalanche, bsc, … | `--key.ethereum` |
| `sealevel` | solanamainnet, eclipsemainnet                                       | `--key.sealevel` |
| `cosmos`   | neutron, osmosis, kyve, dydx, …                                     | `--key.cosmos`   |
| `starknet` | starknet                                                            | `--key.starknet` |
| `tron`     | tron                                                                | `--key.tron`     |

You need ONE key per unique protocol that appears in the route. A pure-EVM route (e.g. base ↔ arbitrum) needs only `ethereum`. A cross-VM route (e.g. ethereum + solanamainnet + neutron) needs `ethereum` + `sealevel` + `cosmos` — three keys, resolved in this skill in one pass.

Show the user the protocol set and confirm before proceeding to enumeration / verification.

---

## Step 2: Reuse Existing Artifact (if present)

Check whether `~/.hyperlane/key-contexts/<ticket-id>.yaml` already exists.

- **If yes**: show the user the existing resolution per protocol. Ask whether to **reuse** (skip to Step 7) or **re-resolve from scratch** (proceed to Step 3 and overwrite). End your message with:

  ```test
  [CONFIRM: Reuse existing key-context for <ticket-id>]
  ```

- **If a previous resolution exists but is missing some protocols** (e.g. the route was extended to a new VM since the last resolution), reuse the resolved protocols and re-resolve only the missing ones. Surface this clearly.

> **Note:** `[CONFIRM: ...]` is a Haggis-specific harness primitive — Haggis renders it as an inline approve/reject button. In other Claude Code contexts it is just text.

---

## Step 3: Per-Protocol Loop

For each required protocol in Step 1, run Steps 4–5. Within a single skill invocation, resolve every protocol before persisting to disk in Step 6. Do not partial-write the artifact mid-loop — if any protocol's resolution stalls (user pick required, derivation fails), park that protocol and continue with the others, then come back. Persist only when all required protocols are resolved.

---

## Step 4: Resolve the Key for the Current Protocol

### 4a: Detect a Pre-Supplied Key Spec

If the user has already told you (in the conversation context or via the parent skill's input) which key to use for THIS protocol, skip to Step 5 (Verify + Derive) for this protocol. Otherwise, proceed to GCP enumeration.

### 4b: Check gcloud Project Context

```bash
gcloud config get-value project
```

If the output is empty, halt and tell the user:

> The active gcloud project is not set. Run `gcloud config set project <project-id>` and retry, or supply a key spec directly (GCP secret name, env var, or keystore path).

### 4c: List Candidate Secret Names (per protocol)

Use a broad name filter with protocol-specific term hints. Names are listed; values are NEVER read during enumeration.

| Protocol   | Filter                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `ethereum` | `--filter="(name:deployer OR name:signer OR name:evm) AND name:key"`                                      |
| `sealevel` | `--filter="(name:sealevel OR name:solana OR name:svm) AND (name:deployer OR name:signer OR name:key)"`    |
| `cosmos`   | `--filter="(name:cosmos OR name:neutron OR name:osmosis) AND (name:deployer OR name:signer OR name:key)"` |
| `starknet` | `--filter="name:starknet AND (name:deployer OR name:signer OR name:key)"`                                 |
| `tron`     | `--filter="name:tron AND (name:deployer OR name:signer OR name:key)"`                                     |

Run:

```bash
gcloud secrets list \
  --filter="<protocol-specific filter from table above>" \
  --format="value(name)"
```

If the filter returns nothing for a protocol, fall back to a broader query:

```bash
gcloud secrets list --filter="name:key" --format="value(name)"
```

…and tell the user the narrow filter returned no results so you're showing all key-named secrets. The user picks; the agent must NOT pre-pick by name heuristic (e.g. "the one with `test` in the name" is exactly the foot-gun this skill exists to close).

### 4d: Present Candidates and Ask the User to Pick

Show the full candidate list per protocol. End your message with a `[CONFIRM:]` marker:

```test
[CONFIRM: Use <secret-name> as the <protocol> deployer key]
```

If the user supplies a name not in the candidate list (a secret the filter missed, or a non-GCP key spec — env var or keystore path), accept it and proceed.

---

## Step 5: Verify Access + Derive Address (per protocol)

### 5a: Verify Access (don't echo the value)

```bash
gcloud secrets versions access latest --secret=<name> > /dev/null && echo ok
```

If this fails, surface the error and stop the loop for this protocol. Common causes:

- Wrong secret name (typo)
- Insufficient IAM permission (the calling identity needs `roles/secretmanager.secretAccessor`)
- Project context mismatch

### 5b: Derive the Signer Address

The private key value is consumed inside subprocess invocations and never printed — only the derived address is echoed.

#### Source-agnostic key-value pattern

The derivation commands below take `<KEY_VALUE>` — substitute it from the `source` field per the legend (same legend downstream skills use):

| `source` field | Expansion of `<KEY_VALUE>`                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gcp-secret`   | `"$(gcloud secrets versions access latest --secret=<name>)"`                                                                                                                                          |
| `env-var`      | `"$<name>"` (env var must be exported in the shell session)                                                                                                                                           |
| `keystore`     | `"$(cat <path>)"` for plaintext-key files; for encrypted keystores, halt with a clear error and ask the user to supply the derived address directly — encrypted-keystore unlocking is Phase 2 wiring. |

#### `ethereum` (EVM)

```bash
cast wallet address <KEY_VALUE>
# → 0xabc...
```

#### `sealevel` (Solana / Eclipse)

Hyperlane SVM keys are typically base58-encoded ed25519 secret keys. The derivation pipes `<KEY_VALUE>` into a Python one-liner (substitute the expansion of `<KEY_VALUE>` inline; the value lives only in the pipe, never in conversation logs):

```bash
echo <KEY_VALUE> | python3 -c "
import base58, sys, nacl.signing
sk_bytes = base58.b58decode(sys.stdin.read().strip())
# Keypair: first 32 bytes = secret seed, last 32 = pubkey. Accept either format.
seed = sk_bytes[:32] if len(sk_bytes) in (32, 64) else sk_bytes
pk = nacl.signing.SigningKey(seed).verify_key.encode()
print(base58.b58encode(pk).decode())
"
```

If `python3 -c "import nacl"` fails (`pynacl` missing), fall back to `solana-keygen pubkey` against a tmpfile with the key written as a JSON byte array; if that's also unavailable, halt the protocol resolution and ask the user to supply the SVM deployer address explicitly.

#### `cosmos`

Hyperlane Cosmos keys are typically hex-encoded secp256k1 private keys or BIP-39 mnemonics. For the secp256k1 hex case, derive the bech32 address (chain prefix varies per chain):

```bash
echo <KEY_VALUE> | hyperlanedt cosmos derive-address --chain <chain-prefix>
```

If a dedicated derive helper isn't available in the toolchain, halt and ask the user for the expected address (the address is also typically listed in the deployer wallet's first-tx record on a block explorer for the chain).

#### `starknet`

Starknet keys are typically a Starkli/account-manifest JSON keystore. The CLI derives the account address from the keystore itself:

```bash
starkli account address --keystore <keystore-path>
```

For GCP-stored Starknet keystores (rare), pull to a tmpfile, derive, then delete the tmpfile. Halt + ask for explicit address if no tooling is available.

#### `tron`

Tron uses secp256k1 like EVM; the same `cast wallet address` derivation works, but you must then convert the EVM hex address to the Tron base58 form:

```bash
EVM_ADDR=$(cast wallet address <KEY_VALUE>)
python3 -c "
import base58, sys
hex_addr = sys.argv[1].lower().replace('0x', '')
b = bytes.fromhex('41' + hex_addr)
print(base58.b58encode_check(b).decode())
" "$EVM_ADDR"
```

For deploy.yaml + CLI args we use the EVM hex form on Tron (per `reference_warp_deploy_canonical_flow.md`); the base58 form is only for explorer URLs. Store BOTH forms in the artifact for clarity (`address` = hex form, `addressTron` = base58 form).

### 5c: Show Per-Protocol Resolution

After deriving the address, show the protocol's resolution row:

```
Protocol  | Source      | Name                          | Address
ethereum  | gcp-secret  | hyp-mainnet-deployer-test     | 0xabc...0913
```

---

## Step 6: Show Final Resolution Table + Persist

After Steps 4–5 have run for every required protocol, show the full table and get a single final CONFIRM before writing:

```
Protocol  | Source      | Name                          | Address
ethereum  | gcp-secret  | hyp-mainnet-deployer-test     | 0xabc...0913
sealevel  | gcp-secret  | hyp-svm-deployer              | BNGDJ1h…URwJ
cosmos    | gcp-secret  | hyp-cosmos-signer             | neutron1abc...xyz
```

```test
[CONFIRM: Persist this multi-protocol key-context for <ticket-id>]
```

Then write `~/.hyperlane/key-contexts/<ticket-id>.yaml`:

```yaml
ticket: AW-680
resolvedAt: '2026-06-10T17:00:00Z'
keys:
  ethereum:
    source: gcp-secret # or: env-var | keystore
    name: hyp-mainnet-deployer-test # gcp-secret name, env-var name, or keystore path
    address: '0xabc...'
  sealevel:
    source: gcp-secret
    name: hyp-svm-deployer
    address: 'BNGDJ1h...URwJ'
  cosmos:
    source: gcp-secret
    name: hyp-cosmos-signer
    address: 'neutron1abc...xyz'
  tron:
    source: gcp-secret
    name: hyp-tron-signer
    address: '0xabc...0913' # EVM hex form for deploy.yaml + CLI args
    addressTron: 'Txyz...' # base58 form for explorer URLs
```

The artifact stores the secret NAME, not the value. Downstream skills pull the value lazily per command via `gcloud secrets versions access latest --secret=<name>` substitution — the raw private key never lives in conversation logs or shell history. For `source: env-var` and `source: keystore`, downstream skills branch on `source` to construct the right command form (env var name or `--key-file <path>`).

---

## Step 7: Hand Off to Downstream Skills

Tell the user:

> **Key context resolved and saved to `~/.hyperlane/key-contexts/<ticket-id>.yaml`.** Downstream warp-deploy skills (`fund-deployer`, `validate-owners`, `init-route`, `update-owners`, `extend-route`) auto-load this artifact and use the resolved keys via per-protocol substitution. The deployer/recipient address for `fund-deployer` defaults to the artifact's first-listed-protocol `address` (typically `ethereum`); for cross-VM routes the funder may need to fund multiple deployer addresses (one per protocol).

Then proceed to the next skill in the chain (typically `/warp-deploy-fund-deployer <ticket-id>`).

---

## Notes

- **Disclosure is the safeguard.** The skill surfaces the candidate list + derived address to the human; the human picks. There is no automated allowlist enforcement — trust the human in the loop.
- **Never read secret values during enumeration.** Step 4c lists names only. Values are accessed only after Step 4d approval (Step 5b derivation) or downstream consumption.
- **gcloud project comes from the active context.** No hardcoded project ID; the skill assumes `gcloud config get-value project` already points at the right project.
- **For local Claude Code runs without GCP**, the user supplies an env var or keystore path directly per protocol; Step 4c is skipped for those protocols.
- **Idempotent.** Re-running for the same ticket reuses the existing artifact unless the user opts to re-resolve in Step 2.
- **Partial re-resolution.** When the route grows (e.g. a new chain on a new VM is added to a previously-resolved ticket), the skill detects missing protocols in the existing artifact and only re-resolves those, preserving the rest.
- **Multi-protocol routes resolve in one pass.** All required protocols are surfaced in Step 1, walked in Step 3, and committed atomically in Step 6 — no partial mid-loop writes.
