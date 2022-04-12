/// Mock outbox contract
pub mod outbox;

/// Mock inbox contract
pub mod inbox;

/// Mock indexer
pub mod indexer;

pub use indexer::MockIndexer;
pub use outbox::MockOutboxContract;
