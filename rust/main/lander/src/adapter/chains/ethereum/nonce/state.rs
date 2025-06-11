use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

use ethers_core::types::Address;
use futures_util::FutureExt;
use tokio::sync::{Mutex, MutexGuard};
use tracing::{error, warn};

use hyperlane_base::db::DbError;
use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, H256, U256};

use crate::transaction::{Transaction, TransactionUuid};
use crate::TransactionStatus;

use super::super::transaction::Precursor;
use super::db::NonceDb;
use super::error::{NonceError, NonceResult};
use super::status::NonceStatus;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NonceAction {
    Noop,
    Assign,
}

pub struct NonceManagerState {
    db: Arc<dyn NonceDb>,
    address: Address,
}

impl NonceManagerState {
    pub fn new(db: Arc<dyn NonceDb>, address: Address) -> Self {
        Self { db, address }
    }

    pub(crate) async fn update_boundary_nonces(&self, nonce: &U256) -> NonceResult<()> {
        self.db
            .store_lowest_available_nonce_by_signer_address(&self.address, nonce)
            .await?;

        let upper_nonce = self
            .db
            .retrieve_upper_nonce_by_signer_address(&self.address)
            .await?
            .unwrap_or_default();

        if nonce > &upper_nonce {
            self.db
                .store_upper_nonce_by_signer_address(&self.address, nonce)
                .await?;
        }

        Ok(())
    }

    pub(crate) async fn update_nonce_status(
        &self,
        nonce: U256,
        nonce_status: NonceStatus,
    ) -> NonceResult<()> {
        use NonceStatus::{Committed, Freed, Taken};

        let Some(tracked_nonce_status) = self.get_nonce_status(&nonce).await? else {
            // If the nonce is not tracked, we insert it with the new status.
            self.insert_nonce_status(nonce, nonce_status).await?;
            return Ok(());
        };

        if tracked_nonce_status == nonce_status {
            // If the nonce status is the same as the tracked one, we do nothing.
            return Ok(());
        }

        let tracked_tx_uuid = match &tracked_nonce_status {
            Taken(uuid) | Committed(uuid) => uuid,
            Freed(_) => {
                // If the tracked nonce status is Freed, and it differs from the nonce status,
                // we track nonce as assigned to the given transaction.
                self.insert_nonce_status(nonce, nonce_status).await?;
                return Ok(());
            }
        };

        let tx_uuid = match &nonce_status {
            Freed(uuid) | Taken(uuid) | Committed(uuid) => uuid,
        };

        if tracked_tx_uuid == tx_uuid {
            // If the nonce is assigned to the same transaction, we update the status.
            self.insert_nonce_status(nonce, nonce_status).await?;
            return Ok(());
        }

        // If the nonce is assigned to a different transaction, we log an error.
        // This should never happen if the signer account is used only within the Lander.
        error!(
            ?nonce,
            ?nonce_status,
            ?tracked_nonce_status,
            "Same nonce was assigned to multiple transactions"
        );

        Err(NonceError::NonceAssignedToMultipleTransactions(
            nonce,
            tracked_tx_uuid.clone(),
            tx_uuid.clone(),
        ))
    }

    pub(crate) async fn validate_assigned_nonce(
        &self,
        nonce: &U256,
        nonce_status: &NonceStatus,
    ) -> NonceResult<NonceAction> {
        use NonceAction::{Assign, Noop};
        use NonceStatus::{Committed, Freed, Taken};

        // Getting transaction UUID from the nonce status.
        let tx_uuid = match nonce_status {
            Freed(uuid) | Taken(uuid) | Committed(uuid) => uuid,
        };

        // Fetching the tracked nonce status and the lowest nonce.
        let (tracked_nonce_status, lowest_nonce) = self
            .get_nonce_status_and_lowest_nonce(&nonce.into())
            .await?;

        let Some(tracked_nonce_status) = tracked_nonce_status else {
            // If the nonce currently assigned to the transaction is not tracked,
            // we should assign the new nonce.
            return Ok(Assign);
        };

        // Getting the transaction UUID from the tracked nonce status.
        let tracked_tx_uuid = match &tracked_nonce_status {
            Freed(uuid) | Taken(uuid) | Committed(uuid) => uuid,
        };

        if tracked_tx_uuid != tx_uuid {
            // If the tracked nonce is assigned to a different transaction,
            // we should assign the new nonce.
            return Ok(Assign);
        }

        match nonce_status {
            Freed(_) => {
                // If the nonce which is currently assigned to the transaction, is Freed,
                // then the transaction was dropped, and we need to submit the transaction again.
                // We should assign the new nonce.
                Ok(Assign)
            }
            Taken(_) if nonce < &lowest_nonce => {
                // If the nonce is taken, but it is below the lowest nonce,
                // it means that the current nonce is outdated.
                // We should assign the new nonce.
                Ok(Assign)
            }
            Taken(_) | Committed(_) => {
                // If the nonce is taken or committed, we don't need to do anything.
                Ok(Noop)
            }
        }
    }

    pub(crate) async fn assign_next_nonce(&self, nonce_status: &NonceStatus) -> NonceResult<U256> {
        use NonceStatus::{Committed, Freed};

        let (lowest_nonce, upper_nonce) = self.get_boundary_nonces().await?;

        let mut next_nonce = lowest_nonce;

        while next_nonce < upper_nonce {
            let nonce_status = self
                .db
                .retrieve_nonce_status_by_nonce_and_signer_address(&next_nonce, &self.address)
                .await?;

            if nonce_status.is_none() || matches!(nonce_status.unwrap(), Freed(_)) {
                // If the nonce is not tracked or is Freed, we can use it.
                break;
            }

            next_nonce += U256::one();
        }

        if next_nonce >= upper_nonce {
            // If we reached the upper nonce, we need to update it.
            self.db
                .store_upper_nonce_by_signer_address(&self.address, &(next_nonce + 1))
                .await?;
        }

        // Store the nonce status in the database.
        self.db
            .store_nonce_status_by_nonce_and_signer_address(
                &next_nonce,
                &self.address,
                nonce_status,
            )
            .await?;

        Ok(next_nonce)
    }

    async fn insert_nonce_status(&self, nonce: U256, nonce_status: NonceStatus) -> NonceResult<()> {
        self.db
            .store_nonce_status_by_nonce_and_signer_address(&nonce, &self.address, &nonce_status)
            .await?;

        let upper_nonce = self
            .db
            .retrieve_upper_nonce_by_signer_address(&self.address)
            .await?
            .unwrap_or_default();

        if nonce >= upper_nonce {
            self.db
                .store_upper_nonce_by_signer_address(&self.address, &(nonce + 1))
                .await?;
        }

        Ok(())
    }

    async fn get_nonce_status_and_lowest_nonce(
        &self,
        nonce: &U256,
    ) -> NonceResult<(Option<NonceStatus>, U256)> {
        let nonce_status = self.get_nonce_status(nonce).await?;
        let lowest_nonce = self.get_lowest_nonce().await?;
        Ok((nonce_status, lowest_nonce))
    }

    async fn get_boundary_nonces(&self) -> NonceResult<(U256, U256)> {
        let lowest_nonce = self.get_lowest_nonce().await?;
        let upper_nonce = self.get_upper_nonce().await?;
        Ok((lowest_nonce, upper_nonce))
    }

    async fn get_nonce_status(&self, nonce: &U256) -> NonceResult<Option<NonceStatus>> {
        let nonce_status = self
            .db
            .retrieve_nonce_status_by_nonce_and_signer_address(nonce, &self.address)
            .await?;

        Ok(nonce_status)
    }

    async fn get_lowest_nonce(&self) -> NonceResult<U256> {
        let nonce = self
            .db
            .retrieve_lowest_available_nonce_by_signer_address(&self.address)
            .await?
            .unwrap_or_default();

        Ok(nonce)
    }

    async fn get_upper_nonce(&self) -> NonceResult<U256> {
        let nonce = self
            .db
            .retrieve_upper_nonce_by_signer_address(&self.address)
            .await?
            .unwrap_or_default();

        Ok(nonce)
    }
}

#[cfg(test)]
mod tests;
