use std::io::{Read, Write};

use async_trait::async_trait;
use ethers_core::types::Address;
use futures_util::{FutureExt, StreamExt};

use hyperlane_base::db::{DbResult, HyperlaneRocksDB};
use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, U256};

use crate::transaction::TransactionUuid;

use super::super::nonce::status::NonceStatus;

const FINALIZED_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX: &str = "finalized_nonce_by_signer_address_";
const UPPER_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX: &str = "upper_nonce_by_signer_address_";
const TRANSACTION_UUID_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX: &str =
    "transaction_uuid_by_nonce_and_signer_address_";

#[async_trait]
pub trait NonceDb: Send + Sync {
    async fn retrieve_finalized_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>>;

    async fn store_finalized_nonce_by_signer_address(
        &self,
        signer_address: &Address,
        nonce: &U256,
    ) -> DbResult<()>;

    async fn retrieve_upper_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>>;

    async fn store_upper_nonce_by_signer_address(
        &self,
        signer_address: &Address,
        nonce: &U256,
    ) -> DbResult<()>;

    async fn retrieve_transaction_uuid_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &Address,
    ) -> DbResult<Option<TransactionUuid>>;

    async fn store_transaction_uuid_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &Address,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()>;
}

#[async_trait]
impl NonceDb for HyperlaneRocksDB {
    async fn retrieve_finalized_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>> {
        self.retrieve_value_by_key(
            FINALIZED_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX,
            &SignerAddress(*signer_address),
        )
    }

    async fn store_finalized_nonce_by_signer_address(
        &self,
        signer_address: &Address,
        nonce: &U256,
    ) -> DbResult<()> {
        self.store_value_by_key(
            FINALIZED_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX,
            &SignerAddress(*signer_address),
            nonce,
        )
    }

    async fn retrieve_upper_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>> {
        self.retrieve_value_by_key(
            UPPER_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX,
            &SignerAddress(*signer_address),
        )
    }

    async fn store_upper_nonce_by_signer_address(
        &self,
        signer_address: &Address,
        nonce: &U256,
    ) -> DbResult<()> {
        self.store_value_by_key(
            UPPER_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX,
            &SignerAddress(*signer_address),
            nonce,
        )
    }

    async fn retrieve_transaction_uuid_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &Address,
    ) -> DbResult<Option<TransactionUuid>> {
        self.retrieve_value_by_key(
            TRANSACTION_UUID_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX,
            &NonceAndSignerAddress(*nonce, *signer_address),
        )
    }

    async fn store_transaction_uuid_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &Address,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()> {
        self.store_value_by_key(
            TRANSACTION_UUID_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX,
            &NonceAndSignerAddress(*nonce, *signer_address),
            tx_uuid,
        )
    }
}

struct SignerAddress(Address);

impl Encode for SignerAddress {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        let address = self.0;
        writer.write(&address.0)
    }
}

struct NonceAndSignerAddress(U256, Address);

impl Encode for NonceAndSignerAddress {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        let (nonce, address) = (self.0, SignerAddress(self.1));

        let mut written = nonce.write_to(writer)?;
        written += address.write_to(writer)?;
        Ok(written)
    }
}

#[cfg(test)]
mod tests;
