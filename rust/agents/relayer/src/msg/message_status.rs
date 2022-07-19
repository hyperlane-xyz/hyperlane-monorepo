use std::sync::Arc;

use abacus_base::CachingInbox;
use abacus_core::{db::AbacusDB, CommittedMessage, Inbox, MessageStatus};
use eyre::Result;

#[derive(Clone, Debug)]
pub(crate) enum ProcessedStatusOracle {
    Production(Impl),
    #[allow(dead_code)]
    #[cfg(test)]
    TestDouble,
}

impl ProcessedStatusOracle {
    pub(crate) async fn message_status(&self, msg: &CommittedMessage) -> Result<MessageStatus> {
        match self {
            ProcessedStatusOracle::Production(o) => o.message_status(msg).await,
            #[cfg(test)]
            ProcessedStatusOracle::TestDouble => Ok(MessageStatus::None),
        }
    }
    pub(crate) fn mark_processed(&self, msg: &CommittedMessage) -> Result<()> {
        match self {
            ProcessedStatusOracle::Production(o) => o.mark_processed(msg),
            #[cfg(test)]
            ProcessedStatusOracle::TestDouble => Ok(()),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Impl {
    inbox: Arc<CachingInbox>,
    db: AbacusDB,
}

impl Impl {
    pub(crate) fn new(inbox: Arc<CachingInbox>, db: AbacusDB) -> Self {
        Self { inbox, db }
    }
    pub(crate) async fn message_status(&self, msg: &CommittedMessage) -> Result<MessageStatus> {
        Ok(self.inbox.message_status(msg.to_leaf()).await?)
    }
    pub(crate) fn mark_processed(&self, msg: &CommittedMessage) -> Result<()> {
        Ok(self.db.mark_leaf_as_processed(msg.leaf_index)?)
    }
}
