use std::env;

use config::{ConfigError, Map, Source, Value, ValueKind};
use itertools::Itertools;

#[must_use]
#[derive(Clone, Debug, Default)]
pub struct Environment {
    /// Optional prefix that will limit access to the environment to only keys that
    /// begin with the defined prefix.
    ///
    /// A prefix must include any desired separator. e.g. `CONFIG_`.
    ///
    /// For example, the key `CONFIG_DEBUG` would become `DEBUG` with a prefix of `CONFIG_`.
    prefix: Option<String>,

    /// Optional character sequence that separates each key segment in an environment key pattern.
    /// Consider a nested configuration such as `redis.password`, a separator of `_` would allow
    /// an environment key of `REDIS_PASSWORD` to match. Defaults to `_`.
    separator: Option<String>,

    /// Ignore empty env values (treat as unset).
    ignore_empty: bool,

    /// Alternate source for the environment. This can be used when you want to test your own code
    /// using this source, without the need to change the actual system environment variables.
    source: Option<Map<String, String>>,
}

#[allow(unused)]
impl Environment {
    pub fn prefix(mut self, s: &str) -> Self {
        self.prefix = Some(s.into());
        self
    }

    pub fn separator(mut self, s: &str) -> Self {
        self.separator = Some(s.into());
        self
    }

    pub fn ignore_empty(mut self, ignore: bool) -> Self {
        self.ignore_empty = ignore;
        self
    }

    pub fn source<'a, I, S>(mut self, source: I) -> Self
    where
        I: IntoIterator<Item = (S, S)>,
        S: AsRef<str> + 'a,
    {
        self.source = Some(
            source
                .into_iter()
                .map(|(k, v)| (k.as_ref().to_owned(), v.as_ref().to_owned()))
                .collect(),
        );
        self
    }
}

impl Source for Environment {
    fn clone_into_box(&self) -> Box<dyn Source + Send + Sync> {
        Box::new((*self).clone())
    }

    fn collect(&self) -> Result<Map<String, Value>, ConfigError> {
        let uri: String = "program environment".into();

        let separator = self.separator.as_deref().unwrap_or("_");

        // Define a prefix pattern to test and exclude from keys
        let prefix_pattern = self.prefix.as_deref().unwrap_or("");

        let mapper = |(key, value): (String, String)| -> Option<(String, Value)> {
            let key = if prefix_pattern.is_empty() {
                key
            } else if let Some(key) = key.strip_prefix(prefix_pattern) {
                key.into()
            } else {
                return None;
            };

            // Treat empty environment variables as unset
            if self.ignore_empty && value.is_empty() {
                return None;
            }

            let key = key.split(separator).join(".");
            Some((key, Value::new(Some(&uri), ValueKind::String(value))))
        };

        Ok(if let Some(source) = &self.source {
            source.clone().into_iter().filter_map(mapper).collect()
        } else {
            env::vars().filter_map(mapper).collect()
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;

    macro_rules! assert_env {
        ($config:expr, $key:literal, $value:literal) => {
            let origin = "program environment".to_owned();
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

    const ENVS: &[(&str, &str)] = &[
        ("PRE__KEY__A", "value-a"),
        ("PRE__key__b", ""),
        ("PRE__KEY__C__PART_A", "value c a"),
        ("PRE__KEY__C_PART_B", "value c b"),
    ];

    #[test]
    fn default_case() {
        let mut config = Environment::default()
            .source(ENVS.iter().cloned())
            .prefix("PRE__")
            .separator("__")
            .collect()
            .unwrap();

        assert_env!(config, "KEY.A", "value-a");
        assert_env!(config, "key.b", "");
        assert_env!(config, "KEY.C.PART_A", "value c a");
        assert_env!(config, "KEY.C_PART_B", "value c b");

        assert!(config.is_empty());
    }

    #[test]
    fn ignore_empty() {
        let mut config = Environment::default()
            .source(ENVS.iter().cloned())
            .ignore_empty(true)
            .source(ENVS.iter().cloned())
            .prefix("PRE__")
            .separator("__")
            .collect()
            .unwrap();

        assert_env!(config, "KEY.A", "value-a");
        assert_env!(config, "KEY.C.PART_A", "value c a");
        assert_env!(config, "KEY.C_PART_B", "value c b");

        assert!(config.is_empty());
    }
}
