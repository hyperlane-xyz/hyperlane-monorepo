use std::io::Write;

use async_trait::async_trait;
use futures_util::FutureExt;

use hyperlane_base::db::{DbResult, HyperlaneRocksDB};
use hyperlane_core::{Encode, U256};

use crate::transaction::TransactionId;

const TX_ID_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX: &str = "tx_id_by_nonce_and_signer_address_";

#[async_trait]
pub trait NonceDb: Send + Sync {
    /// Retrieve a transaction ID by nonce and signer address.
    async fn retrieve_tx_id_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &str,
    ) -> DbResult<Option<TransactionId>>;

    // Store a transaction ID by nonce and signer address.
    async fn store_tx_id_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &str,
        tx_id: &TransactionId,
    ) -> DbResult<()>;
}

#[async_trait]
impl NonceDb for HyperlaneRocksDB {
    async fn retrieve_tx_id_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &str,
    ) -> DbResult<Option<TransactionId>> {
        self.retrieve_value_by_key(
            TX_ID_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX,
            &NonceAndSignerAddress(*nonce, signer_address.to_string()),
        )
    }

    async fn store_tx_id_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &str,
        tx_id: &TransactionId,
    ) -> DbResult<()> {
        self.store_value_by_key(
            TX_ID_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX,
            &NonceAndSignerAddress(*nonce, signer_address.to_string()),
            tx_id,
        )
    }
}

struct NonceAndSignerAddress(U256, String);

impl Encode for NonceAndSignerAddress {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        let (nonce, signer_address) = (self.0, &self.1);
        let vector = format!("{}:{}", nonce, signer_address).into_bytes();
        writer.write(&vector)
    }
}
