use async_trait::async_trait;

use crate::{
    traits::{ChainCommunicationError, Common, TxOutcome},
    Message, SignedUpdate, Update,
};

/// Interface for the Home chain contract. Allows abstraction over different
/// chains
#[async_trait]
pub trait Home: Common {
    /// Fetch the message to destination at the sequence number (or error).
    /// This should fetch events from the chain API
    async fn lookup_message(
        &self,
        destination: u32,
        sequence: u32,
    ) -> Result<Option<Vec<u8>>, ChainCommunicationError>;

    /// Fetch the sequence
    async fn sequences(&self, destination: u32) -> Result<u32, ChainCommunicationError>;

    /// Queue a message.
    async fn enqueue(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError>;

    /// Submit an improper update for slashing
    async fn improper_update(
        &self,
        update: &SignedUpdate,
    ) -> Result<TxOutcome, ChainCommunicationError>;

    /// Create a valid update based on the chain's current state.
    /// This merely suggests an update. It does NOT ensure that no other valid
    /// update has been produced. The updater MUST take measures to prevent
    /// double-updating.
    async fn produce_update(&self) -> Result<Update, ChainCommunicationError>;
}
