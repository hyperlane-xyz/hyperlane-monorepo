use hyperlane_core::U256;

use tracing::{info, warn};

use crate::transaction::{Transaction, TransactionUuid};

use super::super::super::transaction::Precursor;
use super::super::error::NonceResult;
use super::super::status::NonceStatus;
use super::NonceManagerState;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NonceAction {
    Noop,
    Assign,
}

impl NonceManagerState {
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
}

#[cfg(test)]
mod tests;
