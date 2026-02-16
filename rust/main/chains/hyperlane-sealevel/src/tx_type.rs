//! Transaction type abstraction for Sealevel chains.
//!
//! Some SVM chains (e.g., Solaxy) only support legacy transactions,
//! while others (Solana mainnet/testnet) support versioned transactions with ALTs.

use serde::{Deserialize, Serialize};
use solana_sdk::{
    hash::Hash,
    message::VersionedMessage,
    signature::Signature,
    transaction::{Transaction, VersionedTransaction},
};

/// Transaction type that can be either legacy or versioned.
///
/// - `Legacy`: Used for chains without ALT support (e.g., Eclipse)
/// - `Versioned`: Used for chains with ALT (Solana mainnet/testnet)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SealevelTxType {
    /// Legacy transaction format, compatible with all SVM chains.
    Legacy(Transaction),
    /// Versioned transaction format with ALT support, only for chains that support it.
    Versioned(VersionedTransaction),
}

impl SealevelTxType {
    /// Get the first signature from the transaction.
    pub fn signature(&self) -> Option<&Signature> {
        match self {
            SealevelTxType::Legacy(tx) => tx.signatures.first(),
            SealevelTxType::Versioned(tx) => tx.signatures.first(),
        }
    }

    /// Get the recent blockhash from the transaction.
    pub fn blockhash(&self) -> Hash {
        match self {
            SealevelTxType::Legacy(tx) => tx.message.recent_blockhash,
            SealevelTxType::Versioned(tx) => match &tx.message {
                VersionedMessage::Legacy(msg) => msg.recent_blockhash,
                VersionedMessage::V0(msg) => msg.recent_blockhash,
            },
        }
    }

    /// Check if this is a legacy transaction.
    pub fn is_legacy(&self) -> bool {
        matches!(self, SealevelTxType::Legacy(_))
    }

    /// Check if this is a versioned transaction.
    pub fn is_versioned(&self) -> bool {
        matches!(self, SealevelTxType::Versioned(_))
    }
}

impl From<Transaction> for SealevelTxType {
    fn from(tx: Transaction) -> Self {
        SealevelTxType::Legacy(tx)
    }
}

impl From<VersionedTransaction> for SealevelTxType {
    fn from(tx: VersionedTransaction) -> Self {
        SealevelTxType::Versioned(tx)
    }
}
