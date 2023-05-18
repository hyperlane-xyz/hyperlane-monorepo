use std::future::Future;
use std::time::Duration;

use tokio::time::sleep;
use tracing::{debug, trace};

use hyperlane_core::{
    HyperlaneDomain, HyperlaneMessage, InterchainGasExpenditure, InterchainGasPayment,
    InterchainGasPaymentMeta, LogMeta, H256, U256,
};

use super::{
    storage_types::{InterchainGasExpenditureData, InterchainGasPaymentData},
    DbError, TypedDB, DB,
};

// these keys MUST not be given multiple uses in case multiple agents are
// started with the same database and domain.

const MESSAGE_ID: &str = "message_id_";
const MESSAGE: &str = "message_";
const LATEST_NONCE: &str = "latest_known_nonce_";
const LATEST_NONCE_FOR_DESTINATION: &str = "latest_known_nonce_for_destination_";
const NONCE_PROCESSED: &str = "nonce_processed_";
const GAS_PAYMENT_FOR_MESSAGE_ID: &str = "gas_payment_for_message_id_v2_";
const GAS_PAYMENT_META_PROCESSED: &str = "gas_payment_meta_processed_v2_";
const GAS_EXPENDITURE_FOR_MESSAGE_ID: &str = "gas_expenditure_for_message_id_";

type Result<T> = std::result::Result<T, DbError>;

/// DB handle for storing data tied to a specific Mailbox.
#[derive(Debug, Clone)]
pub struct HyperlaneDB(HyperlaneDomain, TypedDB);

impl std::ops::Deref for HyperlaneDB {
    type Target = TypedDB;

    fn deref(&self) -> &Self::Target {
        &self.1
    }
}

impl AsRef<TypedDB> for HyperlaneDB {
    fn as_ref(&self) -> &TypedDB {
        &self.1
    }
}

impl AsRef<DB> for HyperlaneDB {
    fn as_ref(&self) -> &DB {
        self.1.as_ref()
    }
}

impl HyperlaneDB {
    /// Instantiated new `HyperlaneDB`
    pub fn new(domain: &HyperlaneDomain, db: DB) -> Self {
        Self(domain.clone(), TypedDB::new(domain, db))
    }

    /// Get the domain this database is scoped to
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.0
    }

    /// Store list of messages
    pub fn store_messages(&self, messages: &[HyperlaneMessage]) -> Result<u32> {
        let mut latest_nonce: u32 = 0;
        for message in messages {
            self.store_latest_message(message)?;

            latest_nonce = message.nonce;
        }

        Ok(latest_nonce)
    }

    /// Store a raw committed message building off of the latest nonce
    pub fn store_latest_message(&self, message: &HyperlaneMessage) -> Result<()> {
        // If this message is not building off the latest nonce, log it.
        if let Some(nonce) = self.retrieve_latest_nonce()? {
            if nonce != message.nonce - 1 {
                debug!(msg=%message, "Attempted to store message not building off latest nonce")
            }
        }

        self.store_message(message)
    }

    /// Store a raw committed message
    ///
    /// Keys --> Values:
    /// - `nonce` --> `id`
    /// - `id` --> `message`
    pub fn store_message(&self, message: &HyperlaneMessage) -> Result<()> {
        let id = message.id();

        debug!(msg=?message, "Storing new message in db",);
        self.store_message_id(message.nonce, message.destination, id)?;
        self.store_keyed_encodable(MESSAGE, &id, message)?;
        Ok(())
    }

    /// Store the latest known nonce
    ///
    /// Key --> value: `LATEST_NONCE` --> `nonce`
    pub fn update_latest_nonce(&self, nonce: u32) -> Result<()> {
        if let Ok(Some(n)) = self.retrieve_latest_nonce() {
            if nonce <= n {
                return Ok(());
            }
        }
        self.store_encodable("", LATEST_NONCE, &nonce)
    }

    /// Retrieve the highest known nonce
    pub fn retrieve_latest_nonce(&self) -> Result<Option<u32>> {
        self.retrieve_decodable("", LATEST_NONCE)
    }

    /// Store the latest known nonce for a destination
    ///
    /// Key --> value: `destination` --> `nonce`
    pub fn update_latest_nonce_for_destination(&self, destination: u32, nonce: u32) -> Result<()> {
        if let Ok(Some(n)) = self.retrieve_latest_nonce_for_destination(destination) {
            if nonce <= n {
                return Ok(());
            }
        }
        self.store_keyed_encodable(LATEST_NONCE_FOR_DESTINATION, &destination, &nonce)
    }

    /// Retrieve the highest known nonce for a destination
    pub fn retrieve_latest_nonce_for_destination(&self, destination: u32) -> Result<Option<u32>> {
        self.retrieve_keyed_decodable(LATEST_NONCE_FOR_DESTINATION, &destination)
    }

    /// Store the message id keyed by nonce
    fn store_message_id(&self, nonce: u32, destination: u32, id: H256) -> Result<()> {
        debug!(nonce, ?id, "storing leaf hash keyed by index");
        self.store_keyed_encodable(MESSAGE_ID, &nonce, &id)?;
        self.update_latest_nonce(nonce)?;
        self.update_latest_nonce_for_destination(destination, nonce)
    }

    /// Retrieve a message by its id
    pub fn message_by_id(&self, id: H256) -> Result<Option<HyperlaneMessage>> {
        self.retrieve_keyed_decodable(MESSAGE, &id)
    }

    /// Retrieve the message id keyed by nonce
    pub fn message_id_by_nonce(&self, nonce: u32) -> Result<Option<H256>> {
        self.retrieve_keyed_decodable(MESSAGE_ID, &nonce)
    }

    /// Retrieve a message by its nonce
    pub fn message_by_nonce(&self, nonce: u32) -> Result<Option<HyperlaneMessage>> {
        let id: Option<H256> = self.message_id_by_nonce(nonce)?;
        match id {
            None => Ok(None),
            Some(id) => self.message_by_id(id),
        }
    }

    // TODO(james): this is a quick-fix for the prover_sync and I don't like it
    /// poll db ever 100 milliseconds waiting for a leaf.
    pub fn wait_for_message_nonce(&self, nonce: u32) -> impl Future<Output = Result<H256>> {
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
    pub fn mark_nonce_as_processed(&self, nonce: u32) -> Result<()> {
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
    ) -> Result<bool> {
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
    pub fn process_gas_expenditure(&self, expenditure: InterchainGasExpenditure) -> Result<()> {
        // Update the total gas expenditure for the message to include the payment
        self.update_gas_expenditure_for_message_id(expenditure)
    }

    /// Record a gas payment, identified by its metadata, as processed
    fn store_gas_payment_meta_processed(&self, meta: &InterchainGasPaymentMeta) -> Result<()> {
        self.store_keyed_encodable(GAS_PAYMENT_META_PROCESSED, meta, &true)
    }

    /// Get whether a gas payment, identified by its metadata, has been
    /// processed already
    fn retrieve_gas_payment_meta_processed(&self, meta: &InterchainGasPaymentMeta) -> Result<bool> {
        Ok(self
            .retrieve_keyed_decodable(GAS_PAYMENT_META_PROCESSED, meta)?
            .unwrap_or(false))
    }

    /// Update the total gas payment for a message to include gas_payment
    fn update_gas_payment_for_message_id(&self, event: InterchainGasPayment) -> Result<()> {
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
    fn update_gas_expenditure_for_message_id(&self, event: InterchainGasExpenditure) -> Result<()> {
        let existing_payment = self.retrieve_gas_expenditure_for_message_id(event.message_id)?;
        let total = existing_payment + event;

        debug!(?event, new_total_gas_payment=?total, "Storing gas payment");
        self.store_keyed_encodable::<_, U256>(
            GAS_EXPENDITURE_FOR_MESSAGE_ID,
            &total.message_id,
            &total.tokens_used,
        )?;

        Ok(())
    }

    /// Retrieve the total gas payment for a message
    pub fn retrieve_gas_payment_for_message_id(
        &self,
        message_id: H256,
    ) -> Result<InterchainGasPayment> {
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
    ) -> Result<InterchainGasExpenditure> {
        Ok(self
            .retrieve_keyed_decodable::<_, InterchainGasExpenditureData>(
                GAS_EXPENDITURE_FOR_MESSAGE_ID,
                &message_id,
            )?
            .unwrap_or_default()
            .complete(message_id))
    }
}
