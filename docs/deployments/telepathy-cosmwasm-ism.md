# CosmWasm Telepathy ISM Deployment and Operations Guide

This guide details the end-to-end architecture, contract deployment, configuration, offchain CCIP-read service operation, and end-to-end message verification for the **CosmWasm Telepathy Interchain Security Module (ISM)** in Hyperlane.

---

## 1. Architecture Overview

The CosmWasm Telepathy ISM verifies cross-chain messages originating from Ethereum (or EVM chains) to any CosmWasm chain (e.g., Injective, Neutron, Osmosis, Archway, Sei) using Succinct TelepathyX zero-knowledge consensus proofs and Ethereum Merkle Patricia Trie (MPT) state verification.

```
+---------------------------+
|  Origin: Ethereum (EVM)   |
|   Mailbox.sol Dispatches  |
|    Message -> State Root  |
+-------------+-------------+
              |
              | (Offchain Proof Fetch via CCIP-Read)
              v
+-------------------------------------------------------------+
|               CCIP-Read Gateway Service                     |
|           (@hyperlane-xyz/ccip-server: /telepathy)          |
|  - Calls eth_getProof on Ethereum RPC                       |
|  - Queries Beacon Slot & State Root                         |
|  - Formats TelepathyMetadata (MPT Account + Storage Proof)  |
+-----------------------------+-------------------------------+
                              |
                              | (Relayer delivers Msg + Metadata)
                              v
+-------------------------------------------------------------+
|             Destination: CosmWasm Chain                     |
|                                                             |
|   +---------------------+        +-----------------------+  |
|   | ism-telepathy       | -----> | telepathy-light-client|  |
|   | - Parses Msg & Meta |        | - Stores Sync Roots   |  |
|   | - Verifies MPT Proof|        | - Stores State Roots  |  |
|   +---------------------+        +-----------------------+  |
|              |                                              |
|              v (Verified = true)                            |
|   +---------------------+                                   |
|   | CosmWasm Mailbox    |                                   |
|   | - Delivers to App   |                                   |
|   +---------------------+                                   |
+-------------------------------------------------------------+
```

---

## 2. Smart Contract Components

### 2.1 `packages/mpt-verify`

Pure-Rust implementation of Ethereum Merkle Patricia Trie (MPT) and Recursive Length Prefix (RLP) proof verification without C dependencies.

- Decodes compact nibble paths (leaf and extension nodes).
- Traverses branch, extension, and leaf nodes against cryptographic roots.
- Decodes account nodes (`nonce`, `balance`, `storageRoot`, `codeHash`).
- Verifies storage proofs against `storageRoot`.

### 2.2 `contracts/telepathy-light-client`

CosmWasm light client tracking Ethereum consensus state roots verified by Succinct ZK-SNARKs.

- Stores historical `execution_state_root` indexed by slot.
- Validates sync committee rotation steps.

### 2.3 `contracts/ism-telepathy`

Hyperlane Interchain Security Module implementing the standard `ModuleType` and `Verify` interfaces:

- **Module Type**: Returns `ccip_read`.
- **Offchain Verify Info**: Returns CCIP gateway URLs and query payload.
- **Verification**: Extracts origin domain, Mailbox account proof, storage proof for message commitment, queries light client for verified state root, and confirms cryptographic validity.

---

## 3. Compilation & Testing

To compile and execute all unit tests locally:

```bash
cargo test --manifest-path cosmwasm/Cargo.toml
```

To build production-optimized WebAssembly binaries:

```bash
docker run --rm -v "$(pwd)/cosmwasm":/code \
  --mount type=volume,source="$(basename "$(pwd)")_cache",target=/code/target \
  --mount type=volume,source=registry_cache,target=/usr/local/cargo/registry \
  cosmwasm/workspace-optimizer:0.14.0
```

---

## 4. Deployment Instructions

### Step 1: Store and Instantiate `telepathy-light-client`

Store the wasm binary on the destination chain:

```bash
# Upload wasm code
RES=$(injectived tx wasm store artifacts/telepathy_light_client.wasm \
  --from validator --chain-id injective-888 --gas auto --gas-prices 500000000inj -y --output json)
CODE_ID=$(echo $RES | jq -r '.logs[0].events[] | select(.type=="store_code") | .attributes[] | select(.key=="code_id") | .value')

# Instantiate contract with genesis sync committee and execution state root
INIT_LIGHT_CLIENT='{
  "owner": "inj1youraddress...",
  "genesis_slot": 8500000,
  "genesis_sync_committee_root": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "genesis_sync_committee_period": 1000,
  "genesis_execution_state_root": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
}'

injectived tx wasm instantiate $CODE_ID "$INIT_LIGHT_CLIENT" \
  --from validator --label "telepathy-light-client" --no-admin --chain-id injective-888 -y
```

### Step 2: Store and Instantiate `ism-telepathy`

```bash
# Upload wasm code
RES=$(injectived tx wasm store artifacts/ism_telepathy.wasm \
  --from validator --chain-id injective-888 --gas auto --gas-prices 500000000inj -y --output json)
ISM_CODE_ID=$(echo $RES | jq -r '.logs[0].events[] | select(.type=="store_code") | .attributes[] | select(.key=="code_id") | .value')

# Instantiate ISM contract
INIT_ISM='{
  "owner": "inj1youraddress...",
  "light_client": "inj1lightclientcontractaddress...",
  "origin_mailbox": "0x35231d4c2D8B8ADcB5617A638A0c4548684c7C70",
  "origin_domain": 1,
  "urls": [
    "https://telepathy-gateway.hyperlane.xyz/telepathy/getProof/{sender}/{data}.json"
  ]
}'

injectived tx wasm instantiate $ISM_CODE_ID "$INIT_ISM" \
  --from validator --label "ism-telepathy" --no-admin --chain-id injective-888 -y
```

---

## 5. Running the Offchain CCIP-Read Service

Configure and run the CCIP gateway in `typescript/ccip-server`:

### Environment Configuration (`.env`):

```env
PORT=8080
ENABLED_MODULES=telepathy
RPC_ADDRESS=http://localhost:8545
CHAIN_ID=1
ORIGIN_DOMAIN=1
MAILBOX_ADDRESS=0x35231d4c2D8B8ADcB5617A638A0c4548684c7C70
TELEPATHY_API_URL=https://alpha.succinct.xyz/api
HYPERLANE_EXPLORER_API=https://explorer.hyperlane.xyz/api
```

### Start Server:

```bash
pnpm --filter @hyperlane-xyz/ccip-server start
```

### Querying Proofs via CCIP-Read:

```bash
curl -X POST http://localhost:8080/telepathy/getProof \
  -H "Content-Type: application/json" \
  -d '{"sender": "0x35231d4c2D8B8ADcB5617A638A0c4548684c7C70", "data": "0x030000006400000001121212121212121212121212121212121212121212121212121212121212121200000002343434343434343434343434343434343434343434343434343434343434343468656c6c6f"}'
```

---

## 6. On-Chain Verification Workflow

1. **Message Dispatch**: User sends a message via Ethereum Mailbox.
2. **Relayer Hook**: Hyperlane Relayer queries `QueryMsg::Ism(IsmQuery::ModuleType {})` -> receives `"ccip_read"`.
3. **Offchain Gateway Query**: Relayer queries `QueryMsg::Ism(IsmQuery::VerifyInfo { message })`, obtains gateway URLs, and fetches the MPT proof metadata from `TelepathyService`.
4. **Execution & Delivery**: Relayer executes `Mailbox::process(message, metadata)` on the destination CosmWasm contract. The Mailbox calls `ism.verify(message, metadata)` which executes the MPT proof against the verified Telepathy state root.
