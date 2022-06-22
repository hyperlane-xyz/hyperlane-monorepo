use std::error::Error;
use std::fmt::{Debug, Formatter};
use std::{env, fmt, iter};

use backtrace::Backtrace;
use eyre::EyreHandler;

/// The default separator used to delimitate lines in error messages.
const DEFAULT_LINE_SEPARATOR: &str = " ## ";
/// The default separator used to delimitate error sections.
const DEFAULT_SECTION_SEPARATOR: &str = " ##$$## ";

/// A custom context type for minimal error reporting via `eyre`
pub struct Handler {
    line_separator: &'static str,
    section_separator: &'static str,
    backtrace: Option<Backtrace>,
    show_full_paths: bool,
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

    /// Format a backtrace onto a single line.
    fn fmt_backtrace(&self, backtrace: &Backtrace, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}Stack backtrace:", self.section_separator)?;

        backtrace_oneline::fmt_backtrace(backtrace, f, self.line_separator, self.show_full_paths)
    }
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
        if let Some(backtrace) = &self.backtrace {
            self.fmt_backtrace(backtrace, f)?;
        }

        if f.alternate() {
            return Debug::fmt(error, f);
        }

        write!(f, "{}", error)?;

        if let Some(cause) = error.source() {
            let errors = std::iter::successors(Some(cause), |e| (*e).source());
            for error in errors {
                write!(f, "{}{}", self.line_separator, error)?;
            }
        }

        Ok(())
    }
}

/// Builder for customizing the behavior of the global error report hook
#[derive(Debug, Default)]
pub struct HookBuilder {
    capture_backtrace_by_default: bool,
    line_separator: Option<&'static str>,
    section_separator: Option<&'static str>,
    show_full_paths: bool,
}

#[allow(dead_code)]
impl HookBuilder {
    fn make_handler(&self, _error: &(dyn Error + 'static)) -> Handler {
        let backtrace = if self.capture_enabled() {
            Some(Backtrace::new())
        } else {
            None
        };

        Handler {
            backtrace,
            line_separator: self.line_separator.unwrap_or(DEFAULT_LINE_SEPARATOR),
            section_separator: self.section_separator.unwrap_or(DEFAULT_SECTION_SEPARATOR),
            show_full_paths: self.show_full_paths,
        }
    }

    fn capture_enabled(&self) -> bool {
        env::var("RUST_LIB_BACKTRACE")
            .or_else(|_| env::var("RUST_BACKTRACE"))
            .map(|val| val != "0")
            .unwrap_or(self.capture_backtrace_by_default)
    }

    /// Configures the default capture mode for `Backtraces` in error reports
    pub fn capture_backtrace_by_default(mut self, cond: bool) -> Self {
        self.capture_backtrace_by_default = cond;
        self
    }

    /// Configures whether full paths should be shown in backtraces or relative paths from the
    /// current working directory.
    pub fn show_full_paths(mut self, cond: bool) -> Self {
        self.show_full_paths = cond;
        self
    }

    /// Install the given hook as the global error report hook
    pub fn install(self) -> eyre::Result<()> {
        eyre::set_hook(Box::new(move |e| Box::new(self.make_handler(e))))?;
        Ok(())
    }
}
