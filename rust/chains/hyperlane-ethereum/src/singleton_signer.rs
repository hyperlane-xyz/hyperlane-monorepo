use std::fmt;

use async_trait::async_trait;
use ethers::core::types::Signature;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use hyperlane_core::{HyperlaneSigner, HyperlaneSignerError, H160, H256};

use crate::Signers;

/// A callback to send the result of a signing operation
type Callback = oneshot::Sender<Result<Signature, HyperlaneSignerError>>;
/// A hash that needs to be signed with a callback to send the result
type SignTask = (H256, Callback);

/// A wrapper around a signer that uses channels to ensure that only one call is
/// made at a time. Mostly useful for the AWS signers.
pub struct SingletonSigner {
    inner: Signers,
    rx: mpsc::UnboundedReceiver<SignTask>,
}

impl fmt::Debug for SingletonSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("SingletonSigner").field(&self.inner).finish()
    }
}

/// A `HyperlaneSigner` which grants access to a singleton signer via a channel.
#[derive(Clone)]
pub struct SingletonSignerHandle {
    address: H160,
    tx: mpsc::UnboundedSender<SignTask>,
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
        let task = (*hash, tx);
        self.tx.send(task).map_err(SingletonSignerError::from)?;
        rx.await.map_err(SingletonSignerError::from)?
    }
}

impl SingletonSigner {
    /// Create a new singleton signer
    pub fn new(inner: Signers) -> (Self, SingletonSignerHandle) {
        let (tx, rx) = mpsc::unbounded_channel::<SignTask>();
        let address = inner.eth_address();
        (Self { inner, rx }, SingletonSignerHandle { address, tx })
    }

    /// Run this signer's event loop.
    pub async fn run(mut self) {
        while let Some((hash, tx)) = self.rx.recv().await {
            if tx.send(self.inner.sign_hash(&hash).await).is_err() {
                warn!(
                    "Failed to send signature back to the validator because the channel was closed"
                );
            }
        }
    }
}

/// An error incurred by the SingletonSigner signer
#[derive(Error, Debug)]
enum SingletonSignerError {
    #[error("Error sending task to singleton signer {0}")]
    ChannelSendError(#[from] mpsc::error::SendError<SignTask>),
    #[error("Error receiving response from singleton signer {0}")]
    ChannelRecvError(#[from] oneshot::error::RecvError),
}

impl From<SingletonSignerError> for HyperlaneSignerError {
    fn from(e: SingletonSignerError) -> Self {
        Self::from(Box::new(e) as Box<_>)
    }
}
