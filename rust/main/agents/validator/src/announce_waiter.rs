//! Utility for submitting validator announcements via lander and waiting for finalization

use std::{sync::Arc, time::Duration};

use eyre::{eyre, Result};
use hyperlane_core::{Announcement, ChainResult, HyperlaneChainExt, SignedType, TxOutcome, H256};
use lander::{
    build_validator_announce_payload, DispatcherEntrypoint, Entrypoint, PayloadStatus,
    TransactionStatus,
};
use tokio::time::{interval, sleep};
use tracing::{debug, info, warn};

/// Waiter utility for validator announce operations using lander.
/// Handles submission and blocking wait for transaction finalization.
#[derive(Clone)]
pub struct AnnounceWaiter {
    /// Lander dispatcher entrypoint for submitting payloads
    entrypoint: Arc<DispatcherEntrypoint>,
    /// Address of the ValidatorAnnounce contract
    validator_announce_address: H256,
    /// How often to poll the payload status
    poll_interval: Duration,
    /// Maximum time to wait for finalization
    timeout: Duration,
}

impl AnnounceWaiter {
    /// Create a new AnnounceWaiter
    ///
    /// # Arguments
    /// * `entrypoint` - Lander dispatcher entrypoint
    /// * `validator_announce_address` - Address of ValidatorAnnounce contract
    /// * `poll_interval` - How often to check payload status (default: 2s)
    /// * `timeout` - Max wait time for finalization (default: 5 minutes)
    pub fn new(
        entrypoint: Arc<DispatcherEntrypoint>,
        validator_announce_address: H256,
        poll_interval: Option<Duration>,
        timeout: Option<Duration>,
    ) -> Self {
        Self {
            entrypoint,
            validator_announce_address,
            poll_interval: poll_interval.unwrap_or(Duration::from_secs(2)),
            timeout: timeout.unwrap_or(Duration::from_secs(300)),
        }
    }

    /// Submit a validator announcement and wait for it to finalize.
    ///
    /// This method:
    /// 1. Builds a FullPayload from the announcement
    /// 2. Submits it to lander via entrypoint.send_payload()
    /// 3. Polls entrypoint.payload_status() until finalized or timeout
    /// 4. Returns TxOutcome with transaction details
    ///
    /// # Arguments
    /// * `announcement` - The signed announcement to submit
    ///
    /// # Returns
    /// * `ChainResult<TxOutcome>` - Transaction outcome on success, error on failure
    pub async fn send_and_wait(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<TxOutcome> {
        // Build payload from announcement
        let payload = build_validator_announce_payload(
            announcement.clone(),
            self.validator_announce_address,
            Some(format!(
                "validator_announce:{}:{}",
                announcement.value.validator, announcement.value.mailbox_domain
            )),
        );

        let payload_uuid = payload.details.uuid;
        info!(
            ?payload_uuid,
            validator = ?announcement.value.validator,
            mailbox_domain = announcement.value.mailbox_domain,
            "Submitting validator announcement to lander"
        );

        // Submit payload to lander
        self.entrypoint
            .send_payload(&payload)
            .await
            .map_err(|e| hyperlane_core::ChainCommunicationError::from_other(e.into()))?;

        // Poll for finalization
        let start = tokio::time::Instant::now();
        let mut poll_timer = interval(self.poll_interval);
        let mut last_status: Option<PayloadStatus> = None;

        loop {
            // Check timeout
            if start.elapsed() > self.timeout {
                return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                    &format!(
                        "Validator announce timed out after {:?} waiting for finalization. Last status: {:?}",
                        self.timeout, last_status
                    ),
                ));
            }

            // Wait for next poll interval
            poll_timer.tick().await;

            // Query payload status
            let status = self
                .entrypoint
                .payload_status(payload_uuid)
                .await
                .map_err(|e| hyperlane_core::ChainCommunicationError::from_other(e.into()))?;

            // Log status changes
            if last_status.as_ref() != Some(&status) {
                debug!(
                    ?payload_uuid,
                    ?status,
                    elapsed = ?start.elapsed(),
                    "Validator announce status changed"
                );
                last_status = Some(status.clone());
            }

            match status {
                PayloadStatus::InTransaction(tx_status) => match tx_status {
                    TransactionStatus::Finalized => {
                        info!(
                            ?payload_uuid,
                            elapsed = ?start.elapsed(),
                            "Validator announce finalized"
                        );
                        // Extract transaction hash and return TxOutcome
                        // For now, we return a basic TxOutcome
                        // In a more complete implementation, we would extract the actual tx hash
                        // from the lander transaction details
                        return Ok(TxOutcome {
                            transaction_hash: H256::zero(), // TODO: extract actual hash from lander
                            gas_used: Default::default(),
                            gas_price: Default::default(),
                        });
                    }
                    TransactionStatus::Included => {
                        debug!(
                            ?payload_uuid,
                            "Validator announce included, waiting for finality"
                        );
                        // Continue polling for finalization
                    }
                    TransactionStatus::Mempool => {
                        debug!(?payload_uuid, "Validator announce in mempool");
                        // Continue polling
                    }
                    TransactionStatus::PendingInclusion => {
                        debug!(?payload_uuid, "Validator announce pending inclusion");
                        // Continue polling
                    }
                    TransactionStatus::Dropped(reason) => {
                        warn!(
                            ?payload_uuid,
                            ?reason,
                            "Validator announce transaction dropped"
                        );
                        return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                            &format!("Transaction dropped: {:?}", reason),
                        ));
                    }
                },
                PayloadStatus::Dropped(reason) => {
                    warn!(?payload_uuid, ?reason, "Validator announce payload dropped");
                    return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                        &format!("Payload dropped: {:?}", reason),
                    ));
                }
                PayloadStatus::Retry(reason) => {
                    debug!(?payload_uuid, ?reason, "Validator announce will be retried");
                    // Continue polling - lander will retry
                }
                PayloadStatus::ReadyToSubmit => {
                    debug!(
                        ?payload_uuid,
                        "Validator announce ready to submit (not yet picked up by building stage)"
                    );
                    // Continue polling
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_announce_waiter_new() {
        use lander::testing::create_test_dispatcher;
        let (entrypoint, _db) = create_test_dispatcher();
        let validator_announce_address = H256::random();

        let waiter = AnnounceWaiter::new(
            Arc::new(entrypoint),
            validator_announce_address,
            Some(Duration::from_millis(100)),
            Some(Duration::from_secs(10)),
        );

        assert_eq!(waiter.poll_interval, Duration::from_millis(100));
        assert_eq!(waiter.timeout, Duration::from_secs(10));
    }

    #[test]
    fn test_announce_waiter_new_defaults() {
        use lander::testing::create_test_dispatcher;
        let (entrypoint, _db) = create_test_dispatcher();
        let validator_announce_address = H256::random();

        let waiter =
            AnnounceWaiter::new(Arc::new(entrypoint), validator_announce_address, None, None);

        assert_eq!(waiter.poll_interval, Duration::from_secs(2));
        assert_eq!(waiter.timeout, Duration::from_secs(300));
    }
}
