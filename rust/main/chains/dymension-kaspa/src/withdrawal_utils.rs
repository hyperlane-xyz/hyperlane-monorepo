use crate::kas_relayer::withdraw::minimum::is_dust_message;
use crate::kas_relayer::KaspaBridgeMetrics;
use hyperlane_core::{HyperlaneMessage, U256};
use std::collections::HashSet;
use tracing::info;

pub enum WithdrawalStage {
    Initiated,
    Processed,
    Failed,
}

pub fn record_withdrawal_batch_metrics(
    metrics: &KaspaBridgeMetrics,
    messages: &[HyperlaneMessage],
    stage: WithdrawalStage,
) {
    match stage {
        WithdrawalStage::Initiated => {
            if !messages.is_empty() {
                metrics.record_withdrawal_batch_size(messages.len() as u64);
            }
            for msg in messages {
                if let Some(amount) = crate::hl_message::parse_withdrawal_amount(msg) {
                    let message_id = format!("{:?}", msg.id());
                    metrics.record_withdrawal_initiated(&message_id, amount);
                }
            }
        }
        WithdrawalStage::Processed => {
            for msg in messages {
                if let Some(amount) = crate::hl_message::parse_withdrawal_amount(msg) {
                    let message_id = format!("{:?}", msg.id());
                    metrics.record_withdrawal_processed(&message_id, amount);
                }
            }
        }
        WithdrawalStage::Failed => {
            for msg in messages {
                if let Some(amount) = crate::hl_message::parse_withdrawal_amount(msg) {
                    let message_id = format!("{:?}", msg.id());
                    metrics.record_withdrawal_failed(&message_id, amount);
                }
            }
        }
    }
}

pub fn calculate_failed_indexes(
    all_msgs: &[HyperlaneMessage],
    processed_msgs: &[HyperlaneMessage],
    min_sompi: U256,
) -> Vec<usize> {
    let processed_ids: HashSet<_> = processed_msgs.iter().map(|m| m.id()).collect();
    all_msgs
        .iter()
        .enumerate()
        .filter_map(|(i, msg)| {
            if processed_ids.contains(&msg.id()) {
                return None;
            }
            // Exclude dust messages from failed indexes to prevent retry
            if is_dust_message(msg, min_sompi) {
                info!(
                    message_id = ?msg.id(),
                    min_sompi = min_sompi.as_u64(),
                    "kaspa mailbox: not retrying dust message"
                );
                return None;
            }
            Some(i)
        })
        .collect()
}
