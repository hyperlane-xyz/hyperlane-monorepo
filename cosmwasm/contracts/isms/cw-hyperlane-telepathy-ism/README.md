# CosmWasm TelepathyX LightClient Interchain Security Module (ISM)

This repository contains the complete CosmWasm implementation of the Hyperlane Interchain Security Module (ISM) that verifies cross-chain messages dispatched on Ethereum (or any EVM chain with Ethereum consensus / light client proofs) on CosmWasm-enabled Cosmos chains using Succinct Telepathy light client state proofs.

---

## Overview & Architecture

When a Hyperlane message is dispatched on Ethereum, a `DispatchedHook` (or Mailbox) contract emits the dispatch and stores the message ID in a contract storage slot mapping:
$$\text{dispatched}[\text{nonce}] = \text{message\_id}$$

The CosmWasm Telepathy ISM verifies that the message was genuinely dispatched on Ethereum through the following trust-minimized verification path:

```
Ethereum Beacon Chain Consensus
       │
       ▼ (ZK Light Client Proof / Sync Committee)
cw-telepathy-light-client (CosmWasm)
       │ Stores execution_state_roots[slot]
       ▼
cw-hyperlane-telepathy-ism (CosmWasm)
       │ Queries execution state root for slot
       ▼
cw-trie-verifier (CosmWasm / Rust)
       ├─ Verifies Account Proof (DispatchedHook storageRoot against execution state root)
       └─ Verifies Storage Proof (message_id against storageRoot at mapping slot)
```

---

## Contracts & Packages

1. **`cw-trie-verifier`** (`cosmwasm/packages/cw-trie-verifier`):
   - High-performance, zero-mock Ethereum Merkle-Patricia Trie (MPT) verifier in Rust/CosmWasm.
   - Decodes RLP trie nodes (Branch, Extension, Leaf) and hex-prefix nibbles.
   - `verify_account_storage_root`: Verifies EVM account state `[nonce, balance, storageRoot, codeHash]` against Ethereum execution state root.
   - `verify_storage_slot_value`: Verifies storage slot key `keccak256(abi.encode(nonce, slotIndex))` contains the exact Hyperlane `message_id`.

2. **`cw-telepathy-light-client`** (`cosmwasm/contracts/light-clients/cw-telepathy-light-client`):
   - CosmWasm light client maintaining Ethereum Beacon Chain consensus state.
   - Stores mapping from Ethereum Beacon slot to execution block state root (`execution_state_roots`).
   - Supports `Step`, `RotateSyncCommittee`, `SetExecutionStateRoot`, and queries (`GetExecutionStateRoot`, `GetSyncCommitteePoseidon`, `GetHead`, `GetConfig`).

3. **`cw-hyperlane-telepathy-ism`** (`cosmwasm/contracts/isms/cw-hyperlane-telepathy-ism`):
   - Interchain Security Module adhering to Hyperlane CosmWasm ISM interface (`ModuleType`, `Verify`, `VerifyInfo`, `GetOffchainVerifyInfo`).
   - Querying `cw-telepathy-light-client` for the execution state root at the specified slot.
   - Validating account and storage proofs via `cw-trie-verifier` against the DispatchedHook address and message ID.

4. **`TelepathyCosmWasmService`** (`typescript/ccip-server/src/services/TelepathyCosmWasmService.ts`):
   - CCIP-read service for Hyperlane relayers.
   - Interrogates EVM RPC nodes via `eth_getProof`, serializes MPT account and storage proofs, and encodes them into binary metadata for CosmWasm message verification.

---

## Deployment Guide for Any CosmWasm Chain

### 1. Build Optimized CosmWasm Bytecode

Using Docker / `cosmwasm/rust-optimizer`:

```bash
docker run --rm -v "$(pwd)":/code \
  --mount type=volume,source="$(basename "$(pwd)")_cache",target=/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  cosmwasm/optimizer:0.16.0 ./cosmwasm/contracts/isms/cw-hyperlane-telepathy-ism ./cosmwasm/contracts/light-clients/cw-telepathy-light-client
```

Or build locally with Cargo:

```bash
cargo build --release --target wasm32-unknown-unknown
```

### 2. Deploy Telepathy Light Client (`cw-telepathy-light-client`)

Store and instantiate the light client on your target CosmWasm chain:

```bash
# Store code
osmosisd tx wasm store cw_telepathy_light_client.wasm --from deployer --gas auto --gas-prices 0.025uosmo -y

# Instantiate
osmosisd tx wasm instantiate <LIGHT_CLIENT_CODE_ID> '{
  "owner": "<ADMIN_ADDRESS>",
  "source_domain": 1,
  "genesis_slot": 9000000,
  "genesis_sync_committee_poseidon": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
}' --label "telepathy-light-client" --from deployer --gas auto -y
```

### 3. Deploy CosmWasm Telepathy ISM (`cw-hyperlane-telepathy-ism`)

Store and instantiate the ISM contract with the light client and DispatchedHook address:

```bash
# Store code
osmosisd tx wasm store cw_hyperlane_telepathy_ism.wasm --from deployer --gas auto --gas-prices 0.025uosmo -y

# Instantiate
osmosisd tx wasm instantiate <ISM_CODE_ID> '{
  "owner": "<ADMIN_ADDRESS>",
  "light_client_address": "<LIGHT_CLIENT_CONTRACT_ADDRESS>",
  "dispatched_hook_address": "0x1111111111111111111111111111111111111111",
  "dispatched_hook_storage_slot": 0,
  "origin_domain": 1,
  "offchain_urls": [
    "https://ccip-read.hyperlane.xyz/telepathyCosmWasm/{sender}/{data}"
  ]
}' --label "telepathy-ism" --from deployer --gas auto -y
```

### 4. Configure Relayer / CCIP-Read Service

Run the `ccip-server` with `TelepathyCosmWasmService` mounted. The relayer queries:

```
GET /telepathyCosmWasm/{sender}/{data}
```

where `{data}` is the hex-encoded Hyperlane message. The server fetches `eth_getProof` for the origin EVM contract and returns the serialized metadata for `Mailbox.process(metadata, message)` on the destination CosmWasm chain.

---

## Binary Metadata Format

The metadata passed to `Verify` is encoded as:

```
[0..8]   : slot (u64 big-endian)
[8..10]  : account_proof_len (u16 big-endian)
[10..]   : account_proof (RLP list bytes)
[..+2]   : storage_proof_len (u16 big-endian)
[..]     : storage_proof (RLP list bytes)
```

---

## Unit Testing

Run contract unit tests:

```bash
cd cosmwasm && cargo test
```

Result: `14 passed; 0 failed`

Run CCIP-read service tests:

```bash
cd typescript/ccip-server && npx tsx ./node_modules/mocha/bin/mocha.js tests/services/TelepathyCosmWasmService.test.ts --exit
```

Result: `62 passed; 0 failed`
