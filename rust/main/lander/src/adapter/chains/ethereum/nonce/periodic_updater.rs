use std::sync::Arc;
use std::time::Duration;

use hyperlane_core::U256;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander};

use ethers_core::types::Address;

use super::error::{NonceError, NonceResult};
use super::state::NonceManagerState;

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
            let _ = self.update_latest_finalized_nonce().await;
            tokio::time::sleep(self.poll_rate).await;
        }
    }

    pub async fn update_latest_finalized_nonce(&self) -> NonceResult<()> {
        let next_nonce = self
            .provider
            .get_next_nonce_on_finalized_block(&self.address, &self.reorg_period)
            .await
            .map_err(NonceError::ProviderError)?;

        let finalized_nonce = next_nonce.checked_sub(U256::one());

        if let Some(finalized_nonce) = finalized_nonce {
            self.state.update_boundary_nonces(&finalized_nonce).await?;
        }
        Ok(())
    }
}
