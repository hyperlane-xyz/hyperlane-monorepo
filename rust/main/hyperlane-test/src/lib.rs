//! This crate contains mocks and utilities for testing Hyperlane agents.

#![forbid(unsafe_code)]
#![cfg_attr(test, warn(missing_docs))]
#![allow(unknown_lints)] // TODO: `rustc` 1.80.1 clippy issue

/// Mock contracts
pub mod mocks;
