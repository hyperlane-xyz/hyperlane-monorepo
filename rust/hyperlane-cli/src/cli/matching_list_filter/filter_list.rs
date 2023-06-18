use hyperlane_core::{HyperlaneMessage, MatchingList};

pub struct MatchingListFilter {
    pub matching_list: MatchingList,
    pub messages: Vec<HyperlaneMessage>,
}

impl MatchingListFilter {
    pub fn filter_messages(&self) -> Vec<HyperlaneMessage> {
        self.messages
            .clone()
            .into_iter()
            .filter(|message| self.matching_list.msg_matches(&message, true))
            .collect()
    }
}
