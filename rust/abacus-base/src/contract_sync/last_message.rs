use abacus_core::{ListValidity, RawCommittedMessage};

/// Optional latest leaf index struct. Optional struct to account for
/// possibility that ContractSync is still yet to see it's first message. We
/// want to check for validity of new list of messages against a potential
/// previous message (Some case) but also still validate the new messages in
/// the case that we have not seen any previous messages (None case).
#[derive(Debug)]
pub(crate) struct OptLatestLeafIndex(Option<u32>);

impl From<u32> for OptLatestLeafIndex {
    fn from(latest_message: u32) -> Self {
        Self(Some(latest_message))
    }
}

impl From<Option<u32>> for OptLatestLeafIndex {
    fn from(opt: Option<u32>) -> Self {
        Self(opt)
    }
}

impl AsRef<Option<u32>> for OptLatestLeafIndex {
    fn as_ref(&self) -> &Option<u32> {
        &self.0
    }
}

impl OptLatestLeafIndex {
    /// Check if the list of sorted messages is a valid continuation of the OptLatestLeafIndex. If self is Some, check the validity of the list in continuation of self. If self is None, check the validity of just the list.
    pub fn valid_continuation(&self, sorted_messages: &[RawCommittedMessage]) -> ListValidity {
        if sorted_messages.is_empty() {
            return ListValidity::Empty;
        }

        // If we have seen another leaf in a previous block range, ensure
        // the batch contains the consecutive next leaf
        if let Some(last_seen) = self.as_ref() {
            let has_desired_message = sorted_messages
                .iter()
                .any(|message| *last_seen == message.leaf_index - 1);
            if !has_desired_message {
                return ListValidity::InvalidContinuation;
            }
        }

        // Ensure no gaps in new batch of leaves
        for pair in sorted_messages.windows(2) {
            if pair[0].leaf_index != pair[1].leaf_index - 1 {
                return ListValidity::ContainsGaps;
            }
        }

        ListValidity::Valid
    }
}
