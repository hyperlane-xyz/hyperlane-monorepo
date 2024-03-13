pub use self::error::*;

#[cfg(feature = "async")]
pub use self::fallback::*;

#[cfg(feature = "async")]
pub use self::retry::*;

mod error;
#[cfg(feature = "async")]
mod fallback;

#[cfg(feature = "async")]
mod retry;
