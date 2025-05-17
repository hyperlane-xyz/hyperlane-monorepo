// the evm provider-building logic returns a box. `EvmProviderForSubmitter` is only implemented for the underlying type rather than the boxed type.
// implementing the trait for the boxed type would require a lot of boilerplate code.
#![allow(clippy::borrowed_box)]

use hyperlane_ethereum::EvmProviderForSubmitter;
use tracing::info;

use crate::transaction::Transaction;
use crate::SubmitterError;

use super::super::transaction::Precursor;

pub struct NonceManager {
    pub tx_in_finality_count: usize,
}

impl NonceManager {
    pub fn new() -> Self {
        Self {
            tx_in_finality_count: 0,
        }
    }

    pub async fn set_nonce(
        &self,
        tx: &mut Transaction,
        provider: &Box<dyn EvmProviderForSubmitter>,
    ) -> Result<(), SubmitterError> {
        let tx_id = tx.id.to_string();
        let precursor = tx.precursor_mut();

        if precursor.tx.nonce().is_some() {
            return Ok(());
        }

        let address = precursor
            .tx
            .from()
            .ok_or(SubmitterError::TxSubmissionError(
                "Transaction missing address".to_string(),
            ))?
            .clone();
        let nonce = provider.get_next_nonce_on_finalized_block(&address).await?;

        let next_nonce = nonce + self.tx_in_finality_count;

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
}
