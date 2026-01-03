#[cfg(all(test, feature = "aleo"))]
pub use aleo::MockAleoProvider;

#[cfg(feature = "aleo")]
mod aleo;
pub mod evm;
#[cfg(feature = "radix")]
pub mod radix;
#[cfg(feature = "sealevel")]
pub mod svm;

#[cfg(test)]
pub mod test_utils;
