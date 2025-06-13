use std::sync::Arc;

use ethers_core::types::Address;
use tracing::{error, info, warn};

use hyperlane_core::U256;

use crate::adapter::chains::ethereum::transaction::Precursor;
use crate::dispatcher::TransactionDb;
use crate::transaction::{Transaction, TransactionUuid};

use super::db::NonceDb;
use super::error::{NonceError, NonceResult};
use super::status::NonceStatus;

mod boundary;
mod db;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NonceAction {
    Noop,
    Assign,
}

pub struct NonceManagerState {
    nonce_db: Arc<dyn NonceDb>,
    tx_db: Arc<dyn TransactionDb>,
    address: Address,
}

impl NonceManagerState {
    pub fn new(
        nonce_db: Arc<dyn NonceDb>,
        tx_db: Arc<dyn TransactionDb>,
        address: Address,
    ) -> Self {
        Self {
            nonce_db,
            tx_db,
            address,
        }
    }

    pub(crate) async fn validate_assigned_nonce(
        &self,
        tx: &Transaction,
    ) -> NonceResult<(NonceAction, Option<U256>)> {
        use NonceAction::{Assign, Noop};
        use NonceStatus::{Committed, Freed, Taken};

        let tx_uuid = tx.uuid.clone();
        let tx_status = tx.status.clone();
        let Some(nonce): Option<U256> = tx.precursor().tx.nonce().map(Into::into) else {
            return Ok((Assign, None));
        };
        let nonce_status = NonceStatus::calculate_nonce_status(tx_uuid.clone(), &tx_status);

        // Fetching the tracked transaction uuid
        let tracked_tx_uuid = self.get_tracked_tx_uuid(&nonce).await?;

        if tracked_tx_uuid == TransactionUuid::default() {
            // If the nonce, which currently assigned to the transaction, is not tracked,
            // we should assign the new nonce.
            warn!(?nonce, "Nonce is not tracked, assigning new nonce");
            return Ok((Assign, Some(nonce)));
        };

        if tracked_tx_uuid != tx_uuid {
            // If the tracked nonce is assigned to a different transaction,
            // we should assign the new nonce. It should never happen
            // If the tracked transaction was dropped and
            // the calculated tracked nonce status is Freed, we may re-use the nonce
            // when we assign it to the new transaction.
            warn!(
                ?nonce,
                ?nonce_status,
                "Nonce is assigned to a different transaction, assigning new nonce"
            );
            return Ok((Assign, Some(nonce)));
        }

        let finalized_nonce = self.get_finalized_nonce().await?;

        match (&nonce_status, finalized_nonce) {
            (Freed(_), _) => {
                // If the nonce, which is currently assigned to the transaction, is Freed,
                // then the transaction was dropped. But we are validating the nonce just before
                // we submit the transaction again. It means that we should assign the new nonce.
                warn!(?nonce, ?nonce_status, "Nonce is freed, assigning new nonce");
                Ok((Assign, Some(nonce)))
            }
            (Taken(_), Some(finalized_nonce)) if nonce <= finalized_nonce => {
                // If the nonce is taken, but it is below or equal to the finalized nonce,
                // it means that the current nonce is outdated.
                // We should assign the new nonce.
                info!(
                    ?nonce,
                    ?nonce_status,
                    "Nonce is taken by the transaction but below or equal to the finalized nonce, assigning new nonce"
                );
                Ok((Assign, Some(nonce)))
            }
            (Taken(_), _) => {
                // If the nonce is taken or committed, we don't need to do anything.
                info!(
                    ?nonce,
                    ?nonce_status,
                    "Nonce is already assigned to the transaction, no action needed"
                );
                Ok((Noop, Some(nonce)))
            }
            (Committed(_), _) => {
                // If the nonce is taken or committed, we don't need to do anything.
                warn!(
                    ?nonce,
                    ?nonce_status,
                    "Nonce is already assigned to the transaction, no action needed, \
                    but transaction should not be committed at this point"
                );
                Ok((Noop, Some(nonce)))
            }
        }
    }

    pub(crate) async fn assign_next_nonce(
        &self,
        tx_uuid: &TransactionUuid,
        nonce: &Option<U256>,
    ) -> NonceResult<U256> {
        use NonceAction::{Assign, Noop};

        if let Some(nonce) = nonce {
            // If different nonce was assigned to the transaction,
            // we clear the tracked nonce for the transaction first.
            warn!(
                ?nonce,
                "Reassigning nonce to transaction, clearing currently tracked nonce"
            );
            self.clear_tracked_tx_uuid(nonce).await?;
        }

        let (finalized_nonce, upper_nonce) = self.get_boundary_nonces().await?;

        let next_nonce = self
            .identify_next_nonce(finalized_nonce, upper_nonce)
            .await?;

        if next_nonce == upper_nonce {
            // If we reached the upper nonce, we need to update it.
            self.set_upper_nonce(&(next_nonce + 1)).await?;
        }

        self.set_tracked_tx_uuid(&next_nonce, tx_uuid).await?;

        Ok(next_nonce)
    }

    async fn identify_next_nonce(
        &self,
        finalized_nonce: Option<U256>,
        upper_nonce: U256,
    ) -> Result<U256, NonceError> {
        use NonceStatus::{Committed, Freed, Taken};

        let Some(finalized_nonce) = finalized_nonce else {
            // If there is no finalized nonce, upper nonce should be zero, and we can use it as
            // the next nonce.
            return Ok(upper_nonce);
        };

        let mut next_nonce = finalized_nonce;

        while next_nonce < upper_nonce {
            let tracked_tx_uuid = self.get_tracked_tx_uuid(&next_nonce).await?;

            if tracked_tx_uuid == TransactionUuid::default() {
                // If the nonce is not tracked, we can use it.
                break;
            }

            let Some(tx) = self.get_tracked_tx(&tracked_tx_uuid).await? else {
                // If the transaction is not found, it means that the nonce was assigned to
                // a non-existing transaction. This should never happen. We assign new nonce.
                warn!(
                    ?next_nonce,
                    ?tracked_tx_uuid,
                    "Nonce was assigned to a non-existing transaction, assigning new nonce"
                );
                break;
            };

            let tx_status = tx.status;
            let tx_nonce_status = NonceStatus::calculate_nonce_status(tx.uuid.clone(), &tx_status);

            if matches!(tx_nonce_status, Freed(_)) {
                // If the transaction, which is tracked by the nonce, was dropped,
                // we can re-use the nonce.
                break;
            }

            next_nonce += U256::one();
        }

        Ok(next_nonce)
    }
}
