use std::fmt;

use async_trait::async_trait;
use ethers::core::types::Signature;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use hyperlane_core::{
    HyperlaneSigner, HyperlaneSignerError, Signature as HyperlaneSignature, H160, H256,
};

use crate::Signers;

/// A callback to send the result of a signing operation
type Callback = oneshot::Sender<Result<Signature, HyperlaneSignerError>>;
/// A hash that needs to be signed with a callback to send the result
type SignTask = (H256, Callback);

/// A wrapper around a signer that uses channels to ensure that only one call is
/// made at a time. Mostly useful for the AWS signers.
pub struct SingletonSigner {
    inner: Signers,
    retries: usize,
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

#[cfg(feature = "test-utils")]
impl SingletonSignerHandle {
    /// Create a new handle for testing purposes
    pub fn new(address: H160, tx: mpsc::UnboundedSender<SignTask>) -> Self {
        Self { address, tx }
    }
}

impl fmt::Debug for SingletonSignerHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("SingletonSignerHandle")
            .field(&self.address)
            .finish()
    }
}

#[async_trait]
impl HyperlaneSigner for SingletonSignerHandle {
    fn eth_address(&self) -> H160 {
        self.address
    }

    async fn sign_hash(&self, hash: &H256) -> Result<HyperlaneSignature, HyperlaneSignerError> {
        let (tx, rx) = oneshot::channel();
        let task = (*hash, tx);
        self.tx.send(task).map_err(SingletonSignerError::from)?;
        match rx.await {
            Ok(res) => res.map(Into::into),
            Err(err) => Err(SingletonSignerError::from(err).into()),
        }
    }
}

impl SingletonSigner {
    /// Create a new singleton signer
    pub fn new(inner: Signers) -> (Self, SingletonSignerHandle) {
        let (tx, rx) = mpsc::unbounded_channel::<SignTask>();
        let address = inner.eth_address();
        (
            Self {
                inner,
                rx,
                retries: 5,
            },
            SingletonSignerHandle { address, tx },
        )
    }

    /// Change default (5) retries for signing
    pub fn config_retries(&mut self, retries: usize) {
        self.retries = retries;
    }

    /// Run this signer's event loop.
    pub async fn run(self) {
        Self::run_with_signer(self.inner, self.retries, self.rx).await;
    }

    async fn run_with_signer(
        inner: impl HyperlaneSigner,
        retry_limit: usize,
        mut rx: mpsc::UnboundedReceiver<SignTask>,
    ) {
        while let Some((hash, mut tx)) = rx.recv().await {
            let mut retries = retry_limit;
            let res = loop {
                // A validator reorg drops the waiting receiver. Check before
                // each attempt and cancel pending requests instead of continuing
                // to sign queued hashes or retrying after their caller halts.
                let result = tokio::select! {
                    biased;
                    _ = tx.closed() => break None,
                    result = inner.sign_hash(&hash) => result,
                };
                match result {
                    Ok(res) => break Some(Ok(res)),
                    Err(err) => {
                        warn!("Error signing hash: {}", err);
                        if retries == 0 {
                            break Some(Err(err));
                        }
                        retries = retries.saturating_sub(1);
                    }
                }
            };
            let Some(res) = res else { continue };
            if tx.send(res.map(Into::into)).is_err() {
                warn!(
                    "Failed to send signature back to the signer handle because the channel was closed"
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };
    use tokio::sync::Notify;

    #[derive(Debug, Default)]
    struct SignState {
        calls: AtomicUsize,
        started: Notify,
        cancelled: Notify,
        close_receiver: Mutex<Option<oneshot::Receiver<Result<Signature, HyperlaneSignerError>>>>,
    }

    #[derive(Debug)]
    struct TestSigner {
        state: Arc<SignState>,
        pending: bool,
    }

    struct PendingSign(Arc<SignState>);
    impl Drop for PendingSign {
        fn drop(&mut self) {
            self.0.cancelled.notify_one();
        }
    }

    #[async_trait]
    impl HyperlaneSigner for TestSigner {
        fn eth_address(&self) -> H160 {
            H160::zero()
        }
        async fn sign_hash(&self, _: &H256) -> Result<HyperlaneSignature, HyperlaneSignerError> {
            self.state.calls.fetch_add(1, Ordering::SeqCst);
            self.state.started.notify_one();
            if self.pending {
                let _cancel = PendingSign(self.state.clone());
                std::future::pending().await
            } else {
                drop(
                    self.state
                        .close_receiver
                        .lock()
                        .expect("receiver lock")
                        .take(),
                );
                Err(HyperlaneSignerError::from(
                    Box::new(std::io::Error::other("signer unavailable"))
                        as Box<dyn std::error::Error + Send + Sync>,
                ))
            }
        }
    }

    #[tokio::test]
    async fn singleton_skips_cancelled_queue_and_cancels_pending_signing() {
        let state = Arc::new(SignState::default());
        let (tx, rx) = mpsc::unbounded_channel();
        for _ in 0..3 {
            let (callback, response) = oneshot::channel();
            tx.send((H256::zero(), callback))
                .expect("queue cancelled signing request");
            drop(response);
        }
        let (callback, response) = oneshot::channel();
        tx.send((H256::zero(), callback))
            .expect("queue pending signing request");
        drop(tx);
        let runner = tokio::spawn(SingletonSigner::run_with_signer(
            TestSigner {
                state: state.clone(),
                pending: true,
            },
            5,
            rx,
        ));
        state.started.notified().await;
        assert_eq!(state.calls.load(Ordering::SeqCst), 1);
        drop(response);
        tokio::time::timeout(Duration::from_secs(1), state.cancelled.notified())
            .await
            .expect("pending signer future must be dropped");
        tokio::time::timeout(Duration::from_secs(1), runner)
            .await
            .expect("cancelled queue must drain")
            .expect("signer runner");
        assert_eq!(state.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn singleton_stops_retries_when_waiter_closes() {
        for cancel in [false, true] {
            let state = Arc::new(SignState::default());
            let (tx, rx) = mpsc::unbounded_channel();
            let (callback, response) = oneshot::channel();
            tx.send((H256::zero(), callback))
                .expect("queue signing request");
            drop(tx);
            let mut response = Some(response);
            if cancel {
                *state.close_receiver.lock().expect("receiver lock") = response.take();
            }
            SingletonSigner::run_with_signer(
                TestSigner {
                    state: state.clone(),
                    pending: false,
                },
                5,
                rx,
            )
            .await;
            assert_eq!(
                state.calls.load(Ordering::SeqCst),
                if cancel { 1 } else { 6 }
            );
            if let Some(response) = response {
                assert!(response.await.expect("exhausted retry response").is_err());
            }
        }
    }
}
