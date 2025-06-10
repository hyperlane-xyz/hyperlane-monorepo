#![allow(unused)]

use std::io::{Read, Write};

use async_trait::async_trait;
use ethers_core::k256::elliptic_curve::weierstrass::add;
use ethers_core::types::Address;
use futures_util::FutureExt;

use hyperlane_base::db::{DbResult, HyperlaneRocksDB};
use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, U256};

use crate::transaction::TransactionUuid;

use super::super::nonce::state::NonceStatus;

const NONCE_STATUS_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX: &str =
    "nonce_status_by_nonce_and_signer_address_";
const LOWEST_AVAILABLE_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX: &str =
    "lowest_available_nonce_by_signer_address_";
const UPPER_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX: &str =
    "upper_available_nonce_by_signer_address_";

#[async_trait]
pub trait NonceDb: Send + Sync {
    async fn retrieve_lowest_available_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>>;

    async fn store_lowest_available_nonce_by_signer_address(
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

    async fn retrieve_nonce_status_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &str,
    ) -> DbResult<Option<NonceStatus>>;

    async fn store_nonce_status_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &str,
        nonce_status: &NonceStatus,
    ) -> DbResult<()>;
}

#[async_trait]
impl NonceDb for HyperlaneRocksDB {
    async fn retrieve_lowest_available_nonce_by_signer_address(
        &self,
        signer_address: &Address,
    ) -> DbResult<Option<U256>> {
        self.retrieve_value_by_key(
            LOWEST_AVAILABLE_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX,
            &SignerAddress(*signer_address),
        )
    }

    async fn store_lowest_available_nonce_by_signer_address(
        &self,
        signer_address: &Address,
        nonce: &U256,
    ) -> DbResult<()> {
        self.store_value_by_key(
            LOWEST_AVAILABLE_NONCE_BY_SIGNER_ADDRESS_STORAGE_PREFIX,
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

    async fn retrieve_nonce_status_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &str,
    ) -> DbResult<Option<NonceStatus>> {
        self.retrieve_value_by_key(
            NONCE_STATUS_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX,
            &NonceAndSignerAddress(*nonce, signer_address.to_string()),
        )
    }

    async fn store_nonce_status_by_nonce_and_signer_address(
        &self,
        nonce: &U256,
        signer_address: &str,
        nonce_status: &NonceStatus,
    ) -> DbResult<()> {
        self.store_value_by_key(
            NONCE_STATUS_BY_NONCE_AND_SIGNER_ADDRESS_STORAGE_PREFIX,
            &NonceAndSignerAddress(*nonce, signer_address.to_string()),
            nonce_status,
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
