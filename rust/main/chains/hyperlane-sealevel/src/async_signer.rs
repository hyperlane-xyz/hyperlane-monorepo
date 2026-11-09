//! Async Sealevel signing without requiring a locally exportable private key.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use ed25519_dalek::VerifyingKey;
use solana_sdk::{
    message::VersionedMessage,
    pubkey::Pubkey,
    signature::Signature,
    signer::{Signer, SignerError},
};

use crate::SealevelKeypair;

pub use gcp::{GcpSealevelSigner, GcpSealevelSignerError};

mod gcp;

/// A local keypair or a remote Ed25519 signer with a cached public key.
#[derive(Clone, Debug)]
pub enum SealevelSigner {
    /// A locally configured keypair, shared without copying its private bytes.
    Local(Arc<SealevelKeypair>),
    /// A GCP Cloud KMS SOFTWARE Ed25519 crypto key version.
    Gcp(Arc<GcpSealevelSigner>),
}

/// Failures preparing or signing a Sealevel transaction.
#[derive(Debug, thiserror::Error)]
pub enum SealevelSignerError {
    /// A local signer failed.
    #[error("Local Sealevel signing failed: {0}")]
    Local(#[from] SignerError),
    /// The remote signer failed its request or integrity checks.
    #[error(transparent)]
    Gcp(#[from] GcpSealevelSignerError),
    /// The message does not contain a valid nonempty static signer prefix.
    #[error("Invalid required signer prefix in Sealevel message")]
    InvalidRequiredSigners,
    /// The explicitly supplied payer is not the message's first signer.
    #[error("Sealevel fee payer mismatch: expected {expected}, got {actual}")]
    InvalidFeePayer {
        /// Fee payer encoded in the message.
        expected: Pubkey,
        /// Fee payer supplied by the caller.
        actual: Pubkey,
    },
    /// A required signer was omitted.
    #[error("Missing required Sealevel signer {0}")]
    MissingSigner(Pubkey),
    /// A supplied signer is not required by the message.
    #[error("Unexpected Sealevel signer {0}")]
    UnexpectedSigner(Pubkey),
    /// A signer was supplied more than once or repeated in the signer prefix.
    #[error("Duplicate Sealevel signer {0}")]
    DuplicateSigner(Pubkey),
}

impl From<SealevelKeypair> for SealevelSigner {
    fn from(keypair: SealevelKeypair) -> Self {
        Self::Local(Arc::new(keypair))
    }
}

impl Default for SealevelSigner {
    fn default() -> Self {
        Self::from(SealevelKeypair::default())
    }
}

impl SealevelSigner {
    /// Returns the cached public key without making an RPC request.
    pub fn pubkey(&self) -> Pubkey {
        match self {
            Self::Local(keypair) => keypair.pubkey(),
            Self::Gcp(signer) => signer.pubkey(),
        }
    }

    /// Signs the exact message bytes using PureEdDSA, without prehashing them.
    pub async fn sign_message(&self, message: &[u8]) -> Result<Signature, SealevelSignerError> {
        match self {
            Self::Local(keypair) => Ok(keypair.try_sign_message(message)?),
            Self::Gcp(signer) => Ok(signer.sign_message(message).await?),
        }
    }
}

fn verify_signature(pubkey: &Pubkey, message: &[u8], signature: &Signature) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(&pubkey.to_bytes()) else {
        return false;
    };
    let Ok(signature) = ed25519_dalek::Signature::from_slice(signature.as_ref()) else {
        return false;
    };
    key.verify_strict(message, &signature).is_ok()
}

/// Signs a legacy or v0 message in its required static-account-key order.
/// All payer/co-signer validation finishes before the first remote request.
pub(crate) async fn transaction_signatures(
    message: &VersionedMessage,
    payer: &SealevelSigner,
    additional_signers: &[&SealevelSigner],
) -> Result<Vec<Signature>, SealevelSignerError> {
    let required_count = usize::from(message.header().num_required_signatures);
    let required_keys = message
        .static_account_keys()
        .get(..required_count)
        .ok_or(SealevelSignerError::InvalidRequiredSigners)?;
    let expected_payer = required_keys
        .first()
        .ok_or(SealevelSignerError::InvalidRequiredSigners)?;
    if *expected_payer != payer.pubkey() {
        return Err(SealevelSignerError::InvalidFeePayer {
            expected: *expected_payer,
            actual: payer.pubkey(),
        });
    }
    let mut required = HashSet::with_capacity(required_count);
    for pubkey in required_keys {
        if !required.insert(*pubkey) {
            return Err(SealevelSignerError::DuplicateSigner(*pubkey));
        }
    }

    let mut signers = HashMap::with_capacity(required_count);
    for signer in std::iter::once(payer).chain(additional_signers.iter().copied()) {
        let pubkey = signer.pubkey();
        if !required.contains(&pubkey) {
            return Err(SealevelSignerError::UnexpectedSigner(pubkey));
        }
        if signers.insert(pubkey, signer).is_some() {
            return Err(SealevelSignerError::DuplicateSigner(pubkey));
        }
    }

    let mut ordered_signers = Vec::with_capacity(required_count);
    for key in required_keys {
        let signer = signers
            .remove(key)
            .ok_or(SealevelSignerError::MissingSigner(*key))?;
        ordered_signers.push(signer);
    }

    let serialized = message.serialize();
    let mut signatures = Vec::with_capacity(required_count);
    for signer in ordered_signers {
        signatures.push(signer.sign_message(&serialized).await?);
    }
    Ok(signatures)
}

#[cfg(test)]
mod tests {
    use solana_sdk::{
        hash::Hash,
        instruction::{AccountMeta, Instruction},
        message::{v0, Message},
        signature::Keypair,
        transaction::{Transaction, VersionedTransaction},
    };

    use super::*;

    #[tokio::test]
    async fn local_signing_matches_solana_for_legacy_and_v0() {
        let payer_key = Arc::new(SealevelKeypair::default());
        let co_signer_key = Arc::new(SealevelKeypair::default());
        let payer = SealevelSigner::Local(payer_key.clone());
        let co_signer = SealevelSigner::Local(co_signer_key.clone());
        let instruction = Instruction::new_with_bytes(
            Pubkey::new_unique(),
            &[1, 2, 3],
            vec![AccountMeta::new_readonly(co_signer.pubkey(), true)],
        );
        let blockhash = Hash::new_unique();
        let legacy =
            Message::new_with_blockhash(&[instruction.clone()], Some(&payer.pubkey()), &blockhash);
        let versioned =
            v0::Message::try_compile(&payer.pubkey(), &[instruction], &[], blockhash).unwrap();
        let local_signers = [payer_key.keypair(), co_signer_key.keypair()];

        let expected = Transaction::new(&local_signers, legacy.clone(), blockhash);
        assert_eq!(
            transaction_signatures(&VersionedMessage::Legacy(legacy), &payer, &[&co_signer])
                .await
                .unwrap(),
            expected.signatures,
        );
        let message = VersionedMessage::V0(versioned);
        let expected = VersionedTransaction::try_new(message.clone(), &local_signers).unwrap();
        assert_eq!(
            transaction_signatures(&message, &payer, &[&co_signer])
                .await
                .unwrap(),
            expected.signatures
        );
    }

    #[tokio::test]
    async fn matches_required_order_instead_of_supplied_signer_order() {
        let payer = SealevelSigner::from(SealevelKeypair::default());
        let first = SealevelSigner::from(SealevelKeypair::default());
        let second = SealevelSigner::from(SealevelKeypair::default());
        let instruction = Instruction::new_with_bytes(
            Pubkey::new_unique(),
            &[],
            vec![
                AccountMeta::new_readonly(first.pubkey(), true),
                AccountMeta::new_readonly(second.pubkey(), true),
            ],
        );
        let message = VersionedMessage::Legacy(Message::new(&[instruction], Some(&payer.pubkey())));
        let signatures = transaction_signatures(&message, &payer, &[&second, &first])
            .await
            .unwrap();
        for (key, signature) in message.static_account_keys().iter().zip(signatures) {
            assert!(verify_signature(key, &message.serialize(), &signature));
        }
    }

    #[tokio::test]
    async fn rejects_missing_duplicate_unexpected_and_wrong_payer_signers() {
        let payer = SealevelSigner::from(SealevelKeypair::default());
        let co_signer = SealevelSigner::from(SealevelKeypair::default());
        let unrelated = SealevelSigner::from(SealevelKeypair::new(Keypair::new()));
        let instruction = Instruction::new_with_bytes(
            Pubkey::new_unique(),
            &[],
            vec![AccountMeta::new_readonly(co_signer.pubkey(), true)],
        );
        let message = VersionedMessage::Legacy(Message::new(&[instruction], Some(&payer.pubkey())));
        assert!(matches!(
            transaction_signatures(&message, &payer, &[]).await,
            Err(SealevelSignerError::MissingSigner(_))
        ));
        assert!(matches!(
            transaction_signatures(&message, &payer, &[&payer, &co_signer]).await,
            Err(SealevelSignerError::DuplicateSigner(_))
        ));
        assert!(matches!(
            transaction_signatures(&message, &payer, &[&unrelated, &co_signer]).await,
            Err(SealevelSignerError::UnexpectedSigner(_))
        ));
        assert!(matches!(
            transaction_signatures(&message, &co_signer, &[&payer]).await,
            Err(SealevelSignerError::InvalidFeePayer { .. })
        ));
    }
}
