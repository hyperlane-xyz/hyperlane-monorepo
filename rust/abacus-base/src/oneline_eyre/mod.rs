//! This provides a custom [`eyre::EyreHandler`] type for usage with [`eyre`] that provides
//! a minimal error report with no additional context. Essentially the minimal implementation of an
//! error reporter.
//!
//! ## Setup
//!
//! Install the hook handler before constructing any `eyre::Report` types.
//!
//! # Example
//!
//! ```rust,should_panic
//! use eyre::{eyre, Report, Result, WrapErr};
//!
//! use abacus_base::oneline_eyre;
//!
//!
//! fn main() -> Result<()> {
//!     oneline_eyre::install()?;
//!     let e: Report = eyre!("oh no this program is just bad!");
//!     Err(e).wrap_err("usage example successfully experienced a failure")
//! }
//! ```
//!
//! [`eyre::EyreHandler`]: https://docs.rs/eyre/*/eyre/trait.EyreHandler.html
//! [`eyre`]: https://docs.rs/eyre

use eyre::Result;

use handler::HookBuilder;

mod handler;

/// Install the default `oneline_eyre` hook as the global error report hook.
///
/// # Details
///
/// This function must be called to enable the customization of `eyre::Report`
/// provided by `oneline_eyre`. This function should be called early, ideally
/// before any errors could be encountered.
///
/// Only the first install will succeed. Calling this function after another
/// report handler has been installed will cause an error. **Note**: This
/// function _must_ be called before any `eyre::Report`s are constructed to
/// prevent the default handler from being installed.
pub fn install() -> Result<()> {
    HookBuilder::default()
        .capture_backtrace_by_default(true)
        .install()
}
