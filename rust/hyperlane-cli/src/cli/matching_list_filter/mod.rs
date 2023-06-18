use hyperlane_core::{HyperlaneMessage, MatchingList};

pub trait MatchingListFilter {
    fn filter(&self, matching_list: MatchingList, messages: Vec<HyperlaneMessage>);
}

pub mod filter_list;
pub mod read;
