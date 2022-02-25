use abacus_core::{ListValidity, SignedUpdateWithMeta};
use ethers::core::types::H256;

/// Optional latest new root struct. Optional struct to account for possibility
/// that ContractSync is still yet to see it's first update. We want to check
/// for validity of new list of updates against a potential previous update
/// (Some case) but also still validate the new updates in the case that we
/// have not seen any previous updates (None case).
#[derive(Debug)]
pub(crate) struct OptLatestNewRoot(Option<H256>);

impl From<H256> for OptLatestNewRoot {
    fn from(latest_root: H256) -> Self {
        Self(Some(latest_root))
    }
}

impl From<Option<H256>> for OptLatestNewRoot {
    fn from(opt: Option<H256>) -> Self {
        Self(opt)
    }
}

impl AsRef<Option<H256>> for OptLatestNewRoot {
    fn as_ref(&self) -> &Option<H256> {
        &self.0
    }
}

impl OptLatestNewRoot {
    /// Check if the list of sorted messages is a valid continuation of the OptLatestMessage. If self is Some, check the validity of the list in continuation of self. If self is None, check the validity of just the list.
    pub fn valid_continuation(&self, sorted_updates: &[SignedUpdateWithMeta]) -> ListValidity {
        if sorted_updates.is_empty() {
            return ListValidity::Empty;
        }

        // If we have seen another update in a previous block range, ensure
        // first update in new batch builds off last seen update
        if let Some(last_seen) = self.as_ref() {
            let first_update = sorted_updates.first().unwrap();
            if *last_seen != first_update.signed_update.update.previous_root {
                return ListValidity::Invalid;
            }
        }

        // Ensure no gaps in new batch of leaves
        for pair in sorted_updates.windows(2) {
            if pair[0].signed_update.update.new_root != pair[1].signed_update.update.previous_root {
                return ListValidity::Invalid;
            }
        }

        ListValidity::Valid
    }
}
