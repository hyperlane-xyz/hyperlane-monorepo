pub mod adapter;

#[cfg(test)]
pub mod tests;

mod precursor;

pub use precursor::{Precursor, RadixTxPrecursor};
