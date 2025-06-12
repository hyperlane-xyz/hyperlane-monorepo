// the evm provider-building logic returns a box. `EvmProviderForLander` is only implemented for the underlying type rather than the boxed type.
// implementing the trait for the boxed type would require a lot of boilerplate code.
#![allow(clippy::borrowed_box)]

use std::sync::Arc;

use ethers::signers::Signer;
use ethers_core::types::Address;
use tokio::sync::Mutex;
use tracing::info;

use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_base::settings::{ChainConf, SignerConf};
use hyperlane_core::U256;
use hyperlane_ethereum::Signers;

use crate::transaction::{Transaction, TransactionUuid};
use crate::{LanderError, TransactionStatus};

use super::super::transaction::Precursor;
use super::db::NonceDb;
use super::state::{NonceAction, NonceManagerState, NonceStatus};

pub struct NonceManager {
    pub address: Address,
    pub db: Arc<dyn NonceDb>,
    pub state: NonceManagerState,
}

impl NonceManager {
    pub async fn new(chain_conf: &ChainConf, db: Arc<HyperlaneRocksDB>) -> eyre::Result<Self> {
        let address = Self::address(chain_conf).await?;
        let db = db as Arc<dyn NonceDb>;
        let state = NonceManagerState::new();

        Ok(Self { address, db, state })
    }

    pub async fn update_nonce_status(&self, tx: &Transaction, tx_status: &TransactionStatus) {
        self.state.update_nonce_status(tx, tx_status).await;
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

    pub async fn assign_nonce(&self, tx: &mut Transaction) -> Result<(), LanderError> {
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
            let action = self.state.validate_assigned_nonce(&nonce).await;
            if matches!(action, NonceAction::Noop) {
                let assigned_tx_uuid = self
                    .db
                    .retrieve_tx_uuid_by_nonce_and_signer_address(&nonce, &self.address.to_string())
                    .await?;

                if let Some(assigned_tx_uuid) = assigned_tx_uuid {
                    if assigned_tx_uuid == tx_uuid {
                        return Ok(());
                    }
                }
            };
        }

        let next_nonce = self.state.identify_next_nonce().await;

        self.db
            .store_tx_uuid_by_nonce_and_signer_address(
                &next_nonce,
                &self.address.to_string(),
                &tx_uuid,
            )
            .await?;

        self.state
            .insert_nonce_status(&next_nonce, NonceStatus::Taken)
            .await;

        precursor.tx.set_nonce(next_nonce);

        info!(
            nonce = next_nonce.to_string(),
            address = ?from,
            ?tx_uuid,
            precursor = ?precursor,
            "Set nonce for transaction"
        );

        Ok(())
    }
}
