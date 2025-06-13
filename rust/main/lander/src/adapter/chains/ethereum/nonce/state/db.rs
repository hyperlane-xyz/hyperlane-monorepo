use hyperlane_core::U256;

use crate::transaction::{Transaction, TransactionUuid};

use super::super::NonceManagerState;
use super::NonceResult;

impl NonceManagerState {
    pub(super) async fn get_boundary_nonces(&self) -> NonceResult<(Option<U256>, U256)> {
        let finalized_nonce = self.get_finalized_nonce().await?;
        let upper_nonce = self.get_upper_nonce().await?;
        Ok((finalized_nonce, upper_nonce))
    }

    pub(super) async fn get_tracked_tx(
        &self,
        tx_uuid: &TransactionUuid,
    ) -> NonceResult<Option<Transaction>> {
        let tx_uuid = self.tx_db.retrieve_transaction_by_uuid(tx_uuid).await?;
        Ok(tx_uuid)
    }

    pub(super) async fn clear_tracked_tx_uuid(&self, nonce: &U256) -> NonceResult<()> {
        self.nonce_db
            .store_transaction_uuid_by_nonce_and_signer_address(
                nonce,
                &self.address,
                &TransactionUuid::default(),
            )
            .await?;

        Ok(())
    }

    pub(super) async fn set_tracked_tx_uuid(
        &self,
        nonce: &U256,
        tx_uuid: &TransactionUuid,
    ) -> NonceResult<()> {
        self.nonce_db
            .store_transaction_uuid_by_nonce_and_signer_address(nonce, &self.address, tx_uuid)
            .await?;

        Ok(())
    }

    pub(super) async fn get_tracked_tx_uuid(&self, nonce: &U256) -> NonceResult<TransactionUuid> {
        let tx_uuid = self
            .nonce_db
            .retrieve_transaction_uuid_by_nonce_and_signer_address(nonce, &self.address)
            .await?
            .unwrap_or_default();

        Ok(tx_uuid)
    }

    pub(super) async fn set_finalized_nonce(&self, nonce: &U256) -> NonceResult<()> {
        self.nonce_db
            .store_finalized_nonce_by_signer_address(&self.address, nonce)
            .await?;

        Ok(())
    }

    pub(super) async fn get_finalized_nonce(&self) -> NonceResult<Option<U256>> {
        let finalized_nonce = self
            .nonce_db
            .retrieve_finalized_nonce_by_signer_address(&self.address)
            .await?;

        Ok(finalized_nonce)
    }

    pub(super) async fn set_upper_nonce(&self, nonce: &U256) -> NonceResult<()> {
        self.nonce_db
            .store_upper_nonce_by_signer_address(&self.address, nonce)
            .await?;

        Ok(())
    }

    pub(super) async fn get_upper_nonce(&self) -> NonceResult<U256> {
        let nonce = self
            .nonce_db
            .retrieve_upper_nonce_by_signer_address(&self.address)
            .await?
            .unwrap_or_default();

        Ok(nonce)
    }
}

#[cfg(test)]
mod tests;
