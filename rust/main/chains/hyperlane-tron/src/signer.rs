use ethers::prelude::{Address, Signature};
use ethers::types::U256;
use ethers_signers::{AwsSigner, AwsSignerError, LocalWallet, Signer, WalletError};

use ethers::core::k256::{
    ecdsa::{
        recoverable::{Id as RecoveryId, Signature as RecoverableSignature},
        Signature as K256Signature, VerifyingKey,
    },
    elliptic_curve::FieldBytes,
    Secp256k1,
};

use hyperlane_core::H256;

/// Tron signer types — mirrors `hyperlane_ethereum::Signers`
#[derive(Debug, Clone)]
pub enum TronSigners {
    /// A wallet instantiated with a locally stored private key
    Local(LocalWallet),
    /// A signer using a key stored in AWS KMS
    Aws(AwsSigner),
}

/// Error types for TronSigners
#[derive(Debug, thiserror::Error)]
pub enum TronSignersError {
    /// AWS Signer Error
    #[error("{0}")]
    AwsSignerError(Box<AwsSignerError>),
    /// Wallet Signer Error
    #[error("{0}")]
    WalletError(#[from] WalletError),
    /// Recovery ID trial recovery failed
    #[error("Failed to recover signing key from AWS KMS signature")]
    RecoveryFailed,
}

impl From<AwsSignerError> for TronSignersError {
    fn from(e: AwsSignerError) -> Self {
        TronSignersError::AwsSignerError(Box::new(e))
    }
}

impl From<LocalWallet> for TronSigners {
    fn from(wallet: LocalWallet) -> Self {
        TronSigners::Local(wallet)
    }
}

impl From<ethers::core::k256::ecdsa::SigningKey> for TronSigners {
    fn from(key: ethers::core::k256::ecdsa::SigningKey) -> Self {
        TronSigners::Local(LocalWallet::from(key))
    }
}

impl TronSigners {
    /// Get the Ethereum-style address of this signer
    pub fn address(&self) -> Address {
        match self {
            TronSigners::Local(wallet) => wallet.address(),
            TronSigners::Aws(signer) => signer.address(),
        }
    }

    /// Sign a pre-hashed digest. Returns an ethers `Signature` with `v = 27 + recovery_id`.
    ///
    /// For local wallets this is synchronous internally.
    /// For AWS KMS this performs an async signing call + trial recovery.
    pub async fn sign_hash(&self, hash: H256) -> Result<Signature, TronSignersError> {
        match self {
            TronSigners::Local(wallet) => Ok(wallet.sign_hash(hash.into())),
            TronSigners::Aws(signer) => {
                let digest: [u8; 32] = hash.into();
                let k256_sig: K256Signature = signer.sign_digest(digest).await?;

                let vk = signer.get_pubkey().await?;
                let rsig = rsig_from_digest_bytes_trial_recovery(&k256_sig, digest, &vk)?;

                let v: u8 = rsig.recovery_id().into();
                // v is 0 or 1, so 27 + v cannot overflow u64
                let v = u64::from(v).saturating_add(27);
                let r_bytes: FieldBytes<Secp256k1> = rsig.r().into();
                let s_bytes: FieldBytes<Secp256k1> = rsig.s().into();
                let r = U256::from_big_endian(r_bytes.as_slice());
                let s = U256::from_big_endian(s_bytes.as_slice());

                Ok(Signature { r, s, v })
            }
        }
    }
}

/// Recover a recoverable signature by trial recovery with both possible recovery IDs
fn rsig_from_digest_bytes_trial_recovery(
    sig: &K256Signature,
    digest: [u8; 32],
    vk: &VerifyingKey,
) -> Result<RecoverableSignature, TronSignersError> {
    for id in 0u8..2 {
        // unwrap is safe: RecoveryId::new only fails for id >= 2
        let recovery_id = RecoveryId::new(id).expect("valid recovery id");
        if let Ok(rsig) = RecoverableSignature::new(sig, recovery_id) {
            if let Ok(recovered_key) =
                rsig.recover_verifying_key_from_digest_bytes(digest.as_ref().into())
            {
                if recovered_key == *vk {
                    return Ok(rsig);
                }
            }
        }
    }
    Err(TronSignersError::RecoveryFailed)
}
