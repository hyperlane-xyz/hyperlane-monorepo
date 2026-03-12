use eyre::Result;
use hyperlane_core::{PendingOperationStatus, QueueOperation};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{sync::mpsc::UnboundedSender, task::JoinHandle, time};
use tracing::{debug, error, info};

use crate::msg::pending_message::{MessageContext, PendingMessage, DEFAULT_MAX_MESSAGE_RETRIES};

use super::{
    extractor::ExtractedMessage,
    job::{RelayJob, RelayStatus},
    store::JobStore,
};

/// Worker that injects extracted messages into the MessageProcessor
pub struct RelayWorker {
    /// Message channels by destination domain ID
    send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
    /// Message contexts by (origin_domain_id, destination_domain_id)
    msg_ctxs: HashMap<(u32, u32), Arc<MessageContext>>,
    /// Job store for status updates
    job_store: JobStore,
}

impl RelayWorker {
    pub fn new(
        send_channels: HashMap<u32, UnboundedSender<QueueOperation>>,
        msg_ctxs: HashMap<(u32, u32), Arc<MessageContext>>,
        job_store: JobStore,
    ) -> Self {
        Self {
            send_channels,
            msg_ctxs,
            job_store,
        }
    }

    /// Inject an extracted message into the MessageProcessor
    pub async fn inject_message(
        &self,
        mut job: RelayJob,
        extracted: ExtractedMessage,
    ) -> Result<()> {
        let origin_domain = extracted.origin_domain;
        let destination_domain = extracted.destination_domain;
        let message = extracted.message;
        let message_id = extracted.message_id;

        info!(
            job_id = %job.id,
            message_id = ?message_id,
            origin = origin_domain,
            destination = destination_domain,
            "Injecting message into MessageProcessor"
        );

        // Check if we have a send channel for this destination
        let send_channel = match self.send_channels.get(&destination_domain) {
            Some(ch) => ch,
            None => {
                let err = format!(
                    "No send channel for destination domain {}",
                    destination_domain
                );
                error!(job_id = %job.id, %err);
                job.set_error(err);
                self.job_store.update(job);
                return Ok(());
            }
        };

        // Check if we have a message context for this origin -> destination pair
        let msg_ctx = match self.msg_ctxs.get(&(origin_domain, destination_domain)) {
            Some(ctx) => ctx.clone(),
            None => {
                let err = format!(
                    "No message context for origin {} -> destination {}",
                    origin_domain, destination_domain
                );
                error!(job_id = %job.id, %err);
                job.set_error(err);
                self.job_store.update(job);
                return Ok(());
            }
        };

        // Clone msg_ctx before moving it (we need it for status tracker)
        let msg_ctx_for_tracker = msg_ctx.clone();

        // Create PendingMessage (similar to DbLoader pattern)
        let app_context = None; // Fast relay doesn't classify app context
        let pending_msg = match PendingMessage::maybe_from_persisted_retries(
            message,
            msg_ctx,
            app_context,
            DEFAULT_MAX_MESSAGE_RETRIES,
        ) {
            Some(msg) => msg,
            None => {
                let err = "Message should be skipped based on retry count".to_string();
                debug!(job_id = %job.id, %err);
                job.set_error(err);
                self.job_store.update(job);
                return Ok(());
            }
        };

        // Send to MessageProcessor
        if let Err(e) = send_channel.send(Box::new(pending_msg) as QueueOperation) {
            let err = format!("Failed to send message to processor: {}", e);
            error!(job_id = %job.id, %err);
            job.set_error(err);
            self.job_store.update(job);
            return Ok(());
        }

        // Update job status to Preparing (MessageProcessor has it now)
        job.update_status(RelayStatus::Preparing);
        self.job_store.update(job.clone());

        debug!(
            job_id = %job.id,
            message_id = ?message_id,
            "Successfully injected message into MessageProcessor"
        );

        // Spawn background task to track status changes
        Self::spawn_status_tracker(
            job,
            msg_ctx_for_tracker,
            self.job_store.clone(),
            Duration::from_secs(2), // Poll every 2 seconds for responsive updates
        );

        info!(
            message_id = ?message_id,
            "Spawned status tracker for message"
        );

        Ok(())
    }

    /// Spawn a background task that tracks message status and updates RelayJob
    pub fn spawn_status_tracker(
        job: RelayJob,
        msg_ctx: Arc<MessageContext>,
        job_store: JobStore,
        interval: Duration,
    ) -> JoinHandle<()> {
        let message_id = job.message_id;
        let job_id = job.id;

        tokio::spawn(async move {
            let mut interval_timer = time::interval(interval);
            let mut last_status: Option<RelayStatus> = None;

            // Track for max 15 minutes
            let max_iterations = 450; // 15 min / 2s
            let mut iterations = 0;

            loop {
                interval_timer.tick().await;
                iterations += 1;

                // Get current job to check if still exists
                let Some(mut current_job) = job_store.get(&job_id) else {
                    debug!(job_id = %job_id, "Job no longer exists, stopping status tracker");
                    break;
                };

                // If already in terminal state, stop tracking
                if matches!(
                    current_job.status,
                    RelayStatus::Confirmed | RelayStatus::Failed
                ) {
                    debug!(job_id = %job_id, status = ?current_job.status, "Job reached terminal state");
                    break;
                }

                // First check if message has been delivered (final confirmation)
                match msg_ctx.destination_mailbox.delivered(message_id).await {
                    Ok(true) => {
                        // Message confirmed on destination!
                        if !matches!(current_job.status, RelayStatus::Confirmed) {
                            info!(
                                job_id = %job_id,
                                message_id = ?message_id,
                                "Message confirmed on destination chain"
                            );
                            current_job.update_status(RelayStatus::Confirmed);
                            job_store.update(current_job);
                        }
                        break; // Done tracking
                    }
                    Ok(false) => {
                        // Not delivered yet, check intermediate status from DB
                        match msg_ctx.origin_db.retrieve_status_by_message_id(&message_id) {
                            Ok(Some(pending_status)) => {
                                let new_relay_status =
                                    map_pending_status_to_relay_status(&pending_status);

                                // Only update if status changed
                                if last_status.as_ref() != Some(&new_relay_status) {
                                    info!(
                                        job_id = %job_id,
                                        message_id = ?message_id,
                                        old_status = ?last_status,
                                        new_status = ?new_relay_status,
                                        "Status changed"
                                    );

                                    current_job.update_status(new_relay_status.clone());
                                    job_store.update(current_job);
                                    last_status = Some(new_relay_status);
                                }
                            }
                            Ok(None) => {
                                debug!(job_id = %job_id, message_id = ?message_id, "No status in DB yet");
                            }
                            Err(e) => {
                                error!(job_id = %job_id, message_id = ?message_id, error = %e, "Failed to retrieve status from DB");
                            }
                        }
                    }
                    Err(e) => {
                        error!(job_id = %job_id, message_id = ?message_id, error = %e, "Failed to check if message delivered");
                    }
                }

                // Stop after max iterations to prevent infinite tracking
                if iterations >= max_iterations {
                    debug!(job_id = %job_id, "Max tracking time reached, stopping");
                    break;
                }
            }
        })
    }
}

/// Map PendingOperationStatus (from MessageProcessor) to RelayStatus (for API)
fn map_pending_status_to_relay_status(status: &PendingOperationStatus) -> RelayStatus {
    match status {
        PendingOperationStatus::FirstPrepareAttempt => RelayStatus::Preparing,
        PendingOperationStatus::Retry(_) => RelayStatus::Preparing,
        PendingOperationStatus::ReadyToSubmit => RelayStatus::Submitting,
        PendingOperationStatus::Confirm(_) => RelayStatus::Submitted,
    }
}
