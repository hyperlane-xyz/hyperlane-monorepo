use crate::db::{DbError, TypedDB, DB};
use crate::{
    accumulator::merkle::Proof, AbacusMessage, InterchainGasPayment, InterchainGasPaymentMeta,
    InterchainGasPaymentWithMeta, RawAbacusMessage,
};
use ethers::core::types::{H256, U256};
use eyre::Result;
use tokio::time::sleep;
use tracing::{debug, info, trace};

use std::future::Future;
use std::time::Duration;


static MESSAGE_ID: &str = "message_id_";
static PROOF: &str = "proof_";
static MESSAGE: &str = "message_";
static LATEST_NONCE: &str = "latest_known_nonce_";
static LATEST_NONCE_FOR_DESTINATION: &str = "latest_known_nonce_for_destination_";
static NONCE_PROCESSED: &str = "nonce_processed_";
static GAS_PAYMENT_FOR_MESSAGE_ID: &str = "gas_payment_for_message_id_";
static GAS_PAYMENT_META_PROCESSED: &str = "gas_payment_meta_processed_";

/// DB handle for storing data tied to a specific Mailbox.
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
    pub fn store_messages(&self, messages: &[AbacusMessage]) -> Result<u32> {
        let mut latest_nonce: u32 = 0;
        for message in messages {
            self.store_latest_message(message)?;

            latest_nonce = message.nonce;
        }

        Ok(latest_nonce)
    }

    /// Store a raw committed message building off of the latest leaf index
    pub fn store_latest_message(&self, message: &AbacusMessage) -> Result<()> {
        // If this message is not building off the latest nonce, log it.
        if let Some(nonce) = self.retrieve_latest_nonce()? {
            if nonce != message.nonce - 1 {
                debug!(
                    "Attempted to store message not building off latest nonce. Latest nonce: {}. Message nonce: {}.",
                    nonce,
                    message.nonce,
                )
            }
        }

        self.store_message(message)
    }

    /// Store a raw committed message
    ///
    /// Keys --> Values:
    /// - `nonce` --> `id`
    /// - `id` --> `message`
    pub fn store_message(&self, message: &AbacusMessage) -> Result<()> {
        let id = message.id();

        info!(
            id = ?id,
            nonce = &message.nonce,
            origin = &message.origin,
            destination = &message.destination,
            "Storing new message in db.",
        );
        self.store_message_id(message.nonce, message.destination, id)?;
        self.store_keyed_encodable(MESSAGE, &id, message)?;
        Ok(())
    }

    /// Store the latest known nonce
    ///
    /// Key --> value: `LATEST_NONCE` --> `nonce`
    pub fn update_latest_nonce(&self, nonce: u32) -> Result<(), DbError> {
        if let Ok(Some(n)) = self.retrieve_latest_nonce() {
            if nonce <= n {
                return Ok(());
            }
        }
        self.store_encodable("", LATEST_NONCE, &nonce)
    }

    /// Retrieve the highest known nonce
    pub fn retrieve_latest_nonce(&self) -> Result<Option<u32>, DbError> {
        self.retrieve_decodable("", LATEST_NONCE)
    }

    /// Store the latest known nonce for a destination
    ///
    /// Key --> value: `destination` --> `nonce`
    pub fn update_latest_nonce_for_destination(
        &self,
        destination: u32,
        nonce: u32,
    ) -> Result<(), DbError> {
        if let Ok(Some(n)) = self.retrieve_latest_nonce_for_destination(destination) {
            if nonce <= n {
                return Ok(());
            }
        }
        self.store_keyed_encodable(LATEST_NONCE_FOR_DESTINATION, &destination, &nonce)
    }

    /// Retrieve the highest known nonce for a destination
    pub fn retrieve_latest_nonce_for_destination(
        &self,
        destination: u32,
    ) -> Result<Option<u32>, DbError> {
        self.retrieve_keyed_decodable(LATEST_NONCE_FOR_DESTINATION, &destination)
    }

    /// Store the message id keyed by nonce
    fn store_message_id(&self, nonce: u32, destination: u32, id: H256) -> Result<(), DbError> {
        debug!(
            nonce,
            id = ?id,
            "storing leaf hash keyed by index"
        );
        self.store_keyed_encodable(MESSAGE_ID, &nonce, &id)?;
        self.update_latest_nonce(nonce)?;
        self.update_latest_nonce_for_destination(destination, nonce)
    }

    /// Retrieve a message by its id
    pub fn message_by_id(&self, id: H256) -> Result<Option<RawAbacusMessage>, DbError> {
        self.retrieve_keyed_decodable(MESSAGE, &id)
    }

    /// Retrieve the message id keyed by nonce
    pub fn message_id_by_nonce(&self, nonce: u32) -> Result<Option<H256>, DbError> {
        self.retrieve_keyed_decodable(MESSAGE_ID, &nonce)
    }

    /// Retrieve a message by its nonce
    pub fn message_by_nonce(&self, nonce: u32) -> Result<Option<RawAbacusMessage>, DbError> {
        let id: Option<H256> = self.message_id_by_nonce(nonce)?;
        match id {
            None => Ok(None),
            Some(id) => self.message_by_id(id),
        }
    }

    /// Store a proof by its nonce
    ///
    /// Keys --> Values:
    /// - `nonce` --> `proof`
    pub fn store_proof(&self, nonce: u32, proof: &Proof) -> Result<(), DbError> {
        debug!(nonce, "storing proof in DB");
        self.store_keyed_encodable(PROOF, &nonce, proof)
    }

    /// Retrieve a proof by its nonce
    pub fn proof_by_nonce(&self, nonce: u32) -> Result<Option<Proof>, DbError> {
        self.retrieve_keyed_decodable(PROOF, &nonce)
    }

    // TODO(james): this is a quick-fix for the prover_sync and I don't like it
    /// poll db ever 100 milliseconds waitinf for a leaf.
    pub fn wait_for_message_id(&self, nonce: u32) -> impl Future<Output = Result<H256, DbError>> {
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
    pub fn mark_nonce_as_processed(&self, nonce: u32) -> Result<(), DbError> {
        debug!(nonce = ?nonce, "mark nonce as processed");
        self.store_keyed_encodable(NONCE_PROCESSED, &nonce, &true)
    }

    /// Retrieve nonce processed status
    pub fn retrieve_message_processed(&self, nonce: u32) -> Result<Option<bool>, DbError> {
        let value: Option<bool> = self.retrieve_keyed_decodable(NONCE_PROCESSED, &nonce)?;
        Ok(value)
    }

    /// If the provided gas payment, identified by its metadata, has not been processed,
    /// processes the gas payment and records it as processed.
    /// Returns whether the gas payment was processed for the first time.
    pub fn process_gas_payment(
        &self,
        gas_payment_with_meta: &InterchainGasPaymentWithMeta,
    ) -> Result<bool, DbError> {
        let meta = &gas_payment_with_meta.meta;
        // If the gas payment has already been processed, do nothing
        if self.retrieve_gas_payment_meta_processed(meta)? {
            trace!(gas_payment_with_meta=?gas_payment_with_meta, "Attempted to process an already-processed gas payment");
            // Return false to indicate the gas payment was already processed
            return Ok(false);
        }
        // Set the gas payment as processed
        self.store_gas_payment_meta_processed(meta)?;

        // Update the total gas payment for the message to include the payment
        self.update_gas_payment_for_message_id(&gas_payment_with_meta.payment)?;

        // Return true to indicate the gas payment was processed for the first time
        Ok(true)
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

    /// Update the total gas payment for a message to include gas_payment
    fn update_gas_payment_for_message_id(
        &self,
        gas_payment: &InterchainGasPayment,
    ) -> Result<(), DbError> {
        let InterchainGasPayment { message_id, amount } = gas_payment;
        let existing_payment = self.retrieve_gas_payment_for_message_id(*message_id)?;
        let total = existing_payment + amount;

        info!(message_id=?message_id, gas_payment_amount=?amount, new_total_gas_payment=?total, "Storing gas payment");
        self.store_keyed_encodable(GAS_PAYMENT_FOR_MESSAGE_ID, &gas_payment.message_id, &total)?;

        Ok(())
    }

    /// Retrieve the total gas payment for a message
    pub fn retrieve_gas_payment_for_message_id(&self, message_id: H256) -> Result<U256, DbError> {
        Ok(self
            .retrieve_keyed_decodable(GAS_PAYMENT_FOR_MESSAGE_ID, &message_id)?
            .unwrap_or(U256::zero()))
    }
}
