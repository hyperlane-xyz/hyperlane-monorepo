This is the main relayer thread loop https://github.com/dymensionxyz/hyperlane-monorepo/blob/d8aa8be43406722cfe2fb813b867b6f14feb423a/rust/main/agents/relayer/src/relayer.rs#L564-L593

The relayer http server https://github.com/dymensionxyz/hyperlane-monorepo/blob/d8aa8be43406722cfe2fb813b867b6f14feb423a/rust/main/agents/relayer/src/relayer.rs#L609-L619

Advice for merkle, use 0x0000000..0 for the ism and it will not run

What relayer http does:
it exposes debugging and observability, and cmd to retry a message
What validator http does:
exposes similar bugging and metrics, also some eigenlayer avs intergration (discovery etc)

---

GPT BELOW

### Concurrency Model Overview

The Relayer spawns routines at three scopes:

1.  **Agent-Wide (Global):** A few tasks run once per agent.
2.  **Per-Origin Chain:** A set of tasks is spawned for _each chain_ the Relayer reads messages from.
3.  **Per-Destination Chain:** A different set of tasks is spawned for _each chain_ the Relayer sends messages to.

### Agent-Wide (Global) Routines (Run Once)

These tasks serve the entire agent.

1.  **HTTP Server (`hyperlane-base/src/server/base_server.rs`)**

    - **What it does:** Exposes an HTTP endpoint (default port 9090) for Prometheus metrics scraping (`/metrics`) and other API routes.
    - **Concurrency:** Runs in its own dedicated Tokio task.

2.  **Tokio Console (`hyperlane-base/src/settings/trace/mod.rs`)**

    - **What it does:** An optional debugging server to inspect the internal state of the Tokio runtime.
    - **Concurrency:** Runs in its own dedicated Tokio task if enabled.

3.  **Runtime Metrics Collector (`hyperlane-base/src/metrics.rs`)**
    - **What it does:** Collects metrics about the Tokio runtime itself (e.g., task count, poll times).
    - **Concurrency:** Runs in its own dedicated Tokio task.

---

### Per-Origin Chain Routines

For **each chain** listed in `origin_chains`, the following set of tasks is spawned. If you have 3 origin chains, you will have 3 sets of these tasks.

1.  **Message Indexer (`ContractSync`)**

    - **What it does:** Polls the origin chain's RPC for new `Dispatch` events from the Mailbox contract.
    - **Interaction:** Makes `eth_getLogs` (or equivalent) calls.
    - **Concurrency:** One task per origin chain.
    - **Your Task:** Your `KaspaMessageIndexer` will be run by this task for the Kaspa origin. It will scan blocks instead of calling `getLogs`.

2.  **IGP Indexer (`ContractSync`)**

    - **What it does:** Polls for `GasPayment` events from the `InterchainGasPaymaster` contract. This is how the relayer knows if a user has paid for gas.
    - **Interaction:** Read-only RPC calls to the origin chain.
    - **Concurrency:** One task per origin chain (if `igp_indexing_enabled`).
    - **Your Task:** For Kaspa, you'll need to define how gas payments are observed. If they are part of the main message transaction, this indexer might merge with the message indexer.

3.  **Merkle Tree Hook Indexer (`ContractSync`)**

    - **What it does:** Polls for `MerkleTreeInsertion` events, which indicate that a new message has been added to the on-chain Merkle tree.
    - **Interaction:** Read-only RPC calls to the origin chain.
    - **Concurrency:** One task per origin chain.
    - **Your Task:** For Kaspa, this is irrelevant as there is no on-chain hook. You will likely disable this for the Kaspa origin.

4.  **Message Processor (`agents/relayer/src/msg/processor.rs`)**

    - **What it does:** The "brain" for an origin chain. It reads the messages stored in the local DB by the indexer, decides if they should be relayed (checking whitelists/blacklists), and wraps them in a `PendingMessage`.
    - **Interaction:** Reads from the local RocksDB. Sends the `PendingMessage` to the appropriate destination chain's submitter queue via an in-memory channel (`mpsc::channel`).
    - **Concurrency:** One task per origin chain. This is the task that connects origins to destinations.

5.  **Merkle Tree Processor (`agents/relayer/src/merkle_tree/processor.rs`)**
    - **What it does:** Reads the `MerkleTreeInsertion` events from the DB and builds an in-memory Merkle tree. This tree is used to generate proofs for messages.
    - **Interaction:** Reads from RocksDB.
    - **Concurrency:** One task per origin chain.
    - **Your Task:** For Kaspa -> Dymension, your validator will be doing this work. The relayer might need a similar processor to construct the Merkle proof part of the metadata if your Dymension ISM requires it.

---

### Per-Destination Chain Routines

For **each chain** listed in `destination_chains`, the following tasks are spawned.

1.  **Serial Submitter (`agents/relayer/src/msg/op_submitter.rs`)**

    - **What it is:** This is not a single task, but a self-contained "pipeline" of four concurrent tasks that manage the entire submission lifecycle for one destination chain. This pipeline model prevents a slow step (like waiting for confirmation) from blocking a fast step (like preparing the next message).
    - **Concurrency:** One `SerialSubmitter` instance (containing these 4 tasks) per destination chain.
    - **Internal Routines:**
      1.  **Receive Task:** Listens on an in-memory channel for `PendingMessage` objects coming from all the `MessageProcessors`.
      2.  **Prepare Task:** Takes a message from the receive queue. Fetches metadata (proofs, validator signatures from S3, etc.). Estimates gas. This is where your custom `KaspaPsktMetadataBuilder` will be called.
      3.  **Submit Task:** Takes a prepared message. Signs and sends the transaction to the destination RPC. This is where your Kaspa `Mailbox::process` (which broadcasts a PSKT) is called.
      4.  **Confirm Task:** Takes a submitted message. Waits for finality and confirms the message was successfully delivered.

2.  **Metrics Updater (`hyperlane-base/src/metrics.rs`)**
    - **What it does:** Queries the destination chain's provider for chain-specific metrics like gas price and block height.
    - **Interaction:** Read-only RPC calls to the destination chain.
    - **Concurrency:** One task per destination chain.

### Concrete Example

If you configure your relayer to operate between **Kaspa, Dymension, and Ethereum** (relaying between all of them):

- **Origins (3):** Kaspa, Dymension, Ethereum
- **Destinations (3):** Kaspa, Dymension, Ethereum

You would have roughly:

- **Global tasks:** 3
- **Per-Origin tasks:** 3 origins \* ~4 tasks/origin = ~12 tasks
- **Per-Destination tasks:** 3 destinations \* (1 Submitter pipeline + 1 Metrics Updater) = ~6 tasks

This results in **~21 primary concurrent routines** running, each with a specific, isolated job, communicating through databases and in-memory queues.

### 2. The Key-Value Store (Relayer & Validator) -

The Relayer and Validator need a fast, simple way to store their internal state. They use RocksDB, an embedded key-value database. It does **not** have tables or a predefined schema.

Instead, the "schema" is defined by **key prefixes**. Each type of data has a unique prefix to avoid collisions.

- **Technology:** RocksDB, wrapped by the `TypedDB` struct.
- **Location of Logic:** `hyperlane-base/src/db/rocks/hyperlane_db.rs`.

#### Key-Value "Schema"

Here's a breakdown of the key structures used. You will interact with this database via the `HyperlaneDb` trait, which provides methods like `store_message`, `retrieve_status_by_message_id`, etc. You won't construct these keys manually.

| Key Prefix (Constant)             | Key Structure (`prefix` + `key`)                             | Value Type                     | Purpose                                                                                                            |
| :-------------------------------- | :----------------------------------------------------------- | :----------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `MESSAGE`                         | `message_` + `message_id`                                    | `HyperlaneMessage`             | Stores the full message content, keyed by its unique ID.                                                           |
| `MESSAGE_ID`                      | `message_id_` + `nonce`                                      | `H256` (Message ID)            | Maps a message's nonce to its unique ID.                                                                           |
| `MESSAGE_DISPATCHED_BLOCK_NUMBER` | `message_dispatched_block_number_` + `nonce`                 | `u64`                          | Stores the block number where a message was dispatched.                                                            |
| `NONCE_PROCESSED`                 | `nonce_processed_` + `nonce`                                 | `bool`                         | A boolean flag indicating if a message nonce has been successfully processed on the destination.                   |
| `HIGHEST_SEEN_MESSAGE_NONCE`      | `highest_seen_message_nonce_`                                | `u32`                          | The highest message nonce the indexer has seen on this origin chain. Used to know where to continue scanning from. |
| `GAS_PAYMENT_FOR_MESSAGE_ID`      | `gas_payment_for_message_id_v2_` + `GasPaymentKey`           | `InterchainGasPaymentData`     | Stores the total gas payment amount for a specific message.                                                        |
| `GAS_EXPENDITURE_FOR_MESSAGE_ID`  | `gas_expenditure_for_message_id_v2_` + `message_id`          | `InterchainGasExpenditureData` | Stores the total gas spent relaying a message.                                                                     |
| `STATUS_BY_MESSAGE_ID`            | `status_by_message_id_` + `message_id`                       | `PendingOperationStatus`       | The current state of a message within the Relayer's processing queue (e.g., `ReadyToSubmit`, `Confirm`).           |
| `PENDING_MESSAGE_RETRY_COUNT`     | `pending_message_retry_count_for_message_id_` + `message_id` | `u32`                          | How many times the Relayer has tried and failed to process this message.                                           |
| `MERKLE_TREE_INSERTION`           | `merkle_tree_insertion_` + `leaf_index`                      | `MerkleTreeInsertion`          | Stores a Merkle tree leaf insertion event.                                                                         |
| `MERKLE_LEAF_INDEX_BY_MESSAGE_ID` | `merkle_leaf_index_by_message_id_` + `message_id`            | `u32`                          | Maps a message ID to its index in the Merkle tree.                                                                 |
