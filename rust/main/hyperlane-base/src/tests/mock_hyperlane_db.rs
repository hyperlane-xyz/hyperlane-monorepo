use std::fmt::Debug;

use crate::db::{DbResult, HyperlaneDb, InterchainGasExpenditureData, InterchainGasPaymentData};
use hyperlane_core::{
    identifiers::UniqueIdentifier, GasPaymentKey, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, InterchainGasPayment, InterchainGasPaymentMeta, MerkleTreeInsertion,
    PendingOperationStatus, H256,
};

mockall::mock! {
    /// Mock implementation of HyperlaneDb for testing.
    /// This mock includes an optional provider() method that some tests require.
    pub HyperlaneDb {
        /// Optional provider method for tests that need it
        fn provider(&self) -> Box<dyn HyperlaneProvider>;
    }

    impl Debug for HyperlaneDb {
        fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
    }

    impl HyperlaneDb for HyperlaneDb {
        fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>>;
        fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>>;
        fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>>;
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
        fn store_status_by_message_id(
            &self,
            message_id: &H256,
            status: &PendingOperationStatus,
        ) -> DbResult<()>;
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
        fn store_pending_message_retry_count_by_message_id(
            &self,
            message_id: &H256,
            count: &u32,
        ) -> DbResult<()>;
        fn retrieve_pending_message_retry_count_by_message_id(
            &self,
            message_id: &H256,
        ) -> DbResult<Option<u32>>;
        fn store_merkle_tree_insertion_by_leaf_index(
            &self,
            leaf_index: &u32,
            insertion: &MerkleTreeInsertion,
        ) -> DbResult<()>;
        fn retrieve_merkle_tree_insertion_by_leaf_index(
            &self,
            leaf_index: &u32,
        ) -> DbResult<Option<MerkleTreeInsertion>>;
        fn store_merkle_leaf_index_by_message_id(
            &self,
            message_id: &H256,
            leaf_index: &u32,
        ) -> DbResult<()>;
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
        fn retrieve_highest_seen_message_nonce_number(&self) -> DbResult<Option<u32>>;
        fn store_payload_uuids_by_message_id(&self, message_id: &H256, payload_uuids: Vec<UniqueIdentifier>) -> DbResult<()>;
        fn retrieve_payload_uuids_by_message_id(&self, message_id: &H256) -> DbResult<Option<Vec<UniqueIdentifier>>>;
    }
}
