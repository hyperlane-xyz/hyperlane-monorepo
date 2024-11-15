/// Error type for the cache module.
#[derive(thiserror::Error, Debug)]
pub enum CacheError {
    /// Error when key or value serialization fails.
    #[error("Failed to serialize input: {0}")]
    FailedToSerializeInuput(#[source] serde_json::Error),

    /// Error when enitity fetched from cache is deserialized incorrectly.
    /// Most of the time this can be caused due the missmatch of the type
    /// expected vs actual type of the entity.
    #[error("Failed to deserialize output: {0}")]
    FailedToDeserializeOutput(#[source] serde_json::Error),
}
