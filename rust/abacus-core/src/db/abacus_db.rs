use crate::db::{DbError, TypedDB, DB};
use crate::{
    accumulator::merkle::Proof, traits::RawCommittedMessage, AbacusMessage, CommittedMessage,
    Decode, InterchainGasPayment, InterchainGasPaymentMeta, InterchainGasPaymentWithMeta,
};
use ethers::core::types::{H256, U256};
use eyre::Result;
use tokio::time::sleep;
use tracing::{debug, info, trace};

use std::future::Future;
use std::time::Duration;

use crate::db::iterator::PrefixIterator;

static LEAF_IDX: &str = "leaf_index_";
static LEAF: &str = "leaf_";
static PROOF: &str = "proof_";
static MESSAGE: &str = "message_";
static LATEST_LEAF_INDEX: &str = "latest_known_leaf_index_";
static LATEST_LEAF_INDEX_FOR_DESTINATION: &str = "latest_known_leaf_index_for_destination_";
static LEAF_PROCESS_STATUS: &str = "leaf_process_status_";
static GAS_PAYMENT_FOR_LEAF: &str = "gas_payment_for_leaf_";
static GAS_PAYMENT_META_PROCESSED: &str = "gas_payment_meta_processed_";

/// DB handle for storing data tied to a specific Outbox.
///
/// Key structure: ```<entity>_<additional_prefix(es)>_<key>```
#[derive(Debug, Clone)]
pub struct AbacusDB(TypedDB);

impl std::ops::Deref for AbacusDB {
    type Target = TypedDB;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<TypedDB> for AbacusDB {
    fn as_ref(&self) -> &TypedDB {
        &self.0
    }
}

impl AsRef<DB> for AbacusDB {
    fn as_ref(&self) -> &DB {
        self.0.as_ref()
    }
}

impl AbacusDB {
    /// Instantiated new `AbacusDB`
    pub fn new(entity: impl AsRef<str>, db: DB) -> Self {
        Self(TypedDB::new(entity.as_ref().to_owned(), db))
    }

    /// Store list of messages
    pub fn store_messages(&self, messages: &[RawCommittedMessage]) -> Result<u32> {
        let mut latest_leaf_index: u32 = 0;
        for message in messages {
            self.store_latest_message(message)?;

            let committed_message: CommittedMessage = message.try_into()?;
            info!(
                leaf_index = &committed_message.leaf_index,
                origin = &committed_message.message.origin,
                destination = &committed_message.message.destination,
                "Stored new message in db.",
            );
            latest_leaf_index = committed_message.leaf_index;
        }

        Ok(latest_leaf_index)
    }

    /// Store a raw committed message building off of the latest leaf index
    pub fn store_latest_message(&self, message: &RawCommittedMessage) -> Result<()> {
        // If this message is not building off the latest leaf index, log it.
        if let Some(idx) = self.retrieve_latest_leaf_index()? {
            if idx != message.leaf_index - 1 {
                debug!(
                    "Attempted to store message not building off latest leaf index. Latest leaf index: {}. Attempted leaf index: {}.",
                    idx,
                    message.leaf_index,
                )
            }
        }

        self.store_raw_committed_message(message)
    }

    /// Store a raw committed message
    ///
    /// Keys --> Values:
    /// - `leaf_index` --> `leaf`
    /// - `leaf` --> `message`
    pub fn store_raw_committed_message(&self, message: &RawCommittedMessage) -> Result<()> {
        let parsed = AbacusMessage::read_from(&mut message.message.clone().as_slice())?;

        let leaf = message.leaf();

        debug!(
            leaf = ?leaf,
            destination = parsed.destination,
            leaf_index = message.leaf_index,
            "storing raw committed message in db"
        );
        self.store_leaf(message.leaf_index, parsed.destination, leaf)?;
        self.store_keyed_encodable(MESSAGE, &leaf, message)?;
        Ok(())
    }

    /// Store the latest known leaf_index
    ///
    /// Key --> value: `LATEST_LEAF_INDEX` --> `leaf_index`
    pub fn update_latest_leaf_index(&self, leaf_index: u32) -> Result<(), DbError> {
        if let Ok(Some(idx)) = self.retrieve_latest_leaf_index() {
            if leaf_index <= idx {
                return Ok(());
            }
        }
        self.store_encodable("", LATEST_LEAF_INDEX, &leaf_index)
    }

    /// Retrieve the highest known leaf_index
    pub fn retrieve_latest_leaf_index(&self) -> Result<Option<u32>, DbError> {
        self.retrieve_decodable("", LATEST_LEAF_INDEX)
    }

    /// Store the latest known leaf_index for a destination
    ///
    /// Key --> value: `destination` --> `leaf_index`
    pub fn update_latest_leaf_index_for_destination(
        &self,
        destination: u32,
        leaf_index: u32,
    ) -> Result<(), DbError> {
        if let Ok(Some(idx)) = self.retrieve_latest_leaf_index_for_destination(destination) {
            if leaf_index <= idx {
                return Ok(());
            }
        }
        self.store_keyed_encodable(LATEST_LEAF_INDEX_FOR_DESTINATION, &destination, &leaf_index)
    }

    /// Retrieve the highest known leaf_index for a destination
    pub fn retrieve_latest_leaf_index_for_destination(
        &self,
        destination: u32,
    ) -> Result<Option<u32>, DbError> {
        self.retrieve_keyed_decodable(LATEST_LEAF_INDEX_FOR_DESTINATION, &destination)
    }

    /// Store the leaf keyed by leaf_index
    fn store_leaf(&self, leaf_index: u32, destination: u32, leaf: H256) -> Result<(), DbError> {
        debug!(
            leaf_index,
            leaf = ?leaf,
            "storing leaf hash keyed by index"
        );
        self.store_keyed_encodable(LEAF, &leaf_index, &leaf)?;
        self.update_latest_leaf_index(leaf_index)?;
        self.update_latest_leaf_index_for_destination(destination, leaf_index)
    }

    /// Retrieve a raw committed message by its leaf hash
    pub fn message_by_leaf(&self, leaf: H256) -> Result<Option<RawCommittedMessage>, DbError> {
        self.retrieve_keyed_decodable(MESSAGE, &leaf)
    }

    /// Retrieve the leaf hash keyed by leaf index
    pub fn leaf_by_leaf_index(&self, leaf_index: u32) -> Result<Option<H256>, DbError> {
        self.retrieve_keyed_decodable(LEAF, &leaf_index)
    }

    /// Retrieve a raw committed message by its leaf index
    pub fn message_by_leaf_index(
        &self,
        index: u32,
    ) -> Result<Option<RawCommittedMessage>, DbError> {
        let leaf: Option<H256> = self.leaf_by_leaf_index(index)?;
        match leaf {
            None => Ok(None),
            Some(leaf) => self.message_by_leaf(leaf),
        }
    }

    /// Iterate over all leaves
    pub fn leaf_iterator(&self) -> PrefixIterator<H256> {
        PrefixIterator::new(self.0.as_ref().prefix_iterator(LEAF_IDX), LEAF_IDX.as_ref())
    }

    /// Store a proof by its leaf index
    ///
    /// Keys --> Values:
    /// - `leaf_index` --> `proof`
    pub fn store_proof(&self, leaf_index: u32, proof: &Proof) -> Result<(), DbError> {
        debug!(leaf_index, "storing proof in DB");
        self.store_keyed_encodable(PROOF, &leaf_index, proof)
    }

    /// Retrieve a proof by its leaf index
    pub fn proof_by_leaf_index(&self, leaf_index: u32) -> Result<Option<Proof>, DbError> {
        self.retrieve_keyed_decodable(PROOF, &leaf_index)
    }

    // TODO(james): this is a quick-fix for the prover_sync and I don't like it
    /// poll db ever 100 milliseconds waitinf for a leaf.
    pub fn wait_for_leaf(&self, leaf_index: u32) -> impl Future<Output = Result<H256, DbError>> {
        let slf = self.clone();
        async move {
            loop {
                if let Some(leaf) = slf.leaf_by_leaf_index(leaf_index)? {
                    return Ok(leaf);
                }
                sleep(Duration::from_millis(100)).await
            }
        }
    }

    /// Mark leaf as processed
    pub fn mark_leaf_as_processed(&self, leaf_index: u32) -> Result<(), DbError> {
        debug!(leaf_index = ?leaf_index, "mark leaf as processed");
        self.store_keyed_encodable(LEAF_PROCESS_STATUS, &leaf_index, &(1_u32))
    }

    /// Retrieve leaf processing status
    pub fn retrieve_leaf_processing_status(
        &self,
        leaf_index: u32,
    ) -> Result<Option<bool>, DbError> {
        let value: Option<u32> = self.retrieve_keyed_decodable(LEAF_PROCESS_STATUS, &leaf_index)?;
        Ok(value.map(|x| x == 1))
    }

    /// If the provided gas payment, identified by its metadata, has not been processed,
    /// processes the gas payment and records it as processed.
    pub fn process_gas_payment(
        &self,
        gas_payment_with_meta: &InterchainGasPaymentWithMeta,
    ) -> Result<(), DbError> {
        let meta = &gas_payment_with_meta.meta;
        // If the gas payment has already been processed, do nothing
        if self.retrieve_gas_payment_meta_processed(meta)? {
            trace!(gas_payment_with_meta=?gas_payment_with_meta, "Attempted to process an already-processed gas payment");
            return Ok(());
        }
        // Set the gas payment as processed
        self.store_gas_payment_meta_processed(meta)?;

        // Update the total gas payment for the leaf to include the payment
        self.update_gas_payment_for_leaf(&gas_payment_with_meta.payment)?;

        Ok(())
    }

    /// Record a gas payment, identified by its metadata, as processed
    fn store_gas_payment_meta_processed(
        &self,
        gas_payment_meta: &InterchainGasPaymentMeta,
    ) -> Result<(), DbError> {
        self.store_keyed_encodable(GAS_PAYMENT_META_PROCESSED, gas_payment_meta, &true)
    }

    /// Get whether a gas payment, identified by its metadata, has been processed already
    fn retrieve_gas_payment_meta_processed(
        &self,
        gas_payment_meta: &InterchainGasPaymentMeta,
    ) -> Result<bool, DbError> {
        Ok(self
            .retrieve_keyed_decodable(GAS_PAYMENT_META_PROCESSED, gas_payment_meta)?
            .unwrap_or(false))
    }

    /// Update the total gas payment for a leaf index to include gas_payment
    fn update_gas_payment_for_leaf(
        &self,
        gas_payment: &InterchainGasPayment,
    ) -> Result<(), DbError> {
        let InterchainGasPayment { leaf_index, amount } = gas_payment;
        let existing_payment = self.retrieve_gas_payment_for_leaf(*leaf_index)?;
        let total = existing_payment + amount;

        info!(leaf_index=?leaf_index, gas_payment_amount=?amount, new_total_gas_payment=?total, "Storing gas payment");
        self.store_keyed_encodable(GAS_PAYMENT_FOR_LEAF, &gas_payment.leaf_index, &total)?;

        Ok(())
    }

    /// Retrieve the total gas payment for a leaf index
    fn retrieve_gas_payment_for_leaf(&self, leaf_index: u32) -> Result<U256, DbError> {
        Ok(self
            .retrieve_keyed_decodable(GAS_PAYMENT_FOR_LEAF, &leaf_index)?
            .unwrap_or(U256::zero()))
    }
}
