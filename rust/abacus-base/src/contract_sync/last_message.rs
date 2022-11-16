use abacus_core::{AbacusMessage, ListValidity};

/// Check if the list of sorted messages is a valid continuation of the
/// OptLatestLeafIndex. If the latest index is Some, check the validity of the
/// list in continuation of the latest. If the latest index is None, check the
/// validity of just the list.
///
/// Optional latest leaf index to account for possibility that ContractSync is
/// still yet to see it's first message. We want to check for validity of new
/// list of messages against a potential previous message (Some case) but also
/// still validate the new messages in the case that we have not seen any
/// previous messages (None case).
pub fn validate_message_continuity(
    latest_message_nonce: Option<u32>,
    sorted_messages: &[&AbacusMessage],
) -> ListValidity {
    if sorted_messages.is_empty() {
        return ListValidity::Empty;
    }

    // If we have seen another leaf in a previous block range, ensure
    // the batch contains the consecutive next leaf
    if let Some(last_seen) = latest_message_nonce {
        let has_desired_message = sorted_messages
            .iter()
            .any(|&message| last_seen == message.nonce - 1);
        if !has_desired_message {
            return ListValidity::InvalidContinuation;
        }
    }

    // Ensure no gaps in new batch of leaves
    for pair in sorted_messages.windows(2) {
        if pair[0].nonce != pair[1].nonce - 1 {
            return ListValidity::ContainsGaps;
        }
    }

    ListValidity::Valid
}
