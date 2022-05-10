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
//! # TODO
//! Later we can add support for backtraces and spantraces. These are not currently in-use in our
//! deployments and they are difficult to format correctly, so holding off for now.
//!
//! [`eyre::EyreHandler`]: https://docs.rs/eyre/*/eyre/trait.EyreHandler.html
//! [`eyre`]: https://docs.rs/eyre

use core::fmt::{self, Debug, Formatter};
use std::error::Error;
use std::iter;

// use ::backtrace::Backtrace;
// use backtrace::{BacktraceFmt, BytesOrWideString, PrintFmt};
use eyre::{EyreHandler, Result};

/// The default separator used to delimitate lines in error messages.
const DEFAULT_LINE_SEPARATOR: &str = " ## ";
/// The default separator used to delimitate error sections.
const DEFAULT_SECTION_SEPARATOR: &str = " ##$$## ";

// pub trait BacktraceExt {
//     /// Returns a reference to the captured backtrace if one exists
//     ///
//     /// # Example
//     ///
//     /// ```rust
//     /// use eyre::eyre;
//     /// use abacus_base::oneline_eyre::{self, BacktraceExt};
//     /// oneline_eyre::install();
//     /// std::env::set_var("RUST_BACKTRACE", "1");
//     ///
//     /// let report = eyre!("capture a report");
//     /// assert!(report.backtrace().is_some());
//     /// ```
//     fn backtrace(&self) -> Option<&Backtrace>;
// }
//
// impl BacktraceExt for eyre::Report {
//     fn backtrace(&self) -> Option<&Backtrace> {
//         self.handler()
//             .downcast_ref::<Handler>()
//             .and_then(|handler| handler.backtrace.as_ref())
//     }
// }

/// A custom context type for minimal error reporting via `eyre`
pub struct Handler {
    line_separator: &'static str,
    section_separator: &'static str,
    // backtrace: Option<Backtrace>,
    // show_full_paths: bool,
}

impl Handler {
    /// Format a single error on a single line
    fn fmt_error(&self, error: &(dyn Error + 'static), f: &mut Formatter<'_>) -> fmt::Result {
        let err_str = format!("{error}").replace('\n', self.line_separator);
        write!(f, "{err_str}")
    }

    /// Format the cause of an error on a single line.
    fn fmt_cause(&self, cause: &(dyn Error + 'static), f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}Caused by:", self.section_separator)?;

        let errors = iter::successors(Some(cause), |e| (*e).source());
        for (n, error) in errors.enumerate() {
            write!(f, "{}({n}) ", self.line_separator)?;
            self.fmt_error(error, f)?;
        }
        Ok(())
    }

    // /// Format a backtrace onto a single line.
    // /// Largely stolen from backtrace's Debug implementation.
    // fn fmt_backtrace(&self, backtrace: &Backtrace, f: &mut Formatter<'_>) -> fmt::Result {
    //     write!(f, "{}Stack backtrace:", self.section_separator)?;
    //
    //     // When printing paths we try to strip the cwd if it exists, otherwise
    //     // we just print the path as-is. Note that we also only do this for the
    //     // short format, because if it's full we presumably want to print
    //     // everything.
    //     let cwd = if !self.show_full_paths {
    //         env::current_dir().ok()
    //     } else { None };
    //     let mut print_path =
    //         move |fmt: &mut Formatter<'_>, path: BytesOrWideString<'_>| {
    //             let path = path.into_path_buf();
    //             if let Some(cwd) = &cwd {
    //                 if let Ok(suffix) = path.strip_prefix(cwd) {
    //                     return Display::fmt(&suffix.display(), fmt);
    //                 }
    //             }
    //             Display::fmt(&path.display(), fmt)
    //         };
    //
    //     let mut backtrace_fmt = BacktraceFmt::new(f, PrintFmt::Full, &mut print_path);
    //     backtrace_fmt.add_context()?;
    //     for frame in backtrace.frames() {
    //         backtrace_fmt.frame().backtrace_frame(frame)?;
    //         // write!(f, "{}({n}) {}", self.line_separator)
    //     }
    //     backtrace_fmt.finish()
    // }
}

impl EyreHandler for Handler {
    fn debug(&self, error: &(dyn Error + 'static), f: &mut Formatter<'_>) -> fmt::Result {
        if f.alternate() {
            return Debug::fmt(error, f);
        }

        self.fmt_error(error, f)?;

        if let Some(cause) = error.source() {
            self.fmt_cause(cause, f)?;
        }
        // if let Some(backtrace) = &self.backtrace {
        //     self.fmt_backtrace(backtrace, f)?;
        // }

        Ok(())

        // if f.alternate() {
        //     return core::fmt::Debug::fmt(error, f);
        // }
        //
        // write!(f, "{}", error)?;
        //
        // if let Some(cause) = error.source() {
        //     let errors = std::iter::successors(Some(cause), |e| (*e).source());
        //     for error in errors {
        //         write!(f, "{}{}", self.separator, error)?;
        //     }
        // }
        //
        // Ok(())
    }
}

/// Builder for customizing the behavior of the global error report hook
#[derive(Debug, Default)]
pub struct HookBuilder {
    capture_backtrace_by_default: bool,
    line_separator: Option<&'static str>,
    section_separator: Option<&'static str>,
    // show_full_paths: bool,
}

impl HookBuilder {
    fn make_handler(&self, _error: &(dyn Error + 'static)) -> Handler {
        // let backtrace = if self.capture_enabled() {
        //     Some(Backtrace::new())
        // } else {
        //     None
        // };

        Handler {
            // backtrace,
            line_separator: self.line_separator.unwrap_or(DEFAULT_LINE_SEPARATOR),
            section_separator: self.section_separator.unwrap_or(DEFAULT_SECTION_SEPARATOR),
            // show_full_paths: self.show_full_paths,
        }
    }

    // fn capture_enabled(&self) -> bool {
    //     env::var("RUST_LIB_BACKTRACE")
    //         .or_else(|_| env::var("RUST_BACKTRACE"))
    //         .map(|val| val != "0")
    //         .unwrap_or(self.capture_backtrace_by_default)
    // }

    /// Configures the default capture mode for `Backtraces` in error reports
    pub fn capture_backtrace_by_default(mut self, cond: bool) -> Self {
        self.capture_backtrace_by_default = cond;
        self
    }

    // /// Configures whether full paths should be shown in backtraces or relative paths from the
    // /// current working directory.
    // pub fn show_full_paths(mut self, cond: bool) -> Self {
    //     self.show_full_paths = cond;
    //     self
    // }

    /// Install the given hook as the global error report hook
    pub fn install(self) -> Result<()> {
        eyre::set_hook(Box::new(move |e| Box::new(self.make_handler(e))))?;
        Ok(())
    }
}

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
    HookBuilder::default().install()
}
