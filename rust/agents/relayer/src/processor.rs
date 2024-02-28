use std::fmt::Debug;

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_core::HyperlaneDomain;
use tokio::task::JoinHandle;
use tracing::{instrument, warn};

#[async_trait]
pub trait ProcessorExt: Send + Debug {
    /// The domain this processor is getting messages from.
    fn domain(&self) -> &HyperlaneDomain;

    /// One round of processing, extracted from infinite work loop for
    /// testing purposes.
    async fn tick(&mut self) -> Result<()>;
}

#[derive(new)]
pub struct Processor {
    ticker: Box<dyn ProcessorExt>,
}

impl Processor {
    pub fn spawn(self) -> JoinHandle<()> {
        tokio::spawn(async move { self.main_loop().await })
    }

    #[instrument(ret, skip(self), level = "info", fields(domain=%self.ticker.domain()))]
    async fn main_loop(mut self) {
        loop {
            if let Err(err) = self.ticker.tick().await {
                warn!(error=%err, "Error in processor tick");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}
