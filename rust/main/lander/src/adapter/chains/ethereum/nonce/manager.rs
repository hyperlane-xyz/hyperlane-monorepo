use std::sync::Arc;

use ethers::signers::Signer;
use ethers_core::types::Address;
use tracing::{info, warn};

use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::settings::{ChainConf, SignerConf};
use hyperlane_core::U256;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander, Signers};

use crate::adapter::chains::ethereum::nonce::error::NonceResult;
use crate::dispatcher::TransactionDb;
use crate::transaction::{Transaction, TransactionUuid};
use crate::{LanderError, TransactionStatus};

use super::super::metrics::EthereumAdapterMetrics;
use super::super::transaction::Precursor;
use super::db::NonceDb;
use super::state::{NonceAction, NonceManagerState};
use super::status::NonceStatus;
use super::updater::NonceUpdater;

pub struct NonceManager {
    pub address: Address,
    pub state: Arc<NonceManagerState>,
    pub nonce_updater: NonceUpdater,
}

impl NonceManager {
    pub async fn new(
        chain_conf: &ChainConf,
        db: Arc<HyperlaneRocksDB>,
        provider: Arc<dyn EvmProviderForLander>,
        metrics: EthereumAdapterMetrics,
    ) -> eyre::Result<Self> {
        let address = Self::address(chain_conf).await?;
        let reorg_period = EthereumReorgPeriod::try_from(&chain_conf.reorg_period)?;
        let block_time = chain_conf.estimated_block_time;

        let nonce_db = db.clone() as Arc<dyn NonceDb>;
        let tx_db = db.clone() as Arc<dyn TransactionDb>;
        let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

        let nonce_updater =
            NonceUpdater::new(address, reorg_period, block_time, provider, state.clone());

        let manager = Self {
            address,
            state,
            nonce_updater,
        };

        Ok(manager)
    }

    pub(crate) async fn calculate_next_nonce(
        &self,
        tx: &Transaction,
    ) -> eyre::Result<Option<U256>, LanderError> {
        use NonceAction::Noop;

        let tx_uuid = tx.uuid.clone();
        let precursor = tx.precursor();

        let from = *precursor.tx.from().ok_or(LanderError::TxSubmissionError(
            "Transaction missing address".to_string(),
        ))?;

        if from != self.address {
            return Err(LanderError::TxSubmissionError(
                "Transaction from address does not match nonce manager address".to_string(),
            ));
        }

        self.nonce_updater
            .update_boundaries()
            .await
            .map_err(|e| eyre::eyre!("Failed to update boundary nonces: {}", e))?;

        let (action, nonce) = self
            .state
            .validate_assigned_nonce(tx)
            .await
            .map_err(|e| eyre::eyre!("Failed to validate assigned nonce: {}", e))?;

        if matches!(action, Noop) {
            return Ok(None);
        }

        let next_nonce = self
            .state
            .assign_next_nonce(&tx_uuid, &nonce)
            .await
            .map_err(|e| {
                eyre::eyre!(
                    "Failed to assign next nonce for transaction {}: {}",
                    tx_uuid,
                    e
                )
            })?;

        Ok(Some(next_nonce))
    }

    pub async fn assign_nonce_from_db(&self, tx: &mut Transaction) -> NonceResult<()> {
        let tx_uuid = tx.uuid.clone();

        let db_nonce = self.state.get_tx_nonce(&tx_uuid).await?;
        let tx_nonce: Option<U256> = tx.precursor().tx.nonce().map(Into::into);

        if let Some(db_nonce) = db_nonce {
            if let Some(tx_nonce) = tx_nonce {
                if db_nonce != tx_nonce {
                    warn!(
                        ?tx_nonce,
                        ?db_nonce,
                        "EVM Transaction nonce differs from nonce in db"
                    );
                }
            }
            tx.precursor_mut().tx.set_nonce(db_nonce);
        }

        Ok(())
    }

    async fn address(chain_conf: &ChainConf) -> eyre::Result<Address> {
        let signer_conf = chain_conf
            .signer
            .as_ref()
            .ok_or_else(|| eyre::eyre!("Signer configuration is missing"))?;
        let signer: Signers = signer_conf.build().await?;
        let address = signer.address();
        Ok(address)
    }
}

#[cfg(test)]
mod tests;
