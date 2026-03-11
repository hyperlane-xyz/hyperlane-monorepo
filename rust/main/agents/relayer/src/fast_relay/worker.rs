use std::sync::Arc;

use hyperlane_core::{HyperlaneMessage, QueueOperation};
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, error, info, warn};

use crate::fast_relay::{JobStore, RelayStatus};
use crate::msg::pending_message::{MessageContext, PendingMessage};

/// Fast relay worker that injects messages directly into the MessageProcessor
///
/// This bypasses the database polling done by DbLoader and sends messages
/// directly to the MessageProcessor's input channel for immediate processing.
pub struct FastRelayWorker {
    /// Job storage for updating status
    job_store: JobStore,
    /// Channels to send operations to message processors per destination
    send_channels: Arc<std::collections::HashMap<u32, UnboundedSender<QueueOperation>>>,
    /// Message contexts per (origin, destination) pair
    msg_ctxs: Arc<std::collections::HashMap<(u32, u32), Arc<MessageContext>>>,
    /// Maximum retries for message submission
    max_retries: u32,
}

impl FastRelayWorker {
    /// Create a new fast relay worker
    pub fn new(
        job_store: JobStore,
        send_channels: Arc<std::collections::HashMap<u32, UnboundedSender<QueueOperation>>>,
        msg_ctxs: Arc<std::collections::HashMap<(u32, u32), Arc<MessageContext>>>,
        max_retries: u32,
    ) -> Self {
        Self {
            job_store,
            send_channels,
            msg_ctxs,
            max_retries,
        }
    }

    /// Spawn an async worker to process a fast relay message
    ///
    /// This creates a PendingMessage from the extracted HyperlaneMessage
    /// and injects it directly into the MessageProcessor's input channel,
    /// bypassing the database entirely.
    pub fn spawn_processing_task(
        &self,
        job_id: uuid::Uuid,
        message: HyperlaneMessage,
    ) -> tokio::task::JoinHandle<()> {
        let job_store = self.job_store.clone();
        let send_channels = self.send_channels.clone();
        let msg_ctxs = self.msg_ctxs.clone();
        let max_retries = self.max_retries;

        tokio::spawn(async move {
            info!(?job_id, message_id = ?message.id(), "Starting fast relay processing");

            // Update job status to preparing
            if let Some(mut job) = job_store.get(&job_id).await {
                job.update_status(RelayStatus::Preparing);
                job_store.update(job).await;
            }

            // Get MessageContext for this (origin, destination) pair
            let ctx_key = (message.origin, message.destination);
            let Some(msg_ctx) = msg_ctxs.get(&ctx_key) else {
                error!(
                    ?job_id,
                    origin = message.origin,
                    destination = message.destination,
                    "No MessageContext found for origin-destination pair"
                );
                if let Some(mut job) = job_store.get(&job_id).await {
                    job.set_error(format!(
                        "No route configured for origin {} to destination {}",
                        message.origin, message.destination
                    ));
                    job_store.update(job).await;
                }
                return;
            };

            // Get send channel for destination
            let Some(send_channel) = send_channels.get(&message.destination) else {
                error!(
                    ?job_id,
                    destination = message.destination,
                    "No send channel found for destination"
                );
                if let Some(mut job) = job_store.get(&job_id).await {
                    job.set_error(format!(
                        "No processor for destination {}",
                        message.destination
                    ));
                    job_store.update(job).await;
                }
                return;
            };

            // Create PendingMessage
            // Use None for app_context as fast relay doesn't need app-level metrics
            let pending_msg = match PendingMessage::maybe_from_persisted_retries(
                message.clone(),
                msg_ctx.clone(),
                None, // app_context
                max_retries,
            ) {
                Some(msg) => msg,
                None => {
                    warn!(
                        ?job_id,
                        message_id = ?message.id(),
                        "Message skipped by retry logic"
                    );
                    if let Some(mut job) = job_store.get(&job_id).await {
                        job.set_error("Message exceeded retry limit".to_string());
                        job_store.update(job).await;
                    }
                    return;
                }
            };

            debug!(
                ?job_id,
                message_id = ?message.id(),
                origin = message.origin,
                destination = message.destination,
                nonce = message.nonce,
                "Injecting message into processor queue"
            );

            // Inject into MessageProcessor channel
            // This bypasses the database entirely
            let queue_op: QueueOperation = Box::new(pending_msg);
            if let Err(err) = send_channel.send(queue_op) {
                error!(?job_id, ?err, "Failed to send message to processor channel");
                if let Some(mut job) = job_store.get(&job_id).await {
                    job.set_error(format!("Failed to queue message: {}", err));
                    job_store.update(job).await;
                }
                return;
            }

            info!(
                ?job_id,
                message_id = ?message.id(),
                "Message successfully injected into processor queue"
            );

            // Update job status to submitting
            // Note: The actual submission happens asynchronously in MessageProcessor
            // We don't have direct visibility into when it's actually submitted/confirmed
            // For now, mark it as "submitted" after injection
            if let Some(mut job) = job_store.get(&job_id).await {
                job.update_status(RelayStatus::Submitting);
                job_store.update(job).await;
            }

            // TODO: Add monitoring/polling to detect when message is actually submitted
            // This would require either:
            // 1. Polling origin_db for message submission status
            // 2. Adding a callback mechanism to MessageProcessor
            // 3. Watching chain events for the destination transaction
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_worker_construction() {
        use std::collections::HashMap;

        let job_store = crate::fast_relay::JobStore::new();
        let send_channels = Arc::new(HashMap::new());
        let msg_ctxs = Arc::new(HashMap::new());

        let worker = FastRelayWorker::new(job_store, send_channels, msg_ctxs, 66);
        assert_eq!(worker.max_retries, 66);
    }
}
