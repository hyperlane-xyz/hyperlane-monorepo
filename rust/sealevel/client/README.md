# hyperlane-sealevel-client

CLI for deploying and managing Hyperlane Sealevel programs.

## Setup

### Prerequisites

- Solana CLI / Agave (see [build-programs.sh](../programs/build-programs.sh) for required version)
- A funded keypair at `~/.config/solana/id.json` (default) or specify with `-k`
- A running Solana validator (local or remote)

### Build the client

From this directory:

```bash
cargo build
```

Or use `cargo run --` to build and run in one step (shown in all examples below).

### Global flags

| Flag | Description | Default |
|------|-------------|---------|
| `-u, --url <URL>` | RPC URL or moniker (`localnet`, `devnet`, `mainnet-beta`) | Solana CLI config |
| `-k, --keypair <PATH>` | Payer keypair path or base58 pubkey (read-only) | Solana CLI config |
| `-b, --compute-budget <UNITS>` | Compute unit limit | `1400000` |
| `-a, --heap-size <BYTES>` | Heap frame size | - |
| `--require-tx-approval` | Prompt before sending each transaction | `false` |
| `--write-instructions` | Print transaction instructions in base58 instead of sending | `false` |

---

## Local development

### Start a local validator

```bash
solana-test-validator --reset
```

### Build programs

From `rust/sealevel/programs/`:

```bash
./build-programs.sh        # all programs
./build-programs.sh core   # mailbox, ISMs, validator-announce, IGP
./build-programs.sh token  # HypERC20, collateral, native
```

Built `.so` files land in `rust/sealevel/target/deploy/`.

---

## Commands

Run from `rust/sealevel/client/`. All examples use `cargo run --` as the binary prefix.

### `core deploy`

Deploys the full Hyperlane core stack (Mailbox, ValidatorAnnounce, IGP) and a default ISM in one command. Program keypairs and IDs are written to `<environments-dir>/<environment>/<chain>/core/`.

```bash
cargo run -- core deploy \
  --local-domain <DOMAIN_ID> \
  --environment <ENV_NAME> \
  --environments-dir ../environments \
  --chain <CHAIN_NAME> \
  --built-so-dir ../target/deploy
```

**With a specific ISM type:**

```bash
# Test ISM (accepts all messages — local dev only)
cargo run -- core deploy \
  --local-domain 1399811149 \
  --environment local-e2e \
  --environments-dir ../environments \
  --chain sealeveltest1 \
  --built-so-dir ../target/deploy \
  --ism-type test

# Trusted relayer ISM
cargo run -- core deploy ... --ism-type trusted-relayer --relayer <PUBKEY>

# Aggregation ISM (threshold-of-N over pre-deployed sub-ISMs)
cargo run -- core deploy ... \
  --ism-type aggregation \
  --aggregation-threshold 2 \
  --aggregation-modules <PK1>,<PK2>,<PK3>

# Amount-routing ISM (routes by transfer amount)
cargo run -- core deploy ... \
  --ism-type amount-routing \
  --amount-routing-threshold 1000000 \
  --lower-ism <PUBKEY> \
  --upper-ism <PUBKEY>
```

The default ISM type is `multisig-message-id` (backward compatible).

---

### `ism deploy`

Deploys and initializes a standalone ISM program. Simpler than the ISM-type-specific subcommands — no environment/registry required.

```bash
cargo run -- ism deploy \
  --ism-type <TYPE> \
  --built-so-dir ../target/deploy \
  --key-dir <PATH_TO_STORE_KEYPAIR> \
  [--local-domain <DOMAIN_ID>]   # optional, affects compute unit pricing
```

**Examples:**

```bash
# Test ISM
cargo run -- ism deploy \
  --ism-type test \
  --built-so-dir ../target/deploy \
  --key-dir /tmp/ism-keys

# Trusted relayer ISM
cargo run -- ism deploy \
  --ism-type trusted-relayer \
  --built-so-dir ../target/deploy \
  --key-dir /tmp/ism-keys \
  --relayer <RELAYER_PUBKEY>

# Aggregation ISM
cargo run -- ism deploy \
  --ism-type aggregation \
  --built-so-dir ../target/deploy \
  --key-dir /tmp/ism-keys \
  --aggregation-threshold 2 \
  --aggregation-modules <PK1>,<PK2>,<PK3>

# Amount-routing ISM
cargo run -- ism deploy \
  --ism-type amount-routing \
  --built-so-dir ../target/deploy \
  --key-dir /tmp/ism-keys \
  --amount-routing-threshold 1000000 \
  --lower-ism <LOWER_ISM_PUBKEY> \
  --upper-ism <UPPER_ISM_PUBKEY>
```

The `--key-dir` stores the program keypair so re-running redeploys to the same program ID.

---

### `ism read`

Reads and prints the on-chain state of a deployed ISM.

```bash
cargo run -- ism read \
  --ism-type <TYPE> \
  --address <PROGRAM_ID>
```

**Examples:**

```bash
# Test ISM (shows accept: bool)
cargo run -- ism read --ism-type test --address <PROGRAM_ID>

# Trusted relayer ISM (shows relayer pubkey)
cargo run -- ism read --ism-type trusted-relayer --address <PROGRAM_ID>

# Aggregation ISM (shows threshold + modules)
cargo run -- ism read --ism-type aggregation --address <PROGRAM_ID>

# Amount-routing ISM (shows threshold, lower/upper ISM pubkeys)
cargo run -- ism read --ism-type amount-routing --address <PROGRAM_ID>

# Multisig ISM (optionally query per-domain validator sets)
cargo run -- ism read --ism-type multisig-message-id --address <PROGRAM_ID>
cargo run -- ism read --ism-type multisig-message-id --address <PROGRAM_ID> --domains 1,2,3
```

---

### `mailbox`

```bash
# Query mailbox state
cargo run -- mailbox query --program-id <PROGRAM_ID>

# Set the default ISM
cargo run -- mailbox set-default-ism \
  --program-id <MAILBOX_PROGRAM_ID> \
  --default-ism <ISM_PROGRAM_ID>

# Send a test message
cargo run -- mailbox send \
  --program-id <PROGRAM_ID> \
  --destination <DOMAIN_ID> \
  --recipient <BYTES32_ADDR> \
  --message-body <HEX>
```

---

### ISM-type-specific commands

The following commands manage individual ISM programs with full environment/registry support (keypairs and program IDs stored under `<environments-dir>`):

- `multisig-ism-message-id` — deploy, init, set-validators-and-threshold, query, configure
- `trusted-relayer-ism` — deploy, init, set-relayer, query, transfer-ownership
- `aggregation-ism` — deploy, init, set-config, query, transfer-ownership
- `amount-routing-ism` — deploy, init, set-config, query, transfer-ownership

Run `cargo run -- <command> --help` for full options.

---

## Environments

`core deploy` and ISM-type-specific deploy commands organize artifacts under an environments directory:

```
<environments-dir>/
  <environment>/               # e.g. local-e2e, mainnet3
    <chain>/                   # e.g. sealeveltest1
      core/
        program-ids.json       # mailbox, validator_announce, multisig_ism_message_id, igp
        keys/                  # program keypairs
    multisig-ism-message-id/
      <chain>/
        <context>/
          program-ids.json
          keys/
```

The `local-e2e` environment under `../environments/` is used for local testing with `sealeveltest1` (domain `13375`) and `sealeveltest2` (domain `13376`).
