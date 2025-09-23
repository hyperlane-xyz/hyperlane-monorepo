//! Cryptographic primitives for sovereign rollups.
//!
//! Each sovereign rollup can use a custom cryptographic scheme,
//! but at the same time there is no API that provides information what scheme is used.
//!
//! This means that there is no way to tell how messages should be signed, in what format
//! should the public key be provided, or how to derive address from the public key.
//!
//! Currently there are two implementations in use:
//! - ed25519 based
//! - ethereum based
//!
//! and the only way to check which one rollup uses is to try them all and see which one
//! achieves a successful response from the rollup.
//!
//! In a future, the `Schema` from `sov-universal-wallet` may contain the necessary information
//! to choose the correct implementation during the runtime, however it's not available yet, and
//! not planned for a foreseeable future.

use std::sync::Arc;

use hyperlane_core::{ChainResult, H256};

pub mod ed25519;
pub mod ethereum;
pub mod sovereign;

/// Common methods for signers
pub trait Crypto: std::fmt::Debug {
    /// Sign provided message and return signature's bytes
    fn sign(&self, bytes: &[u8]) -> ChainResult<Vec<u8>>;

    /// Get public key bytes
    fn public_key(&self) -> Vec<u8>;

    /// Get the address is rollup's format
    fn address(&self) -> ChainResult<String>;

    /// Get the address in hyperlane format
    fn h256_address(&self) -> H256;
}

/// Signer for Sovereign chain.
#[derive(Clone, Debug)]
pub struct Signer {
    inner: Arc<dyn Crypto + Send + Sync>,
}

impl Signer {
    /// Create a new Sovereign signer.
    pub fn new(private_key: &H256, account_type: &str, hrp: Option<String>) -> ChainResult<Self> {
        let inner: Arc<dyn Crypto + Send + Sync> = match account_type {
            "solana" => Arc::new(ed25519::Signer::new(private_key)?),
            "ethereum" => Arc::new(ethereum::Signer::new(private_key)?),
            "sovereign" => Arc::new(sovereign::Signer::new(
                private_key,
                hrp.ok_or(custom_err!(
                    "HRP must be supplied for 'sovereign' accountTypes"
                ))?,
            )?),
            _ => {
                return Err(custom_err!(
                    "Invalid account type: {}, valid values: 'solana' | 'ethereum' | 'sovereign'",
                    account_type
                ))
            }
        };
        Ok(Self { inner })
    }
}

impl Crypto for Signer {
    fn sign(&self, bytes: &[u8]) -> ChainResult<Vec<u8>> {
        self.inner.sign(bytes)
    }

    fn public_key(&self) -> Vec<u8> {
        self.inner.public_key()
    }

    fn address(&self) -> ChainResult<String> {
        self.inner.address()
    }

    fn h256_address(&self) -> H256 {
        self.inner.h256_address()
    }
}
