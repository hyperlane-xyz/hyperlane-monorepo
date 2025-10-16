use std::sync::Arc;
use std::time::Duration;

use hyperlane_core::U256;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander};

use ethers_core::types::Address;

use super::error::{NonceError, NonceResult};
use super::state::NonceManagerState;
use super::NonceUpdater;

pub struct PeriodicNonceUpdater {
    address: Address,
    reorg_period: EthereumReorgPeriod,
    poll_rate: Duration,
    provider: Arc<dyn EvmProviderForLander>,
    state: Arc<NonceManagerState>,
}

impl PeriodicNonceUpdater {
    pub fn new(
        address: Address,
        reorg_period: EthereumReorgPeriod,
        poll_rate: Duration,
        provider: Arc<dyn EvmProviderForLander>,
        state: Arc<NonceManagerState>,
    ) -> Self {
        Self {
            address,
            reorg_period,
            poll_rate,
            state,
            provider,
        }
    }

    pub async fn run(&self) {
        loop {
            tracing::debug!("Updating finalized nonce");
            let _ = NonceUpdater::update_state_boundaries_immediately(
                &self.provider,
                &self.state,
                &self.address,
                &self.reorg_period,
            )
            .await;
            tokio::time::sleep(self.poll_rate).await;
        }
    }
}
