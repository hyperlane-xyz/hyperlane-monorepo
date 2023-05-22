use std::future::Future;
use std::time::Duration;

use async_trait::async_trait;
use eyre::Result;
use tokio::time::sleep;
use tracing::{debug, trace};

use hyperlane_core::{
    HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, HyperlaneMessageStore,
    HyperlaneWatermarkedLogStore, InterchainGasExpenditure, InterchainGasPayment,
    InterchainGasPaymentMeta, LogMeta, H256, U256,
};

use super::{
    storage_types::{InterchainGasExpenditureData, InterchainGasPaymentData},
    DbError, TypedDB, DB,
};

// these keys MUST not be given multiple uses in case multiple agents are
// started with the same database and domain.

const MESSAGE_ID: &str = "message_id_";
const MESSAGE_DISPATCHED_BLOCK_NUMBER: &str = "message_dispatched_block_number_";
const MESSAGE: &str = "message_";
const NONCE_PROCESSED: &str = "nonce_processed_";
const GAS_PAYMENT_FOR_MESSAGE_ID: &str = "gas_payment_for_message_id_v2_";
const GAS_PAYMENT_META_PROCESSED: &str = "gas_payment_meta_processed_v2_";
const GAS_EXPENDITURE_FOR_MESSAGE_ID: &str = "gas_expenditure_for_message_id_v2_";
const LATEST_INDEXED_GAS_PAYMENT_BLOCK: &str = "latest_indexed_gas_payment_block";

type DbResult<T> = std::result::Result<T, DbError>;

/// DB handle for storing data tied to a specific Mailbox.
#[derive(Debug, Clone)]
pub struct HyperlaneRocksDB(HyperlaneDomain, TypedDB);

impl std::ops::Deref for HyperlaneRocksDB {
    type Target = TypedDB;

    fn deref(&self) -> &Self::Target {
        &self.1
    }
}

impl AsRef<TypedDB> for HyperlaneRocksDB {
    fn as_ref(&self) -> &TypedDB {
        &self.1
    }
}

impl AsRef<DB> for HyperlaneRocksDB {
    fn as_ref(&self) -> &DB {
        self.1.as_ref()
    }
}

impl HyperlaneRocksDB {
    /// Instantiated new `HyperlaneRocksDB`
    pub fn new(domain: &HyperlaneDomain, db: DB) -> Self {
        Self(domain.clone(), TypedDB::new(domain, db))
    }

    /// Get the domain this database is scoped to
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.0
    }

    /// Store a raw committed message
    ///
    /// Keys --> Values:
    /// - `nonce` --> `id`
    /// - `id` --> `message`
    /// - `nonce` --> `dispatched block number`
    fn store_message(
        &self,
        message: &HyperlaneMessage,
        dispatched_block_number: u64,
    ) -> DbResult<bool> {
        if let Ok(Some(_)) = self.message_id_by_nonce(message.nonce) {
            trace!(msg=?message, "Message already stored in db");
            return Ok(false);
        }

        let id = message.id();
        debug!(msg=?message,  "Storing new message in db",);

        // - `id` --> `message`
        self.store_keyed_encodable(MESSAGE, &id, message)?;
        // - `nonce` --> `id`
        self.store_keyed_encodable(MESSAGE_ID, &message.nonce, &id)?;
        // - `nonce` --> `dispatched block number`
        self.store_keyed_encodable(
            MESSAGE_DISPATCHED_BLOCK_NUMBER,
            &message.nonce,
            &dispatched_block_number,
        )?;
        Ok(true)
    }

    /// Retrieve a message by its id
    pub fn message_by_id(&self, id: H256) -> DbResult<Option<HyperlaneMessage>> {
        self.retrieve_keyed_decodable(MESSAGE, &id)
    }

    /// Retrieve the message id keyed by nonce
    pub fn message_id_by_nonce(&self, nonce: u32) -> DbResult<Option<H256>> {
        self.retrieve_keyed_decodable(MESSAGE_ID, &nonce)
    }

    /// Retrieve a message by its nonce
    pub fn message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>> {
        let id: Option<H256> = self.message_id_by_nonce(nonce)?;
        match id {
            None => Ok(None),
            Some(id) => self.message_by_id(id),
        }
    }

    // TODO(james): this is a quick-fix for the prover_sync and I don't like it
    /// poll db ever 100 milliseconds waiting for a leaf.
    pub fn wait_for_message_nonce(&self, nonce: u32) -> impl Future<Output = DbResult<H256>> {
        let slf = self.clone();
        async move {
            loop {
                if let Some(id) = slf.message_id_by_nonce(nonce)? {
                    return Ok(id);
                }
                sleep(Duration::from_millis(100)).await
            }
        }
    }

    /// Mark nonce as processed
    pub fn mark_nonce_as_processed(&self, nonce: u32) -> DbResult<()> {
        debug!(?nonce, "mark nonce as processed");
        self.store_keyed_encodable(NONCE_PROCESSED, &nonce, &true)
    }

    /// Retrieve nonce processed status
    pub fn retrieve_message_processed(&self, nonce: u32) -> Result<bool> {
        Ok(self
            .retrieve_keyed_decodable(NONCE_PROCESSED, &nonce)?
            .unwrap_or(false))
    }

    /// If the provided gas payment, identified by its metadata, has not been
    /// processed, processes the gas payment and records it as processed.
    /// Returns whether the gas payment was processed for the first time.
    pub fn process_gas_payment(
        &self,
        payment: InterchainGasPayment,
        log_meta: &LogMeta,
    ) -> DbResult<bool> {
        let payment_meta = log_meta.into();
        // If the gas payment has already been processed, do nothing
        if self.retrieve_gas_payment_meta_processed(&payment_meta)? {
            trace!(
                ?payment,
                ?log_meta,
                "Attempted to process an already-processed gas payment"
            );
            // Return false to indicate the gas payment was already processed
            return Ok(false);
        }
        // Set the gas payment as processed
        self.store_gas_payment_meta_processed(&payment_meta)?;

        // Update the total gas payment for the message to include the payment
        self.update_gas_payment_for_message_id(payment)?;

        // Return true to indicate the gas payment was processed for the first time
        Ok(true)
    }

    /// Processes the gas expenditure and store the total expenditure for the
    /// message.
    pub fn process_gas_expenditure(&self, expenditure: InterchainGasExpenditure) -> DbResult<()> {
        // Update the total gas expenditure for the message to include the payment
        self.update_gas_expenditure_for_message_id(expenditure)
    }

    /// Record a gas payment, identified by its metadata, as processed
    fn store_gas_payment_meta_processed(&self, meta: &InterchainGasPaymentMeta) -> DbResult<()> {
        self.store_keyed_encodable(GAS_PAYMENT_META_PROCESSED, meta, &true)
    }

    /// Get whether a gas payment, identified by its metadata, has been
    /// processed already
    fn retrieve_gas_payment_meta_processed(
        &self,
        meta: &InterchainGasPaymentMeta,
    ) -> DbResult<bool> {
        Ok(self
            .retrieve_keyed_decodable(GAS_PAYMENT_META_PROCESSED, meta)?
            .unwrap_or(false))
    }

    /// Update the total gas payment for a message to include gas_payment
    fn update_gas_payment_for_message_id(&self, event: InterchainGasPayment) -> DbResult<()> {
        let existing_payment = self.retrieve_gas_payment_for_message_id(event.message_id)?;
        let total = existing_payment + event;

        debug!(?event, new_total_gas_payment=?total, "Storing gas payment");
        self.store_keyed_encodable::<_, InterchainGasPaymentData>(
            GAS_PAYMENT_FOR_MESSAGE_ID,
            &total.message_id,
            &total.into(),
        )?;

        Ok(())
    }

    /// Update the total gas spent for a message
    fn update_gas_expenditure_for_message_id(
        &self,
        event: InterchainGasExpenditure,
    ) -> DbResult<()> {
        let existing_payment = self.retrieve_gas_expenditure_for_message_id(event.message_id)?;
        let total = existing_payment + event;

        debug!(?event, new_total_gas_payment=?total, "Storing gas payment");
        self.store_keyed_encodable::<_, InterchainGasExpenditureData>(
            GAS_EXPENDITURE_FOR_MESSAGE_ID,
            &total.message_id,
            &InterchainGasExpenditureData { tokens_used: total.tokens_used, gas_used: total.gas_used }
        )?;

        Ok(())
    }

    /// Retrieve the total gas payment for a message
    pub fn retrieve_gas_payment_for_message_id(
        &self,
        message_id: H256,
    ) -> DbResult<InterchainGasPayment> {
        Ok(self
            .retrieve_keyed_decodable::<_, InterchainGasPaymentData>(
                GAS_PAYMENT_FOR_MESSAGE_ID,
                &message_id,
            )?
            .unwrap_or_default()
            .complete(message_id))
    }

    /// Retrieve the total gas payment for a message
    pub fn retrieve_gas_expenditure_for_message_id(
        &self,
        message_id: H256,
    ) -> DbResult<InterchainGasExpenditure> {
        Ok(self
            .retrieve_keyed_decodable::<_, InterchainGasExpenditureData>(
                GAS_EXPENDITURE_FOR_MESSAGE_ID,
                &message_id,
            )?
            .unwrap_or_default()
            .complete(message_id))
    }
}

#[async_trait]
impl HyperlaneLogStore<HyperlaneMessage> for HyperlaneRocksDB {
    /// Store a list of dispatched messages and their associated metadata.
    async fn store_logs(&self, messages: &[(HyperlaneMessage, LogMeta)]) -> Result<u32> {
        let mut stored = 0;
        for (message, meta) in messages {
            let stored_message = self.store_message(message, meta.block_number)?;
            if stored_message {
                stored += 1;
            }
        }
        Ok(stored)
    }
}

#[async_trait]
impl HyperlaneLogStore<InterchainGasPayment> for HyperlaneRocksDB {
    /// Store a list of interchain gas payments and their associated metadata.
    async fn store_logs(&self, payments: &[(InterchainGasPayment, LogMeta)]) -> Result<u32> {
        let mut new = 0;
        for (payment, meta) in payments {
            if self.process_gas_payment(*payment, meta)? {
                new += 1;
            }
        }
        Ok(new)
    }
}

#[async_trait]
impl HyperlaneMessageStore for HyperlaneRocksDB {
    /// Gets a message by nonce.
    async fn retrieve_message_by_nonce(&self, nonce: u32) -> Result<Option<HyperlaneMessage>> {
        let message = self.message_by_nonce(nonce)?;
        Ok(message)
    }

    /// Retrieve dispatched block number by message nonce
    async fn retrieve_dispatched_block_number(&self, nonce: u32) -> Result<Option<u64>> {
        let number = self.retrieve_keyed_decodable(MESSAGE_DISPATCHED_BLOCK_NUMBER, &nonce)?;
        Ok(number)
    }
}

/// Note that for legacy reasons this watermark may be shared across multiple cursors, some of which may not have anything to do with gas payments
/// The high watermark cursor is relatively conservative in writing block numbers, so this shouldn't result in any events being missed.
#[async_trait]
impl<T> HyperlaneWatermarkedLogStore<T> for HyperlaneRocksDB
where
    HyperlaneRocksDB: HyperlaneLogStore<T>,
{
    /// Gets the block number high watermark
    async fn retrieve_high_watermark(&self) -> Result<Option<u32>> {
        let watermark = self.retrieve_decodable("", LATEST_INDEXED_GAS_PAYMENT_BLOCK)?;
        Ok(watermark)
    }
    /// Stores the block number high watermark
    async fn store_high_watermark(&self, block_number: u32) -> Result<()> {
        let result = self.store_encodable("", LATEST_INDEXED_GAS_PAYMENT_BLOCK, &block_number)?;
        Ok(result)
    }
}
