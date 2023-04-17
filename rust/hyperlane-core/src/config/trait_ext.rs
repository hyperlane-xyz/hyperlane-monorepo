use eyre::Report;
use crate::config::{ConfigParsingError, ConfigPath, ConfigResult};

/// Extension trait to better support ConfigResults with non-ConfigParsingError
/// results.
pub trait ConfigErrResultExt<T> {
    /// Convert a result into a ConfigResult, using the given path for the
    /// error.
    fn into_config_result(self, path: impl FnOnce() -> ConfigPath) -> ConfigResult<T>;

    /// Take the error from a result and merge it into the given
    /// ConfigParsingError.
    fn take_err(self, err: &mut ConfigParsingError, path: impl FnOnce() -> ConfigPath)
        -> Option<T>;
}

impl<T, E> ConfigErrResultExt<T> for Result<T, E>
where
    E: Into<Report>,
{
    fn into_config_result(self, path: impl FnOnce() -> ConfigPath) -> ConfigResult<T> {
        self.map_err(|e| ConfigParsingError(vec![(path(), e.into())]))
    }

    fn take_err(
        self,
        err: &mut ConfigParsingError,
        path: impl FnOnce() -> ConfigPath,
    ) -> Option<T> {
        match self {
            Ok(v) => Some(v),
            Err(e) => {
                err.merge(ConfigParsingError(vec![(path(), e.into())]));
                None
            }
        }
    }
}

/// Extension trait to better support ConfigResults.
pub trait ConfigResultExt<T> {
    /// Take the error from a result and merge it into the given
    /// ConfigParsingError.
    fn take_config_err(self, err: &mut ConfigParsingError) -> Option<T>;
}

impl<T> ConfigResultExt<T> for ConfigResult<T> {
    fn take_config_err(self, err: &mut ConfigParsingError) -> Option<T> {
        match self {
            Ok(v) => Some(v),
            Err(e) => {
                err.merge(e);
                None
            }
        }
    }
}
