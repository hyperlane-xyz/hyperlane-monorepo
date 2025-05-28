// the evm provider-building logic returns a box. `EvmProviderForSubmitter` is only implemented for the underlying type rather than the boxed type.
// implementing the trait for the boxed type would require a lot of boilerplate code.
#![allow(clippy::borrowed_box)]

use std::sync::Arc;

use tokio::sync::Mutex;
use tracing::info;

use hyperlane_ethereum::EvmProviderForSubmitter;

use crate::transaction::Transaction;
use crate::LanderError;

use super::super::transaction::Precursor;

pub struct NonceManager {
    tx_in_finality_count: Arc<Mutex<usize>>,
}

impl NonceManager {
    pub fn new() -> Self {
        Self {
            tx_in_finality_count: Arc::new(Mutex::new(0usize)),
        }
    }

    pub async fn set_nonce(
        &self,
        tx: &mut Transaction,
        provider: &Box<dyn EvmProviderForSubmitter>,
    ) -> Result<(), LanderError> {
        let tx_id = tx.id.to_string();
        let precursor = tx.precursor_mut();

        if precursor.tx.nonce().is_some() {
            return Ok(());
        }

        let address = *precursor.tx.from().ok_or(LanderError::TxSubmissionError(
            "Transaction missing address".to_string(),
        ))?;
        let nonce = provider.get_next_nonce_on_finalized_block(&address).await?;

        let next_nonce = nonce + self.get_tx_in_finality_count().await as u64;

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
