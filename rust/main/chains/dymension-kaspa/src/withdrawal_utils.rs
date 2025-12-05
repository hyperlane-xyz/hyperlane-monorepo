use dym_kas_relayer::KaspaBridgeMetrics;
use hyperlane_core::HyperlaneMessage;
use std::collections::HashSet;

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
) -> Vec<usize> {
    let processed_ids: HashSet<_> = processed_msgs.iter().map(|m| m.id()).collect();
    all_msgs
        .iter()
        .enumerate()
        .filter_map(|(i, msg)| (!processed_ids.contains(&msg.id())).then_some(i))
        .collect()
}
