use std::ffi::{OsStr, OsString};

use config::{ConfigError, Map, Source, Value, ValueKind};
use hyperlane_core::unwrap_or_none_result;
use itertools::Itertools;

/// A source for loading configuration from command line arguments.
///
/// * `--key=value`
/// * `--key="value"`
/// * `--key='value'`
/// * `--key value`
/// * `--key` (value is an empty string)
#[must_use]
#[derive(Clone, Debug, Default)]
pub struct CommandLineArguments {
    /// Optional character sequence that separates each key segment in an
    /// environment key pattern. Consider a nested configuration such as
    /// `redis.password`, a separator of `-` would allow an environment key
    /// of `redis-password` to match.
    separator: Option<String>,

    /// Ignore empty env values (treat as unset).
    ignore_empty: bool,

    /// Alternate source for the environment. This can be used when you want to
    /// test your own code using this source, without the need to change the
    /// actual system environment variables.
    source: Option<Vec<OsString>>,
}

#[allow(unused)]
impl CommandLineArguments {
    pub fn separator(mut self, s: &str) -> Self {
        self.separator = Some(s.into());
        self
    }

    pub fn ignore_empty(mut self, ignore: bool) -> Self {
        self.ignore_empty = ignore;
        self
    }

    pub fn source<I, S>(mut self, source: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.source = Some(source.into_iter().map(|s| s.as_ref().to_owned()).collect());
        self
    }
}

impl Source for CommandLineArguments {
    fn clone_into_box(&self) -> Box<dyn Source + Send + Sync> {
        Box::new((*self).clone())
    }

    fn collect(&self) -> Result<Map<String, Value>, ConfigError> {
        let mut m = Map::new();
        let uri: String = "program argument".into();

        let separator = self.separator.as_deref().unwrap_or("-");

        let mut args = if let Some(source) = &self.source {
            ArgumentParser::from_vec(source.clone())
        } else {
            ArgumentParser::from_env()
        };

        while let Some((key, value)) = args
            .next()
            .transpose()
            .map_err(|e| ConfigError::Foreign(Box::new(e)))?
        {
            if self.ignore_empty && value.is_empty() {
                continue;
            }

            let key = key.split(separator).join(".");

            m.insert(key, Value::new(Some(&uri), ValueKind::String(value)));
        }

        let remaining = args.finish();
        if remaining.is_empty() {
            Ok(m)
        } else {
            Err(ConfigError::Message("Could not parse all arguments".into()))
        }
    }
}

/// An ultra simple CLI arguments parser.
/// Adapted from pico-args 0.5.0.
#[derive(Clone, Debug)]
pub struct ArgumentParser(Vec<OsString>);

impl ArgumentParser {
    /// Creates a parser from a vector of arguments.
    ///
    /// The executable path **must** be removed.
    ///
    /// This can be used for supporting `--` arguments to forward to another
    /// program.
    fn from_vec(args: Vec<OsString>) -> Self {
        ArgumentParser(args)
    }

    /// Creates a parser from [`env::args_os`].
    ///
    /// The executable path will be removed.
    ///
    /// [`env::args_os`]: https://doc.rust-lang.org/stable/std/env/fn.args_os.html
    fn from_env() -> Self {
        let mut args: Vec<_> = std::env::args_os().collect();
        args.remove(0);
        ArgumentParser(args)
    }

    /// Returns a list of remaining arguments.
    ///
    /// It's up to the caller what to do with them.
    /// One can report an error about unused arguments,
    /// other can use them for further processing.
    fn finish(self) -> Vec<OsString> {
        self.0
    }
}

impl Iterator for ArgumentParser {
    type Item = Result<(String, String), Error>;

    fn next(&mut self) -> Option<Self::Item> {
        let (k, v, kind, idx) = match self.find_next_kv_pair() {
            Ok(Some(tup)) => tup,
            Ok(None) => return None,
            Err(e) => return Some(Err(e)),
        };

        match kind {
            PairKind::SingleArgument => {
                self.0.remove(idx);
            }
            PairKind::TwoArguments => {
                self.0.remove(idx.saturating_add(1));
                self.0.remove(idx);
            }
        }

        Some(Ok((k, v)))
    }
}

// internal workings
impl ArgumentParser {
    #[inline(never)]
    fn find_next_kv_pair(&mut self) -> Result<Option<(String, String, PairKind, usize)>, Error> {
        let idx = unwrap_or_none_result!(self.index_of_next_key());
        // full term without leading '--'
        let term = &os_to_str(&self.0[idx])?[2..];
        if term.is_empty() {
            return Err(Error::EmptyKey);
        }

        if let Some((key, value)) = term.split_once('=') {
            // Parse a `--key=value` pair.
            let key = key.to_owned();

            // Check for quoted value.
            let value = if starts_with(value, b'"') {
                if !ends_with(value, b'"') {
                    // A closing quote must be the same as an opening one.
                    return Err(Error::UnmatchedQuote(key));
                }
                &value[1..value.len().saturating_sub(1)]
            } else if starts_with(value, b'\'') {
                if !ends_with(value, b'\'') {
                    // A closing quote must be the same as an opening one.
                    return Err(Error::UnmatchedQuote(key));
                }
                &value[1..value.len().saturating_sub(1)]
            } else {
                value
            };

            Ok(Some((key, value.to_owned(), PairKind::SingleArgument, idx)))
        } else {
            // Parse a `--key value` pair.
            let key = term.to_owned();
            let value = self
                .0
                .get(idx.saturating_add(1))
                .map(|v| os_to_str(v))
                .transpose()?
                .unwrap_or("");

            if value.is_empty() || value.starts_with('-') {
                // the next value is another key
                Ok(Some((key, "".to_owned(), PairKind::SingleArgument, idx)))
            } else {
                Ok(Some((key, value.to_owned(), PairKind::TwoArguments, idx)))
            }
        }
    }

    fn index_of_next_key(&self) -> Option<usize> {
        self.0.iter().position(|v| {
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                v.len() >= 2 && &v.as_bytes()[0..2] == b"--"
            }
            #[cfg(not(unix))]
            {
                v.len() >= 2 && v.to_str().map(|v| v.starts_with("--")).unwrap_or(false)
            }
        })
    }
}

#[inline]
fn starts_with(text: &str, c: u8) -> bool {
    if text.is_empty() {
        false
    } else {
        text.as_bytes()[0] == c
    }
}

#[inline]
fn ends_with(text: &str, c: u8) -> bool {
    text.as_bytes()
        .iter()
        .last()
        .map(|v| *v == c)
        .unwrap_or(false)
}

#[inline]
fn os_to_str(text: &OsStr) -> Result<&str, Error> {
    text.to_str().ok_or(Error::NonUtf8Argument)
}

/// A list of possible errors.
#[derive(Clone, Debug, thiserror::Error)]
pub enum Error {
    /// Arguments must be a valid UTF-8 strings.
    #[error("argument is not a UTF-8 string")]
    NonUtf8Argument,

    /// Found '--` or a key with nothing after the prefix
    #[error("key name is empty (possibly after removing prefix)")]
    EmptyKey,

    /// Could not find closing quote for a value.
    #[error("unmatched quote in `{0}`")]
    UnmatchedQuote(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PairKind {
    SingleArgument,
    TwoArguments,
}

#[cfg(test)]
mod test {
    use super::*;

    macro_rules! assert_arg {
        ($config:expr, $key:literal, $value:literal) => {
            let origin = "program argument".to_owned();
            assert_eq!(
                $config.remove($key),
                Some(Value::new(
                    Some(&origin),
                    ValueKind::String($value.to_owned())
                )),
                $key
            );
        };
    }

    const ARGUMENTS: &[&str] = &[
        "--key-a",
        "value-a",
        "--key-b=value-b",
        "--key-c-partA=\"value c a\"",
        "--key-c-PartB=\"value c b\"",
        "--key-d='valUE d'",
        "--key-e=''",
        "--key-f",
        "--key-g=value-g",
        "--key-h",
    ];

    #[test]
    fn default_case() {
        let mut config = CommandLineArguments::default()
            .source(ARGUMENTS)
            .collect()
            .unwrap();

        assert_arg!(config, "key.a", "value-a");
        assert_arg!(config, "key.b", "value-b");
        assert_arg!(config, "key.c.partA", "value c a");
        assert_arg!(config, "key.c.PartB", "value c b");
        assert_arg!(config, "key.d", "valUE d");
        assert_arg!(config, "key.e", "");
        assert_arg!(config, "key.f", "");
        assert_arg!(config, "key.g", "value-g");
        assert_arg!(config, "key.h", "");

        assert!(config.is_empty());
    }

    #[test]
    fn ignore_empty() {
        let mut config = CommandLineArguments::default()
            .source(ARGUMENTS)
            .ignore_empty(true)
            .collect()
            .unwrap();

        assert_arg!(config, "key.a", "value-a");
        assert_arg!(config, "key.b", "value-b");
        assert_arg!(config, "key.c.partA", "value c a");
        assert_arg!(config, "key.c.PartB", "value c b");
        assert_arg!(config, "key.d", "valUE d");
        assert_arg!(config, "key.g", "value-g");

        assert!(config.is_empty());
    }
}
