use hyperlane_core::U256;

use tracing::{debug, info, warn};

use super::super::super::transaction::Precursor;
use super::super::error::NonceResult;
use super::super::status::NonceStatus;
use super::NonceManagerState;
use crate::transaction::{Transaction, TransactionUuid};
use crate::TransactionStatus;

/// What action to take given a tx
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum NonceAction {
    // Assign the provided nonce
    Assign { nonce: U256 },
    // Assign the next available nonce, old_nonce will be unassigned if any.
    AssignNext { old_nonce: Option<U256> },
}

impl NonceManagerState {
    pub(crate) async fn validate_assigned_nonce(
        &self,
        tx: &Transaction,
    ) -> NonceResult<NonceAction> {
        use NonceStatus::{Committed, Freed, Taken};

        let tx_uuid = tx.uuid.clone();
        let tx_status = tx.status.clone();

        let db_nonce = self.get_tx_nonce(&tx_uuid).await?.and_then(|x| {
            if x == U256::MAX {
                None
            } else {
                Some(x)
            }
        });
        let tx_nonce: Option<U256> = tx.precursor().tx.nonce().map(Into::into);

        debug!(?db_nonce, ?tx_nonce, "Validating nonce");

        let nonce = match (db_nonce, tx_nonce) {
            // prefer nonce in db over nonce in tx
            (Some(db_nonce), Some(tx_nonce)) => {
                if db_nonce != tx_nonce {
                    warn!(?db_nonce, ?tx_nonce, "tx nonce and db nonce do not match");
                    self.metrics.increment_mismatch_nonce();
                }
                db_nonce
            }
            (Some(db_nonce), _) => {
                warn!(
                    ?db_nonce,
                    "Transaction has nonce assigned in db but not in tx"
                );
                self.metrics.increment_mismatch_nonce();
                db_nonce
            }
            (_, Some(tx_nonce)) => {
                warn!(
                    ?tx_nonce,
                    "Transaction has nonce assigned but is not reflected in db"
                );
                self.metrics.increment_mismatch_nonce();
                return Ok(NonceAction::AssignNext { old_nonce: None });
            }
            (_, _) => {
                return Ok(NonceAction::AssignNext { old_nonce: None });
            }
        };

        let nonce_status = NonceStatus::calculate_nonce_status(tx_uuid.clone(), &tx_status);

        let finalized_nonce = self.get_finalized_nonce().await?;

        match (&nonce_status, finalized_nonce) {
            (Freed(_), _) => {
                // If the nonce, which is currently assigned to the transaction, is Freed,
                // then the transaction was dropped. But we are validating the nonce just before
                // we submit the transaction again. It means that we should assign the new nonce.
                warn!(?nonce, ?nonce_status, "Nonce is freed, assigning new nonce");
                Ok(NonceAction::AssignNext {
                    old_nonce: Some(nonce),
                })
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
                Ok(NonceAction::AssignNext {
                    old_nonce: Some(nonce),
                })
            }
            (Taken(_), _) => {
                // If the nonce is taken or committed, we don't need to do anything.
                info!(
                    ?nonce,
                    ?nonce_status,
                    "Nonce is already assigned to the transaction, no action needed"
                );
                Ok(NonceAction::Assign { nonce })
            }
            (Committed(_), _) => {
                // If the nonce is taken or committed, we don't need to do anything.
                warn!(
                    ?nonce,
                    ?nonce_status,
                    "Nonce is already assigned to the transaction, no action needed, \
                    but transaction should not be committed at this point"
                );
                Ok(NonceAction::Assign { nonce })
            }
        }
    }
}

#[cfg(test)]
mod tests;
