use eyre::Result;
use hyperlane_core::QueueOperation;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::mpsc::UnboundedSender;
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

        Ok(())
    }
}
