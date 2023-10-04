// use std::fmt::Display;

#[derive(Debug, thiserror::Error)]
pub enum RelayerError {
    #[error("Failed to fetch metadata")]
    MetadataFetchingError,
}
