//! This crate contains core primitives, traits, and types for Hyperlane
//! implementations.

#![warn(missing_docs)]
#![forbid(unsafe_code)]
#![forbid(where_clauses_object_safety)]

extern crate core;

pub use chain::*;
pub use error::{ChainCommunicationError, ChainResult, HyperlaneProtocolError};
pub use identifiers::HyperlaneIdentifier;
pub use traits::*;
pub use types::*;

/// Accumulator management
pub mod accumulator;

/// Async Traits for contract instances for use in applications
mod traits;
/// Utilities to match contract values
pub mod utils;

/// Testing utilities
#[cfg(any(test, feature = "test-utils"))]
pub mod test_utils;

pub mod config;

/// Core hyperlane system data structures
mod types;

mod chain;
mod error;
