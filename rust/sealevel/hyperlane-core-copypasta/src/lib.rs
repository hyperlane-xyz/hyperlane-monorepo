//! This crate contains core primitives, traits, and types for Abacus
//! implementations.

// #![warn(missing_docs)]
#![warn(unused_extern_crates)]
#![forbid(unsafe_code)]
#![forbid(where_clauses_object_safety)]

/// Accumulator management
pub mod accumulator;

/// Async Traits for Outboxes & Inboxes for use in applications
pub mod traits;
pub use traits::*;

/// Core hyperlane system data structures
pub mod types;
pub use types::*;

/// Error types for Hyperlane
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneError {
    // /// Signature Error pasthrough
    // #[error(transparent)]
    // SignatureError(#[from] SignatureError),
    /// IO error from Read/Write usage
    #[error(transparent)]
    IoError(#[from] std::io::Error),
}
