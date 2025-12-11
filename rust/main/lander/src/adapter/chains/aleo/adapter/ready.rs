use std::time::Duration;

use hyperlane_aleo::AleoProviderForLander;

use crate::transaction::Transaction;

impl<P: AleoProviderForLander> crate::adapter::chains::aleo::adapter::core::AleoAdapter<P> {
    /// Check if a transaction is ready for (re)submission.
    ///
    /// For Aleo:
    /// - Submit immediately if the transaction has never been submitted before
    /// - For resubmissions, wait approximately one block time before trying again
    pub(crate) fn ready_for_resubmission(&self, tx: &Transaction) -> bool {
        // If the transaction has never been submitted, it is ready for submission
        let Some(last_submission_time) = tx.last_submission_attempt else {
            return true;
        };

        // For resubmissions, wait approximately one block time
        let block_time = self.estimated_block_time;

        let elapsed = chrono::Utc::now()
            .signed_duration_since(last_submission_time)
            .to_std()
            .unwrap_or(block_time);

        elapsed >= block_time
    }
}

#[cfg(test)]
mod tests;
