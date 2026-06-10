---
name: warp-deploy-select-keys
description: Preflight that resolves which private key(s) to use for the warp-deploy chain across every protocol in the route (EVM / Sealevel / Cosmos / Starknet / Tron). For each protocol the user supplies either a specific key spec (GCP secret name, env var, or keystore path) or a candidate list of GCP secret names for the agent to surface and the user to pick. The agent never enumerates GCP secrets on its own and never reads secret values without an explicit user-approved pick. Persists the resolution to `~/.hyperlane/key-contexts/<ticket-id>.yaml` for downstream warp-deploy skills to auto-load.
---

# Warp Route Deploy — Select Keys

You are resolving which private key(s) the warp-deploy chain should use for signing across every protocol in the route. Run this BEFORE any of `/warp-deploy-fund-deployer`, `/warp-deploy-validate-owners`, `/warp-deploy-init-route`, `/warp-deploy-update-owners`, `/warp-update-extend` — or have those skills invoke this one when the artifact is missing.

A single route can span multiple protocols (e.g., `ethereum` + `sealevel` + `cosmos`) — each needs its own key. This skill walks every required protocol and resolves them in one pass.

## Input

The user provides:

- **Linear ticket ID** (required, e.g. `AW-123`) — namespaces the resolved key-context artifact.
- **Per protocol**, ONE of (the user picks the form they want; the agent never enumerates GCP secrets unprompted):
  - **Specific key spec** — a single reference the agent uses directly. Any of:
    - GCP secret name (e.g. `mainnet3-haggis-deployer-key`)
    - Environment variable name (e.g. `HYP_KEY`)
    - Keystore file path
  - **Candidate list of GCP secret names** — multiple names the agent presents to the user to pick from with a `[CONFIRM:]` per pick. The user is responsible for compiling this list (from their own `gcloud secrets list` output, prior knowledge, a Notion page of allowed test keys, etc.); the agent doesn't run `gcloud secrets list` itself.

If neither is supplied for a required protocol, the skill halts and asks the user inline.

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

The agent NEVER enumerates GCP secrets project-wide on its own. For each protocol, the user supplies either a specific key spec OR a candidate list of GCP secret names — follow the matching path.

### 4a: Pre-Supplied Specific Key Spec

If the user has already told you (in the conversation context, in the parent skill's input, or via this skill's invocation arguments) which exact key to use for THIS protocol — a single GCP secret name, env var name, or keystore path — record it and skip directly to Step 5 (Verify + Derive). No further user interaction needed for this protocol at Step 4.

### 4b: User-Supplied Candidate List

If the user provided a list of candidate GCP secret names for THIS protocol (typically two-to-five names — the test deployer, an alternate, etc.), present the list to the user with a `[CONFIRM:]` marker per pick:

```
Candidates for the <protocol> deployer key:
- <candidate-1>
- <candidate-2>
- <candidate-3>
```

```test
[CONFIRM: Use <candidate-1> as the <protocol> deployer key]
```

The user picks one. Do NOT pre-pick by name heuristic (e.g. "the one with `test` in the name") — that's exactly the foot-gun this skill exists to close. The human reading the candidate list and approving the pick IS the safeguard.

### 4c: Neither Provided — Ask the User Inline

If the user didn't supply a specific key spec OR a candidate list for THIS protocol at invocation, halt and ask inline:

> For the `<protocol>` deployer key, supply either:
>
> - A specific reference — GCP secret name, env var name, or keystore path
> - A list of candidate GCP secret names you'd like me to surface for you to pick from
>
> I don't enumerate GCP secrets myself: my IAM scope typically lacks `secretmanager.secrets.list` project-wide, and even with it granted, enumerating without an explicit candidate list invites accidentally picking the wrong key. The human providing the input IS the safeguard.

Wait for the user's response, then jump to 4a or 4b accordingly.

---

## Step 5: Verify Access + Derive Address (per protocol)

### Transient-Retry Guideline

Every `gcloud secrets versions access …` call in this step (5a verify, 5b derive) is observably flaky in Haggis's sandbox — auth tokens occasionally don't propagate on the first try and the call returns `PERMISSION_DENIED` or `UNAUTHENTICATED` even when the IAM bindings are correct. Before halting on any gcloud failure, **retry the failing call up to 3 times with a 1–2s sleep between attempts**. Only halt + surface the error to the user if all 3 attempts fail. The retry block:

```bash
for attempt in 1 2 3; do
  if gcloud secrets versions access latest --secret=<name> > /dev/null 2>&1; then
    echo "ok (attempt $attempt)"
    break
  fi
  if [ "$attempt" = "3" ]; then
    echo "FAILED after 3 attempts" >&2
    exit 1
  fi
  sleep 2
done
```

Tell the user which attempt succeeded (or that all 3 failed) so transient flakes are visible without being a wall-of-noise. Apply the same retry shape to the 5b derivation commands (they all use the same gcloud substitution).

### 5a: Verify Access (don't echo the value)

```bash
gcloud secrets versions access latest --secret=<name> > /dev/null && echo ok
```

(Wrap in the retry block above before running.)

If all 3 attempts fail, surface the error and stop the loop for this protocol. Common persistent causes (after retries are exhausted):

- Wrong secret name (typo)
- Insufficient IAM permission (the calling identity needs `roles/secretmanager.secretAccessor`)
- Project context mismatch
- Active identity is the wrong principal (e.g., a workload-identity pool rather than the intended service account) — diagnose with `gcloud auth list --format='value(account)'`

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
ticket: AW-123
resolvedAt: '<ISO-8601 timestamp>'
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

- **Disclosure is the safeguard.** The agent never picks a key on its own. It either uses an exact user-supplied reference (4a) or surfaces a user-supplied candidate list and asks the user to pick (4b).
- **The agent does NOT run `gcloud secrets list`.** Project-wide enumeration is intentionally out of scope. Reasons: (a) typical agent IAM scope lacks `secretmanager.secrets.list`; (b) even with it granted, surfacing every project-wide secret name invites foot-guns (production-deployer secret appears alongside test-deployer secret with no semantic distinction). The human supplying the candidate list scopes the agent's options up-front.
- **Never read secret values without an approved pick.** Values are accessed only in Step 5 after the user has either pre-supplied an exact reference (4a) or approved a pick from the candidate list (4b).
- **For local Claude Code runs without GCP**, supply an env var or keystore path directly per protocol via 4a.
- **Idempotent.** Re-running for the same ticket reuses the existing artifact unless the user opts to re-resolve in Step 2.
- **Partial re-resolution.** When the route grows (e.g. a new chain on a new VM is added to a previously-resolved ticket), the skill detects missing protocols in the existing artifact and only re-resolves those, preserving the rest.
- **Multi-protocol routes resolve in one pass.** All required protocols are surfaced in Step 1, walked in Step 3, and committed atomically in Step 6 — no partial mid-loop writes.
