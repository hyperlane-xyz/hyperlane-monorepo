use std::sync::Arc;

use ethers::signers::Signer;
use ethers_core::types::Address;
use tokio::sync::Mutex;
use tracing::info;

use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::settings::{ChainConf, SignerConf};
use hyperlane_core::U256;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander, Signers};

use crate::transaction::{Transaction, TransactionUuid};
use crate::{LanderError, TransactionStatus};

use super::super::transaction::Precursor;
use super::state::{NonceAction, NonceManagerState, NonceStatus};
use super::updater::NonceUpdater;

pub struct NonceManager {
    pub address: Address,
    pub state: Arc<NonceManagerState>,
    pub _nonce_updater: NonceUpdater,
}

impl NonceManager {
    pub async fn new(
        chain_conf: &ChainConf,
        provider: Arc<dyn EvmProviderForLander>,
    ) -> eyre::Result<Self> {
        let address = Self::address(chain_conf).await?;
        let reorg_period = EthereumReorgPeriod::try_from(&chain_conf.reorg_period)?;
        let block_time = chain_conf.estimated_block_time;

        let state = Arc::new(NonceManagerState::new());

        let mut nonce_updater =
            NonceUpdater::new(address, reorg_period, block_time, provider, state.clone());
        nonce_updater.immediate().await;
        nonce_updater.run();

        let manager = Self {
            address,
            state,
            _nonce_updater: nonce_updater,
        };

        Ok(manager)
    }

    pub async fn assign_nonce(&self, tx: &mut Transaction) -> Result<(), LanderError> {
        use NonceAction::{AssignNew, FreeAndAssignNew, Noop};
        use NonceStatus::{Committed, Free, Taken};

        let tx_uuid = tx.uuid.clone();

        let precursor = tx.precursor_mut();

        let from = *precursor.tx.from().ok_or(LanderError::TxSubmissionError(
            "Transaction missing address".to_string(),
        ))?;

        if from != self.address {
            return Err(LanderError::TxSubmissionError(
                "Transaction from address does not match nonce manager address".to_string(),
            ));
        }

        if let Some(nonce) = precursor.tx.nonce() {
            let nonce: U256 = nonce.into();
            let action = self.state.validate_assigned_nonce(&nonce, &tx_uuid).await;

            match action {
                Noop => return Ok(()),
                AssignNew => {}
                FreeAndAssignNew => {
                    // If we need to free the nonce, we do so.
                    self.state.insert_nonce_status(nonce, Free).await;
                }
            }
        }

        let next_nonce = self.state.identify_next_nonce().await;

        self.state
            .insert_nonce_status(next_nonce, Taken(tx_uuid.clone()))
            .await;

        precursor.tx.set_nonce(next_nonce);

        info!(
            nonce = ?next_nonce,
            address = ?from,
            ?tx_uuid,
            precursor = ?precursor,
            "Set nonce for transaction"
        );

        Ok(())
    }

    pub(crate) async fn update_nonce_status(
        &self,
        tx: &Transaction,
        tx_status: &TransactionStatus,
    ) {
        let tx_uuid = &tx.uuid;
        let precursor = tx.precursor();

        let Some(nonce) = precursor.tx.nonce().map(Into::into) else {
            return;
        };

        let nonce_status = Self::calculate_nonce_status(tx_uuid.clone(), tx_status);

        self.state
            .update_nonce_status(nonce, nonce_status, tx_uuid)
            .await;
    }

    fn calculate_nonce_status(
        tx_uuid: TransactionUuid,
        tx_status: &TransactionStatus,
    ) -> NonceStatus {
        use NonceStatus::{Committed, Free, Taken};
        use TransactionStatus::{Dropped, Finalized, Included, Mempool, PendingInclusion};

        match tx_status {
            PendingInclusion | Mempool | Included => Taken(tx_uuid),
            Finalized => Committed(tx_uuid),
            Dropped(_) => Free,
        }
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
