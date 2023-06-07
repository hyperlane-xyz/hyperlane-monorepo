use std::fmt;

use async_trait::async_trait;
use ethers_core::types::Signature;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use hyperlane_core::{HyperlaneSigner, HyperlaneSignerError, H160, H256};

use crate::Signers;

type Callback = oneshot::Sender<Result<Signature, HyperlaneSignerError>>;
type SignHashWithCallback = (H256, Callback);

/// A wrapper around a signer that uses channels to ensure that only one call is
/// made at a time. Mostly useful for the AWS signers.
pub struct SingletonSigner {
    inner: Signers,
    rx: mpsc::UnboundedReceiver<SignHashWithCallback>,
}

impl fmt::Debug for SingletonSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("SingletonSigner").field(&self.inner).finish()
    }
}

#[derive(Clone)]
pub struct SingletonSignerHandle {
    address: H160,
    tx: mpsc::UnboundedSender<SignHashWithCallback>,
}

impl fmt::Debug for SingletonSignerHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SingletonSignerHandle")
            .field("address", &self.address)
            .finish()
    }
}

#[async_trait]
impl HyperlaneSigner for SingletonSignerHandle {
    fn eth_address(&self) -> H160 {
        self.address
    }

    async fn sign_hash(&self, hash: &H256) -> Result<Signature, HyperlaneSignerError> {
        let (tx, rx) = oneshot::channel();
        let task = (hash.clone(), tx);
        self.tx.send(task).map_err(SingletonSignerError::from)?;
        rx.await.map_err(SingletonSignerError::from)?
    }
}

impl SingletonSigner {
    pub fn new(inner: Signers) -> (Self, SingletonSignerHandle) {
        let (tx, rx) = mpsc::unbounded_channel::<SignHashWithCallback>();
        let address = inner.eth_address();
        (Self { inner, rx }, SingletonSignerHandle { address, tx })
    }

    /// Run this signer's event loop.
    pub async fn run(mut self) {
        while let Some((hash, tx)) = self.rx.recv().await {
            if let Err(_) = tx.send(self.inner.sign_hash(&hash).await) {
                warn!(
                    "Failed to send signature back to the validator because the channel was closed"
                );
            }
        }
    }
}

#[derive(Error, Debug)]
enum SingletonSignerError {
    #[error("Error sending task to singleton signer {0}")]
    ChannelSendError(#[from] mpsc::error::SendError<SignHashWithCallback>),
    #[error("Error receiving response from singleton signer {0}")]
    ChannelRecvError(#[from] oneshot::error::RecvError),
}

impl From<SingletonSignerError> for HyperlaneSignerError {
    fn from(e: SingletonSignerError) -> Self {
        Self::from(Box::new(e) as Box<_>)
    }
}
