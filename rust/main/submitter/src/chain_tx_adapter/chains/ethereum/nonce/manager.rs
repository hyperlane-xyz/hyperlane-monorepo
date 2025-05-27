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
use hyperlane_ethereum::{EvmProviderForSubmitter, Signers};

use crate::transaction::Transaction;
use crate::SubmitterError;

use super::super::transaction::Precursor;
use super::db::NonceDb;

pub struct NonceManager {
    tx_in_finality_count: Arc<Mutex<usize>>,
    address: Address,
    db: Arc<dyn NonceDb>,
}

impl NonceManager {
    pub async fn new(chain_conf: &ChainConf, db: Arc<HyperlaneRocksDB>) -> eyre::Result<Self> {
        let address = Self::address(chain_conf).await?;
        let db = db as Arc<dyn NonceDb>;
        Ok(Self {
            tx_in_finality_count: Arc::new(Mutex::new(0usize)),
            address,
            db,
        })
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

    pub async fn set_nonce(
        &self,
        tx: &mut Transaction,
        provider: &Box<dyn EvmProviderForSubmitter>,
    ) -> Result<(), SubmitterError> {
        let tx_id = tx.id.clone();

        let precursor = tx.precursor_mut();

        if let Some(nonce) = precursor.tx.nonce() {
            let stored_tx_id = self
                .db
                .retrieve_tx_id_by_nonce_and_signer_address(
                    &nonce.into(),
                    &self.address.to_string(),
                )
                .await?
                .ok_or(SubmitterError::TxSubmissionError(
                    "Nonce not found in database".to_string(),
                ))?;
            if stored_tx_id != tx_id {
                return Err(SubmitterError::TxSubmissionError(format!(
                    "Nonce already used for a different transaction, stored tx id {:?}, current tx id {:?}",
                    stored_tx_id, tx_id
                )));
            }
            return Ok(());
        }

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

        let nonce = provider.get_next_nonce_on_finalized_block(&address).await?;

        let next_nonce = nonce + self.get_tx_in_finality_count().await as u64;

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
        *self.tx_in_finality_count.lock().await = count;
    }

    async fn get_tx_in_finality_count(&self) -> usize {
        *self.tx_in_finality_count.lock().await
    }
}
