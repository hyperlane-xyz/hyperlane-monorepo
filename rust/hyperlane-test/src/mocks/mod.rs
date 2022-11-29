/// Mock mailbox contract
pub mod mailbox;

/// Mock indexer
pub mod indexer;

/// Mock SyncBlockRangeCursor
pub mod cursor;

pub use indexer::MockIndexer;
pub use mailbox::MockMailboxContract;
