#[cfg(feature = "aleo")]
pub use aleo::AleoTxPrecursor;
pub use ethereum::EthereumTxPrecursor;
pub use factory::AdapterFactory;
#[cfg(feature = "radix")]
pub use radix::RadixTxPrecursor;
#[cfg(feature = "sealevel")]
pub use sealevel::SealevelTxPrecursor;

mod factory;

// chains modules below
#[cfg(feature = "aleo")]
mod aleo;
#[cfg(feature = "cosmos")]
mod cosmos;
pub mod ethereum;
#[cfg(feature = "radix")]
pub mod radix;
#[cfg(feature = "sealevel")]
pub mod sealevel;

#[cfg(all(test, feature = "aleo"))]
pub use aleo::AleoAdapter;
