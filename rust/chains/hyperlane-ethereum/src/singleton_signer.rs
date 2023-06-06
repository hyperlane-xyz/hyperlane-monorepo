use async_trait::async_trait;
use ethers_core::types::Signature;

use eyre::Result;

use hyperlane_core::{
    HyperlaneSigner, HyperlaneSignerError, H160, H256,
};

use crate::Signers;

type Callback = tokio::sync::oneshot::Sender<Signature>;
type SignHashWithCallback = (H256, Callback);

#[derive(Debug)]
pub struct SingletonSignerReceiver {
    inner: Signers,
    rx: tokio::sync::mpsc::UnboundedReceiver<SignHashWithCallback>,
    pub signer: SingletonSignerSender,
}

#[derive(Debug, Clone)]
pub struct SingletonSignerSender {
    address: H160,
    tx: tokio::sync::mpsc::UnboundedSender<SignHashWithCallback>,
}

#[async_trait]
impl HyperlaneSigner for SingletonSignerSender {
    fn eth_address(&self) -> H160 {
        self.address
    }

    async fn sign_hash(&self, hash: &H256) -> Result<Signature, HyperlaneSignerError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        match self.tx.send((hash.clone(), tx)) {
            Ok(_) => (),
            Err(err) => return Err(HyperlaneSignerError::from(Box::new(err) as Box<_>)),
        }
        rx.await
            .map_err(|err| HyperlaneSignerError::from(Box::new(err) as Box<_>))
    }
}

impl SingletonSignerReceiver {
    pub fn new(inner: Signers) -> Self {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<SignHashWithCallback>();
        let signer = SingletonSignerSender {
            address: inner.eth_address(),
            tx,
        };
        Self { inner, rx, signer }
    }

    pub async fn run(&mut self) -> Result<()> {
        while let Some((hash, tx)) = self.rx.recv().await {
            let signature = self.inner.sign_hash(&hash).await?;
            tx.send(signature);
        }

        Ok(())
    }
}
