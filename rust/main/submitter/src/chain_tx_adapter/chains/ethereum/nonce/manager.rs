// the evm provider-building logic returns a box. `EvmProviderForSubmitter` is only implemented for the underlying type rather than the boxed type.
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
use hyperlane_ethereum::{EvmProviderForSubmitter, Signers};

use crate::transaction::{Transaction, TransactionId};
use crate::{SubmitterError, TransactionStatus};

use super::super::transaction::Precursor;
use super::db::NonceDb;
use super::state::{NonceAction, NonceManagerState, NonceStatus};

pub struct NonceManager {
    address: Address,
    db: Arc<dyn NonceDb>,
    state: NonceManagerState,
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
        let singer_conf = chain_conf
            .signer
            .as_ref()
            .ok_or_else(|| eyre::eyre!("Signer configuration is missing"))?;
        let signer: Signers = singer_conf.build().await?;
        let address = signer.address();
        Ok(address)
    }

    pub async fn assign_nonce(&self, tx: &mut Transaction) -> Result<(), SubmitterError> {
        let tx_id = tx.id.clone();

        let precursor = tx.precursor_mut();

        let address = *precursor
            .tx
            .from()
            .ok_or(SubmitterError::TxSubmissionError(
                "Transaction missing address".to_string(),
            ))?;

        if address != self.address {
            return Err(SubmitterError::TxSubmissionError(
                "Transaction address does not match nonce manager address".to_string(),
            ));
        }

        if let Some(nonce) = precursor.tx.nonce() {
            let nonce: U256 = nonce.into();
            let action = self.state.validate_assigned_nonce(&nonce).await;
            if matches!(action, NonceAction::Noop) {
                return Ok(());
            };
        }

        let next_nonce = self.state.identify_next_nonce().await?;

        self.db
            .store_tx_id_by_nonce_and_signer_address(&next_nonce, &address.to_string(), &tx_id)
            .await?;

        precursor.tx.set_nonce(next_nonce);
        info!(
            nonce = next_nonce.to_string(),
            address = ?address,
            ?tx_id,
            precursor = ?precursor,
            "Set nonce for transaction"
        );

        Ok(())
    }

    pub async fn set_tx_in_finality_count(&self, count: usize) {
        self.state.set_tx_in_finality_count(count).await;
    }
}
