// use std::fmt::Display;

use hyperlane_core::ModuleType;

#[derive(Debug, thiserror::Error)]
pub enum RelayerError {
    #[error("Failed to fetch metadata")]
    MetadataFetchingError,
    #[error("Unknown or invalid module type ({0})")]
    UnsupportedModuleType(ModuleType),
    #[error("Exceeded max depth when building metadata ({0})")]
    MaxDepthExceeded(u32),
}
