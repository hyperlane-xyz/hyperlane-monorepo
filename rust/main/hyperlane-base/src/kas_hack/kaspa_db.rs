use eyre::Result;
use tracing::debug;

use hyperlane_core::{Decode, Encode, HyperlaneDomain, HyperlaneMessage, H256};

use crate::db::{DbError, TypedDB, DB};

const KASPA_WITHDRAWAL_MESSAGE: &str = "kaspa_withdrawal_message_";
const KASPA_WITHDRAWAL_KASPA_TX: &str = "kaspa_withdrawal_kaspa_tx_";
const KASPA_DEPOSIT_MESSAGE: &str = "kaspa_deposit_message_";
const KASPA_DEPOSIT_MESSAGE_ID_BY_TX_HASH: &str = "kaspa_deposit_message_id_by_tx_hash_";
const KASPA_DEPOSIT_HUB_TX: &str = "kaspa_deposit_hub_tx_";

/// Rocks DB result type
pub type DbResult<T> = std::result::Result<T, DbError>;

/// DB handle for storing Kaspa-related data.
#[derive(Debug, Clone)]
pub struct KaspaRocksDB(TypedDB);

impl std::ops::Deref for KaspaRocksDB {
    type Target = TypedDB;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<TypedDB> for KaspaRocksDB {
    fn as_ref(&self) -> &TypedDB {
        &self.0
    }
}

impl AsRef<DB> for KaspaRocksDB {
    fn as_ref(&self) -> &DB {
        self.0.as_ref()
    }
}

impl KaspaRocksDB {
    /// Instantiated new `KaspaRocksDB`
    pub fn new(domain: &HyperlaneDomain, db: DB) -> Self {
        Self(TypedDB::new(domain, db))
    }

    /// Store a value by key
    pub fn store_value_by_key<K: Encode, V: Encode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: &K,
        value: &V,
    ) -> DbResult<()> {
        self.store_encodable(prefix, key.to_vec(), value)
    }

    /// Retrieve a value by key
    pub fn retrieve_value_by_key<K: Encode, V: Decode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: &K,
    ) -> DbResult<Option<V>> {
        self.retrieve_decodable(prefix, key.to_vec())
    }
}

// Implement the KaspaDb trait from hyperlane-core to allow dymension-kaspa
// to access kaspa_db functionality without creating circular dependencies
impl hyperlane_core::KaspaDb for KaspaRocksDB {
    fn store_withdrawal_message(&self, message: HyperlaneMessage) -> Result<()> {
        let id = message.id();
        debug!(
            message_id = ?id,
            nonce = message.nonce,
            "Storing Kaspa withdrawal"
        );
        self.store_value_by_key(KASPA_WITHDRAWAL_MESSAGE, &id, &message)?;
        Ok(())
    }

    fn retrieve_kaspa_withdrawal_by_message_id(
        &self,
        message_id: &H256,
    ) -> Result<Option<HyperlaneMessage>> {
        Ok(self.retrieve_value_by_key(KASPA_WITHDRAWAL_MESSAGE, message_id)?)
    }

    fn store_deposit_message(&self, message: HyperlaneMessage, kaspa_tx_id: String) -> Result<()> {
        let id = message.id();
        debug!(
            message_id = ?id,
            kaspa_tx_id = %kaspa_tx_id,
            nonce = message.nonce,
            "Storing Kaspa deposit"
        );
        // Store deposit message by message_id
        self.store_value_by_key(KASPA_DEPOSIT_MESSAGE, &id, &message)?;
        // Store mapping from tx_hash to message_id for retrieval by tx_hash
        self.store_encodable(
            KASPA_DEPOSIT_MESSAGE_ID_BY_TX_HASH,
            kaspa_tx_id.as_bytes(),
            &id,
        )?;
        Ok(())
    }

    fn retrieve_kaspa_deposit_by_message_id(
        &self,
        message_id: &H256,
    ) -> Result<Option<HyperlaneMessage>> {
        Ok(self.retrieve_value_by_key(KASPA_DEPOSIT_MESSAGE, message_id)?)
    }

    fn retrieve_kaspa_deposit_by_tx_hash(
        &self,
        hub_tx_id: &str,
    ) -> Result<Option<HyperlaneMessage>> {
        // First get the message_id from tx_hash (stored as bytes)
        let message_id: Option<H256> =
            self.retrieve_decodable(KASPA_DEPOSIT_MESSAGE_ID_BY_TX_HASH, hub_tx_id.as_bytes())?;

        match message_id {
            Some(id) => Ok(self.retrieve_value_by_key(KASPA_DEPOSIT_MESSAGE, &id)?),
            None => Ok(None),
        }
    }

    fn store_deposit_hub_tx(&self, kaspa_tx: &str, hub_tx: &H256) -> Result<()> {
        debug!(
            kaspa_tx = %kaspa_tx,
            hub_tx = %hub_tx,
            "Storing deposit Hub transaction ID"
        );
        self.store_encodable(KASPA_DEPOSIT_HUB_TX, kaspa_tx.as_bytes(), hub_tx)?;
        Ok(())
    }

    fn retrieve_deposit_hub_tx(&self, kaspa_tx_id: &str) -> Result<Option<H256>> {
        Ok(self.retrieve_decodable(KASPA_DEPOSIT_HUB_TX, kaspa_tx_id.as_bytes())?)
    }

    fn store_withdrawal_kaspa_tx(&self, message_id: &H256, kaspa_tx_id: &str) -> Result<()> {
        debug!(
            message_id = ?message_id,
            kaspa_tx = %kaspa_tx_id,
            "Storing withdrawal Kaspa transaction ID"
        );
        // Parse kaspa_tx as H256 and store
        let kaspa_tx_h256: H256 = kaspa_tx_id
            .parse()
            .map_err(|e| eyre::eyre!("Invalid kaspa_tx format: {}", e))?;
        self.store_value_by_key(KASPA_WITHDRAWAL_KASPA_TX, message_id, &kaspa_tx_h256)?;
        Ok(())
    }

    fn retrieve_withdrawal_kaspa_tx(&self, message_id: &H256) -> Result<Option<String>> {
        let kaspa_tx_h256: Option<H256> =
            self.retrieve_value_by_key(KASPA_WITHDRAWAL_KASPA_TX, message_id)?;
        Ok(kaspa_tx_h256.map(|h| format!("{:x}", h)))
    }

    fn update_processed_deposit(
        &self,
        kaspa_tx_id: &str,
        new_message: HyperlaneMessage,
        hub_tx: &H256,
    ) -> Result<()> {
        let new_message_id = new_message.id();
        debug!(
            new_message_id = ?new_message_id,
            kaspa_tx_id = %kaspa_tx_id,
            hub_tx = ?hub_tx,
            nonce = new_message.nonce,
            "Updating Kaspa deposit with new message and hub_tx"
        );

        // Store new deposit message by new message_id
        self.store_value_by_key(KASPA_DEPOSIT_MESSAGE, &new_message_id, &new_message)?;

        // Update mapping from kaspa_tx to new message_id (overwrites old mapping)
        self.store_encodable(
            KASPA_DEPOSIT_MESSAGE_ID_BY_TX_HASH,
            kaspa_tx_id.as_bytes(),
            &new_message_id,
        )?;

        // Store hub transaction ID
        self.store_encodable(KASPA_DEPOSIT_HUB_TX, kaspa_tx_id.as_bytes(), hub_tx)?;

        Ok(())
    }
}
