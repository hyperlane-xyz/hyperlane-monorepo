pub mod adapter;

mod precursor;

pub use precursor::{Precursor, RadixTxPrecursor};

#[cfg(test)]
pub mod tests;
