//! This crate contains mocks and utilities for testing Hyperlane agents.

#![forbid(unsafe_code)]
#![cfg_attr(test, warn(missing_docs))]
#![forbid(where_clauses_object_safety)]

/// Mock contracts
pub mod mocks;

/// Testing utilities
pub mod test_utils;
