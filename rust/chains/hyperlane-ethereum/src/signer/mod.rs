use async_trait::async_trait;
use ethers::prelude::{Address, Signature};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::transaction::eip712::Eip712;
use ethers_signers::{AwsSigner, AwsSignerError, LocalWallet, Signer, WalletError};

use hyperlane_core::{
    HyperlaneSigner, HyperlaneSignerError, Signature as HyperlaneSignature, H160, H256,
};

mod singleton;
pub use singleton::*;

/// Ethereum-supported signer types
#[derive(Debug, Clone)]
pub enum Signers {
    /// A wallet instantiated with a locally stored private key
    Local(LocalWallet),
    /// A signer using a key stored in aws kms
    Aws(AwsSigner),
}

impl From<LocalWallet> for Signers {
    fn from(s: LocalWallet) -> Self {
        Signers::Local(s)
    }
}

impl From<AwsSigner> for Signers {
    fn from(s: AwsSigner) -> Self {
        Signers::Aws(s)
    }
}

#[async_trait]
impl Signer for Signers {
    type Error = SignersError;

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

    async fn sign_typed_data<T: Eip712 + Send + Sync>(
        &self,
        payload: &T,
    ) -> Result<Signature, Self::Error> {
        match self {
            Signers::Local(signer) => Ok(signer.sign_typed_data(payload).await?),
            Signers::Aws(signer) => Ok(signer.sign_typed_data(payload).await?),
        }
    }

    fn address(&self) -> Address {
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

    fn with_chain_id<T: Into<u64>>(self, chain_id: T) -> Self {
        match self {
            Signers::Local(signer) => signer.with_chain_id(chain_id).into(),
            Signers::Aws(signer) => signer.with_chain_id(chain_id).into(),
        }
    }
}

#[async_trait]
impl HyperlaneSigner for Signers {
    fn eth_address(&self) -> H160 {
        Signer::address(self).into()
    }

    async fn sign_hash(&self, hash: &H256) -> Result<HyperlaneSignature, HyperlaneSignerError> {
        let mut signature = Signer::sign_message(self, hash)
            .await
            .map_err(|err| HyperlaneSignerError::from(Box::new(err) as Box<_>))?;
        signature.v = 28 - (signature.v % 2);
        Ok(signature.into())
    }
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

impl From<std::convert::Infallible> for SignersError {
    fn from(_error: std::convert::Infallible) -> Self {
        panic!("infallible")
    }
}

#[cfg(test)]
mod test {
    use hyperlane_core::{
        Checkpoint, CheckpointWithMessageId, HyperlaneSigner, HyperlaneSignerExt, H256,
    };

    use super::Signers;

    #[test]
    fn it_sign() {
        let t = async {
            let signer: Signers =
                "1111111111111111111111111111111111111111111111111111111111111111"
                    .parse::<ethers::signers::LocalWallet>()
                    .unwrap()
                    .into();
            let message = CheckpointWithMessageId {
                checkpoint: Checkpoint {
                    merkle_tree_hook_address: H256::repeat_byte(2),
                    mailbox_domain: 5,
                    root: H256::repeat_byte(1),
                    index: 123,
                },
                message_id: H256::repeat_byte(3),
            };

            let signed = signer.sign(message).await.expect("!sign");
            assert!(signed.signature.v == 27 || signed.signature.v == 28);
            signed.verify(signer.eth_address()).expect("!verify");
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(t)
    }
}
