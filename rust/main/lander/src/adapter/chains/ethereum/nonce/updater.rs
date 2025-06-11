use std::future::Future;
use std::ops::Add;
use std::sync::Arc;
use std::time::Duration;

use ethers_core::types::Address;
use tokio::sync::Mutex;
use tokio::time::{sleep, Instant};
use tokio_metrics::TaskMonitor;
use tracing::{error, info, info_span, Instrument};

use hyperlane_core::U256;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander};

use super::state::NonceManagerState;

pub struct NonceUpdater {
    address: Address,
    reorg_period: EthereumReorgPeriod,
    block_time: Duration,
    provider: Arc<dyn EvmProviderForLander>,
    state: Arc<NonceManagerState>,
    updated: Arc<Mutex<Instant>>,
}

impl NonceUpdater {
    pub fn new(
        address: Address,
        reorg_period: EthereumReorgPeriod,
        block_time: Duration,
        provider: Arc<dyn EvmProviderForLander>,
        state: Arc<NonceManagerState>,
    ) -> Self {
        let updated = Arc::new(Mutex::new(Instant::now()));

        NonceUpdater {
            address,
            reorg_period,
            block_time,
            provider,
            state,
            updated,
        }
    }

    pub async fn update(&self) {
        let duration = self.updated.lock().await.elapsed();
        if duration >= self.block_time {
            self.update_immediately().await;
        }
    }

    pub async fn update_immediately(&self) {
        let mut guard = self.updated.lock().await;
        *guard = Instant::now();

        let next_nonce = self
            .provider
            .get_next_nonce_on_finalized_block(&self.address, &self.reorg_period)
            .await;

        if let Ok(next_nonce) = next_nonce {
            let update_boundary_nonces_result =
                self.state.update_boundary_nonces(&next_nonce).await;
            if let Err(e) = update_boundary_nonces_result {
                error!("Failed to update boundary nonces: {:?}", e);
            }
        } else {
            error!(
                "Failed to get next nonce on finalized block: {:?}",
                next_nonce
            );
        }
    }
}
