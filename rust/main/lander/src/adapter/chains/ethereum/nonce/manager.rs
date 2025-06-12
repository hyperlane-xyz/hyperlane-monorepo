use std::sync::Arc;

use ethers::signers::Signer;
use ethers_core::types::Address;
use tracing::info;

use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::settings::{ChainConf, SignerConf};
use hyperlane_core::U256;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander, Signers};

use crate::dispatcher::TransactionDb;
use crate::transaction::{Transaction, TransactionUuid};
use crate::{LanderError, TransactionStatus};

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
    ) -> eyre::Result<Self> {
        let address = Self::address(chain_conf).await?;
        let reorg_period = EthereumReorgPeriod::try_from(&chain_conf.reorg_period)?;
        let block_time = chain_conf.estimated_block_time;

        let nonce_db = db.clone() as Arc<dyn NonceDb>;
        let tx_db = db.clone() as Arc<dyn TransactionDb>;
        let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address));

        let nonce_updater =
            NonceUpdater::new(address, reorg_period, block_time, provider, state.clone());

        let manager = Self {
            address,
            state,
            nonce_updater,
        };

        Ok(manager)
    }

    pub(crate) async fn assign_nonce(&self, tx: &mut Transaction) -> eyre::Result<(), LanderError> {
        use NonceAction::{Assign, Noop};
        use NonceStatus::{Committed, Freed, Taken};

        let tx_uuid = tx.uuid.clone();
        let tx_status = tx.status.clone();

        let precursor = tx.precursor_mut();

        let from = *precursor.tx.from().ok_or(LanderError::TxSubmissionError(
            "Transaction missing address".to_string(),
        ))?;

        if from != self.address {
            return Err(LanderError::TxSubmissionError(
                "Transaction from address does not match nonce manager address".to_string(),
            ));
        }

        let nonce_status = NonceStatus::calculate_nonce_status(tx_uuid.clone(), &tx_status);

        self.nonce_updater
            .update()
            .await
            .map_err(|e| eyre::eyre!("Failed to update boundary nonces: {}", e))?;

        let nonce = if let Some(nonce) = precursor.tx.nonce().map(Into::into) {
            let action = self
                .state
                .validate_assigned_nonce(&nonce, &nonce_status)
                .await
                .map_err(|e| eyre::eyre!("Failed to validate assigned nonce: {}", e))?;

            if matches!(action, Noop) {
                info!(
                    ?nonce_status,
                    address = ?from,
                    ?tx_uuid,
                    precursor = ?precursor,
                    "No action needed for transaction nonce"
                );
                return Ok(());
            }

            Some(nonce)
        } else {
            None
        };

        info!(
            ?nonce_status,
            address = ?from,
            ?tx_uuid,
            precursor = ?precursor,
            "Assigning nonce for transaction"
        );

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

        precursor.tx.set_nonce(next_nonce);

        info!(
            nonce = ?next_nonce,
            ?nonce_status,
            address = ?from,
            ?tx_uuid,
            precursor = ?precursor,
            "Set nonce for transaction"
        );

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
