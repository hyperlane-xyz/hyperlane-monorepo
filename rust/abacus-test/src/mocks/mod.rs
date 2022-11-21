/// Mock outbox contract
pub mod outbox;

/// Mock inbox contract
pub mod inbox;

/// Mock indexer
pub mod indexer;

/// Mock SyncBlockRangeCursor
pub mod cursor;

pub use indexer::MockIndexer;
pub use outbox::MockOutboxContract;
