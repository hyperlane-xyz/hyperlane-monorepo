pub use contract::CosmosMailbox;
pub use delivery_indexer::CosmosMailboxDeliveryIndexer;
pub use dispatch_indexer::CosmosMailboxDispatchIndexer;

mod contract;

/// Cosmos Mailbox Delivery Indexer
pub mod delivery_indexer;
/// Cosmos Mailbox Dispatch Indexer
pub mod dispatch_indexer;
