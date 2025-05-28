use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use ethers_core::types::Address;

use tokio::time::sleep;
use tokio_metrics::TaskMonitor;
use tracing::{info_span, Instrument};

use hyperlane_core::U256;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander};

use super::state::NonceManagerState;

pub struct NonceUpdater {
    address: Address,
    reorg_period: EthereumReorgPeriod,
    block_time: Duration,
    provider: Arc<dyn EvmProviderForLander>,
    state: Arc<NonceManagerState>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl NonceUpdater {
    pub fn new(
        address: Address,
        reorg_period: EthereumReorgPeriod,
        block_time: Duration,
        provider: Arc<dyn EvmProviderForLander>,
        state: Arc<NonceManagerState>,
    ) -> Self {
        NonceUpdater {
            address,
            reorg_period,
            block_time,
            provider,
            state,
            task: None,
        }
    }

    pub fn run(&mut self) {
        let task_monitor = TaskMonitor::new();
        let address = self.address;
        let reorg_period = self.reorg_period;
        let block_time = self.block_time;
        let provider = self.provider.clone();
        let state = self.state.clone();
        let finalized_nonce_updater = tokio::task::Builder::new()
            .name("nonce_manager::finalized_nonce_updater")
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    Self::update(address, reorg_period, block_time, provider, state).await;
                }
                .instrument(info_span!("NonceManagerFinalizedNonceUpdater")),
            ))
            .expect("spawning tokio task from Builder is infallible");

        self.task = Some(finalized_nonce_updater);
    }

    pub async fn immediate(&self) {
        Self::immediate_update(
            &self.address,
            &self.reorg_period,
            &self.provider,
            &self.state,
        )
        .await;
    }

    async fn update(
        address: Address,
        reorg_period: EthereumReorgPeriod,
        block_time: Duration,
        provider: Arc<dyn EvmProviderForLander>,
        state: Arc<NonceManagerState>,
    ) {
        loop {
            Self::immediate_update(&address, &reorg_period, &provider, &state).await;
            sleep(block_time).await;
        }
    }

    async fn immediate_update(
        address: &Address,
        reorg_period: &EthereumReorgPeriod,
        provider: &Arc<dyn EvmProviderForLander>,
        state: &Arc<NonceManagerState>,
    ) {
        let next_nonce = provider
            .get_next_nonce_on_finalized_block(address, reorg_period)
            .await;

        if let Ok(next_nonce) = next_nonce {
            state.update_upper_nonce(&next_nonce).await;
        }
    }
}
