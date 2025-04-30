pub use self::storage_types::{InterchainGasExpenditureData, InterchainGasPaymentData};
pub use error::*;
pub use rocks::*;

use hyperlane_core::{
    identifiers::UniqueIdentifier, GasPaymentKey, HyperlaneDomain, HyperlaneMessage,
    InterchainGasPayment, InterchainGasPaymentMeta, MerkleTreeInsertion, PendingOperationStatus,
    H256,
};

mod error;
mod rocks;
pub(crate) mod storage_types;

#[allow(missing_docs)]
/// Hyperlane database interface
pub trait HyperlaneDb: Send + Sync {
    /// Retrieve the nonce of the highest processed message we're aware of
    fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>>;

    /// Retrieve a message by its nonce
    fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>>;

    /// Retrieve whether a message has been processed
    fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>>;

    /// Get the origin domain of the database
    fn domain(&self) -> &HyperlaneDomain;

    fn store_message_id_by_nonce(&self, nonce: &u32, id: &H256) -> DbResult<()>;

    fn retrieve_message_id_by_nonce(&self, nonce: &u32) -> DbResult<Option<H256>>;

    fn store_message_by_id(&self, id: &H256, message: &HyperlaneMessage) -> DbResult<()>;

    fn retrieve_message_by_id(&self, id: &H256) -> DbResult<Option<HyperlaneMessage>>;

    fn store_dispatched_block_number_by_nonce(
        &self,
        nonce: &u32,
        block_number: &u64,
    ) -> DbResult<()>;

    fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>>;

    /// Store whether a message was processed by its nonce
    fn store_processed_by_nonce(&self, nonce: &u32, processed: &bool) -> DbResult<()>;

    fn store_processed_by_gas_payment_meta(
        &self,
        meta: &InterchainGasPaymentMeta,
        processed: &bool,
    ) -> DbResult<()>;

    fn retrieve_processed_by_gas_payment_meta(
        &self,
        meta: &InterchainGasPaymentMeta,
    ) -> DbResult<Option<bool>>;

    fn store_interchain_gas_expenditure_data_by_message_id(
        &self,
        message_id: &H256,
        data: &InterchainGasExpenditureData,
    ) -> DbResult<()>;

    fn retrieve_interchain_gas_expenditure_data_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<InterchainGasExpenditureData>>;

    /// Store the status of an operation by its message id
    fn store_status_by_message_id(
        &self,
        message_id: &H256,
        status: &PendingOperationStatus,
    ) -> DbResult<()>;

    /// Retrieve the status of an operation by its message id
    fn retrieve_status_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<PendingOperationStatus>>;

    fn store_interchain_gas_payment_data_by_gas_payment_key(
        &self,
        key: &GasPaymentKey,
        data: &InterchainGasPaymentData,
    ) -> DbResult<()>;

    fn retrieve_interchain_gas_payment_data_by_gas_payment_key(
        &self,
        key: &GasPaymentKey,
    ) -> DbResult<Option<InterchainGasPaymentData>>;

    fn store_gas_payment_by_sequence(
        &self,
        sequence: &u32,
        payment: &InterchainGasPayment,
    ) -> DbResult<()>;

    fn retrieve_gas_payment_by_sequence(
        &self,
        sequence: &u32,
    ) -> DbResult<Option<InterchainGasPayment>>;

    fn store_gas_payment_block_by_sequence(
        &self,
        sequence: &u32,
        block_number: &u64,
    ) -> DbResult<()>;

    fn retrieve_gas_payment_block_by_sequence(&self, sequence: &u32) -> DbResult<Option<u64>>;

    /// Store the retry count for a pending message by its message id
    fn store_pending_message_retry_count_by_message_id(
        &self,
        message_id: &H256,
        count: &u32,
    ) -> DbResult<()>;

    /// Retrieve the retry count for a pending message by its message id
    fn retrieve_pending_message_retry_count_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<u32>>;

    fn store_merkle_tree_insertion_by_leaf_index(
        &self,
        leaf_index: &u32,
        insertion: &MerkleTreeInsertion,
    ) -> DbResult<()>;

    /// Retrieve the merkle tree insertion event by its leaf index
    fn retrieve_merkle_tree_insertion_by_leaf_index(
        &self,
        leaf_index: &u32,
    ) -> DbResult<Option<MerkleTreeInsertion>>;

    fn store_merkle_leaf_index_by_message_id(
        &self,
        message_id: &H256,
        leaf_index: &u32,
    ) -> DbResult<()>;

    /// Retrieve the merkle leaf index of a message in the merkle tree
    fn retrieve_merkle_leaf_index_by_message_id(&self, message_id: &H256) -> DbResult<Option<u32>>;

    fn store_merkle_tree_insertion_block_number_by_leaf_index(
        &self,
        leaf_index: &u32,
        block_number: &u64,
    ) -> DbResult<()>;

    fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
        &self,
        leaf_index: &u32,
    ) -> DbResult<Option<u64>>;

    fn store_highest_seen_message_nonce_number(&self, nonce: &u32) -> DbResult<()>;

    /// Retrieve the nonce of the highest processed message we're aware of
    fn retrieve_highest_seen_message_nonce_number(&self) -> DbResult<Option<u32>>;

    /// Store payload id by message id
    fn store_payload_ids_by_message_id(
        &self,
        message_id: &H256,
        payloads_id: Vec<UniqueIdentifier>,
    ) -> DbResult<()>;

    /// Retrieve payload id by message id
    fn retrieve_payload_ids_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<Vec<UniqueIdentifier>>>;
}
