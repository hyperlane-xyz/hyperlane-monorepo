use hyperlane_core::H256;
use serde::Deserialize;
use serde_json::Value;
use sov_universal_wallet::schema::Schema;

/// Event emitted during transaction execution.
#[derive(Clone, Debug, Deserialize)]
pub struct TxEvent {
    /// Key of the event.
    pub key: String,
    /// Value of the event.
    pub value: Value,
    /// Global event's index.
    pub number: u64,
}

/// A Sovereign transaction.
#[derive(Clone, Debug, Deserialize)]
pub struct Tx {
    /// Global transaction index.
    pub number: u64,
    /// A hash of the transaction.
    pub hash: H256,
    /// Events emitted during execution.
    pub events: Vec<TxEvent>,
    /// Global batch index.
    pub batch_number: u64,
    /// A receipt of transaction execution.
    pub receipt: Receipt,
}

/// Result of the transaction contained in the transaction receipt.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxResult {
    Successful,
    Reverted,
    Skipped,
}

/// Receipt of the transaction execution.
#[derive(Clone, Debug, Deserialize)]
pub struct Receipt {
    /// The outcome of the transaction.
    pub result: TxResult,
    /// Transaction metadata.
    pub data: TxData,
}

/// Transaction metadata.
#[derive(Clone, Debug, Deserialize)]
pub struct TxData {
    /// Gas consumption of the transaction.
    pub gas_used: Vec<u64>,
}

/// Batch of Sovereign transactions.
#[derive(Clone, Debug, Deserialize)]
pub struct Batch {
    /// Global batch index.
    pub number: u64,
    /// A hash of the batch.
    pub hash: H256,
    /// Transactions in the batch.
    pub txs: Vec<Tx>,
    /// A slot number at which batch appeared.
    pub slot_number: u64,
}

/// A slot that may contain transaction batches.
#[derive(Clone, Debug, Deserialize)]
pub struct Slot {
    /// Global slot index.
    pub number: u64,
    /// A hash of the slot.
    pub hash: H256,
    /// Batches in the slot, if any.
    pub batches: Vec<Batch>,
    /// Timestamp of the slot.
    pub timestamp: u64,
}

/// Status of the transaction processing.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TxStatus {
    /// Transaction wasn't found.
    Unknown,
    /// Transaction was dropped from the pool.
    Dropped,
    /// Transaction was successfully submitted.
    Submitted,
    /// Transaction was included in the batch.
    Published,
    /// Transaction was successfully processed.
    Processed,
    /// Transaction is finalized.
    Finalized,
}

/// Transaction info from status endpoint.
#[derive(Deserialize, Debug)]
pub struct TxInfo {
    /// A hash of the transaction.
    pub id: H256,
    /// Transaction status.
    pub status: TxStatus,
}

/// Transaction from sequencer endpoint (`/sequencer/txs/{txHash}`).
/// This includes soft-confirmed transactions that haven't been processed yet.
#[derive(Deserialize, Debug)]
pub struct SequencerTx {
    /// A hash of the transaction.
    pub id: H256,
    /// Transaction number in the sequencer.
    pub tx_number: u64,
}

/// Response from the `/rollup/schema` endpoint.
#[derive(Deserialize, Debug)]
pub struct SchemaResponse {
    /// The schema JSON.
    pub schema: Schema,
    /// The chain hash in hex form, prefixed with `0x`.
    pub chain_hash: String,
}

/// Response from the `/rollup/constants` endpoint.
#[derive(Deserialize, Debug)]
pub struct ConstantsResponse {
    /// The rollups Chain ID
    pub chain_id: u64,
    /// The name of the rollup
    pub chain_name: String,
}

/// Response from POST `/sequencer/txs` endpoint.
#[derive(Debug, Deserialize)]
pub struct SubmitTxResponse {
    /// The id of the submitted tx.
    pub id: H256,
    /// The status of the submitted tx.
    pub status: TxStatus,
    /// The events emitted by the endpoint, if any.
    pub events: Option<Vec<TxEvent>>,
}

/// Successful simulation outcome from `/rollup/simulate` endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct SimulateSuccess {
    /// Gas used by the transaction.
    pub gas_used: String,
    /// Priority fee for the transaction.
    pub priority_fee: String,
}

/// Reverted simulation outcome from `/rollup/simulate` endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct SimulateReverted {
    /// Details about the revert.
    pub detail: serde_json::Map<String, serde_json::Value>,
}

/// Skipped simulation outcome from `/rollup/simulate` endpoint.
#[derive(Debug, Clone, Deserialize)]
pub struct SimulateSkipped {
    /// Reason for skipping.
    pub reason: String,
}

/// Result of a transaction simulation from `/rollup/simulate` endpoint.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SimulateResult {
    /// Transaction simulation succeeded.
    Success(SimulateSuccess),
    /// Transaction simulation reverted.
    Reverted(SimulateReverted),
    /// Transaction simulation was skipped.
    Skipped(SimulateSkipped),
}
