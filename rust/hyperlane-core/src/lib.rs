//! This crate contains core primitives, traits, and types for Hyperlane
//! implementations.

#![warn(missing_docs)]
#![warn(unused_extern_crates)]
#![forbid(unsafe_code)]
#![forbid(where_clauses_object_safety)]

/// Accumulator management
pub mod accumulator;

/// Async Traits for contract instances for use in applications
mod traits;
use ethers_signers::WalletError;
pub use traits::*;

/// Utilities to match contract values
pub mod utils;

/// Testing utilities
pub mod test_utils;

/// Core hyperlane system data structures
mod types;
pub use types::*;

/// DB related utilities
pub mod db;

/// Test functions that output json files for Solidity tests
#[cfg(feature = "output")]
pub mod test_output;

mod chain;
pub use chain::*;

use std::convert::Infallible;

pub use identifiers::HyperlaneIdentifier;

use async_trait::async_trait;
use ethers::{
    core::types::{
        transaction::{eip2718::TypedTransaction, eip712::Eip712},
        Address as EthAddress, Signature, SignatureError,
    },
    prelude::AwsSigner,
    signers::{AwsSignerError, LocalWallet, Signer},
};

/// Enum for validity of a list of messages
#[derive(Debug)]
pub enum ListValidity {
    /// Empty list
    Empty,
    /// Valid list
    Valid,
    /// Invalid list. Does not build upon the correct prior element.
    InvalidContinuation,
    /// Invalid list. Contains gaps, but builds upon the correct prior element.
    ContainsGaps,
}

/// Error types for Hyperlane
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneError {
    /// Signature Error pasthrough
    #[error(transparent)]
    SignatureError(#[from] SignatureError),
    /// IO error from Read/Write usage
    #[error(transparent)]
    IoError(#[from] std::io::Error),
}

/// Error types for Signers
#[derive(Debug, thiserror::Error)]
pub enum SignersError {
    /// AWS Signer Error
    #[error("{0}")]
    AwsSignerError(#[from] AwsSignerError),
    /// Wallet Signer Error
    #[error("{0}")]
    WalletError(#[from] WalletError),
}

impl From<Infallible> for SignersError {
    fn from(_error: Infallible) -> Self {
        panic!("infallible")
    }
}

/// Ethereum-supported signer types
#[derive(Debug, Clone)]
pub enum Signers {
    /// A wallet instantiated with a locally stored private key
    Local(LocalWallet),
    /// A signer using a key stored in aws kms
    Aws(AwsSigner<'static>),
}

impl From<LocalWallet> for Signers {
    fn from(s: LocalWallet) -> Self {
        Signers::Local(s)
    }
}

impl From<AwsSigner<'static>> for Signers {
    fn from(s: AwsSigner<'static>) -> Self {
        Signers::Aws(s)
    }
}

#[async_trait]
impl Signer for Signers {
    type Error = SignersError;

    fn with_chain_id<T: Into<u64>>(self, chain_id: T) -> Self {
        match self {
            Signers::Local(signer) => signer.with_chain_id(chain_id).into(),
            Signers::Aws(signer) => signer.with_chain_id(chain_id).into(),
        }
    }

    async fn sign_message<S: Send + Sync + AsRef<[u8]>>(
        &self,
        message: S,
    ) -> Result<Signature, Self::Error> {
        match self {
            Signers::Local(signer) => Ok(signer.sign_message(message).await?),
            Signers::Aws(signer) => Ok(signer.sign_message(message).await?),
        }
    }

    async fn sign_transaction(&self, message: &TypedTransaction) -> Result<Signature, Self::Error> {
        match self {
            Signers::Local(signer) => Ok(signer.sign_transaction(message).await?),

            Signers::Aws(signer) => Ok(signer.sign_transaction(message).await?),
        }
    }

    fn address(&self) -> EthAddress {
        match self {
            Signers::Local(signer) => signer.address(),
            Signers::Aws(signer) => signer.address(),
        }
    }

    fn chain_id(&self) -> u64 {
        match self {
            Signers::Local(signer) => signer.chain_id(),
            Signers::Aws(signer) => signer.chain_id(),
        }
    }

    async fn sign_typed_data<T: Eip712 + Send + Sync>(
        &self,
        payload: &T,
    ) -> Result<Signature, Self::Error> {
        match self {
            Signers::Local(signer) => Ok(signer.sign_typed_data(payload).await?),
            Signers::Aws(signer) => Ok(signer.sign_typed_data(payload).await?),
        }
    }
}

#[async_trait]
trait SignerExt: Signer {
    async fn sign_message_without_eip_155<S: Send + Sync + AsRef<[u8]>>(
        &self,
        message: S,
    ) -> Result<Signature, <Self as Signer>::Error> {
        let mut signature = self.sign_message(message).await?;
        signature.v = 28 - (signature.v % 2);
        Ok(signature)
    }
}

impl<T> SignerExt for T where T: Signer {}

#[cfg(test)]
mod test {
    use super::*;

    use ethers::core::types::H256;

    #[test]
    fn it_sign() {
        let t = async {
            let signer: ethers::signers::LocalWallet =
                "1111111111111111111111111111111111111111111111111111111111111111"
                    .parse()
                    .unwrap();
            let message = Checkpoint {
                mailbox_address: H256::repeat_byte(2),
                mailbox_domain: 5,
                root: H256::repeat_byte(1),
                index: 123,
            };

            let signed = message.sign_with(&signer).await.expect("!sign_with");
            assert!(signed.signature.v == 27 || signed.signature.v == 28);
            signed.verify(signer.address()).expect("!verify");
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(t)
    }
}
