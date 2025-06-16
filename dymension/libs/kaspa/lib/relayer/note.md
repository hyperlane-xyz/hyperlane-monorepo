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

____________


### Category 1: Core Provider & Contract Interfaces

These traits define the fundamental interactions with the chain and its core Hyperlane contracts. You will need a struct for each (e.g., `KaspaMailbox`, `KaspaValidatorAnnounce`) that implements these.

**1. `HyperlaneProvider`**
   *   **File:** `hyperlane-core/src/traits/provider.rs`
   *   **Purpose:** The most basic read-only interface to the blockchain.
   *   **Your Task:** **Implement fully.** Your `KaspaProvider` will wrap your library `F()`/`G()` to provide block and transaction data.
     *   `get_block_by_height`
     *   `get_txn_by_hash`
     *   `is_contract` (You can probably just return `true` or have a simple heuristic)
     *   `get_balance`

**2. `Mailbox`**
   *   **File:** `hyperlane-core/src/traits/mailbox.rs`
   *   **Purpose:** The central contract for sending and receiving messages.
   *   **Your Task:** **Implement fully (with custom logic).**
     *   `count`: For Kaspa, this will likely be a "virtual" count managed by your `KaspaMessageIndexer` and stored in the agent's local DB, not read from on-chain state.
     *   `delivered`: Check for a confirmation transaction on the Kaspa chain.
     *   `default_ism`: Return the H256 identifier for the ISM you will use for the Dymension -> Kaspa direction.
     *   `process`: This is a critical one. It will take the `metadata` (your signed PSKT), and use your library `F()` to broadcast the final transaction to the Kaspa network.
     *   `process_estimate_costs`: Use library `F()`/`G()` to estimate the fee for the Kaspa transaction.

**3. `MerkleTreeHook`**
   *   **File:** `hyperlane-core/src/traits/merkle_tree_hook.rs`
   *   **Purpose:** An on-chain contract that stores message Merkle roots.
   *   **Your Task:** **Implement as a stub.** Since Kaspa has no on-chain contract for this, your implementation will mostly return errors or empty data. The relayer will use the validator's off-chain signed checkpoints instead.
     *   `tree()`: Return an empty or default `IncrementalMerkleAtBlock`.
     *   `latest_checkpoint()`: Return an error or a default `CheckpointAtBlock`. This ensures logic paths that expect this to succeed for EVM don't get triggered for Kaspa.

**4. `ValidatorAnnounce`**
   *   **File:** `hyperlane-core/src/traits/validator_announce.rs`
   *   **Purpose:** A registry where validators announce the location of their signatures.
   *   **Your Task:** **Implement with custom S3 logic.**
     *   `get_announced_storage_locations`: This method should read a well-known object from the S3 bucket that lists the other validators and their announcement locations. It will not query the Kaspa chain.
     *   `announce`: This method will write the validator's own announcement (its S3 bucket location) to a file in its S3 bucket.

**5. `InterchainGasPaymaster`**
   *   **File:** `hyperlane-core/src/traits/interchain_gas.rs`
   *   **Purpose:** The contract that handles gas payments.
   *   **Your Task:** **Implement as a stub.** On Kaspa, gas payment is not handled by a contract. Your `KaspaGasPaymentIndexer` will find payment information in the message dispatch transactions themselves. The agent framework might still try to construct this object, so having a stub implementation that does nothing is the safest path.

---

### Category 2: Indexer Traits

These traits are used by the `ContractSync` tasks to find on-chain events.

**1. `Indexer<HyperlaneMessage>` and `SequenceAwareIndexer<HyperlaneMessage>`**
   *   **File:** `hyperlane-core/src/traits/indexer.rs`
   *   **Purpose:** To find new `Dispatch` events.
   *   **Your Task:** **Implement fully.** Your `KaspaMessageIndexer` will implement these.
     *   `fetch_logs_in_range`: The core logic. Scan Kaspa blocks in the range for your special message transaction format.
     *   `latest_sequence_count_and_tip`: Since you are using `Block` mode, you can return `(None, tip)` where `tip` is the latest finalized block height from your Kaspa provider. The `None` for sequence count signals to the cursor that it must rely on block-based scanning.

**2. `Indexer<InterchainGasPayment>` and `SequenceAwareIndexer<InterchainGasPayment>`**
   *   **File:** `hyperlane-core/src/traits/indexer.rs`
   *   **Purpose:** To find new `GasPayment` events.
   *   **Your Task:** **Implement fully.**
     *   `fetch_logs_in_range`: Your logic will be nearly identical to the message indexer, but it will parse out the gas payment details from the message transaction instead of the message body.

---

### Category 3: Interchain Security Module (ISM) Traits

ISMs are how destination chains verify messages. You only need to implement what's necessary for your *custom* verification flow.

**1. `InterchainSecurityModule`**
   *   **File:** `hyperlane-core/src/traits/interchain_security_module.rs`
   *   **Purpose:** Base trait for all ISMs.
   *   **Your Task:** **Implement for your custom Kaspa ISM.** You'll need a struct like `KaspaOffchainAttestationIsm`.
     *   `module_type()`: Return a new, custom `ModuleType` variant if needed (though this requires modifying the core enum), or reuse an existing one like `ModuleType::MerkleRootMultisig` if the metadata format you produce is compatible. For the PSKT model, a new type might be cleaner if you were to upstream this. For now, you can probably re-purpose one.
     *   `dry_run_verify()`: This is used for gas estimation. For Kaspa, you can use library `F()`/`G()` to estimate the fee of the final transaction broadcast and return that.

**2. `MultisigIsm`, `RoutingIsm`, `AggregationIsm`**
   *   **Your Task:** **Do not implement these.** Your custom flow (Dymension -> Kaspa) does not use a standard on-chain Multisig or Routing ISM. Your verification logic is entirely contained within your `KaspaMailbox::process` method. The relayer's `MetadataBuilder` will be custom-built for this flow and won't rely on these interfaces.
    