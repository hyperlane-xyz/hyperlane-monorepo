use std::fmt::Debug;

use config::{ConfigError, Map, Source, Value};
use convert_case::{Case, Casing};
use derive_new::new;
use itertools::Itertools;

#[derive(Clone, Debug, new)]
pub struct CaseAdapter<S> {
    inner: S,
    casing: Case,
}

impl<S> Source for CaseAdapter<S>
where
    S: Source + Clone + Send + Sync + 'static,
{
    fn clone_into_box(&self) -> Box<dyn Source + Send + Sync> {
        Box::new(self.clone())
    }

    fn collect(&self) -> Result<Map<String, Value>, ConfigError> {
        self.inner.collect().map(|config| {
            config
                .into_iter()
                .map(|(k, v)| (split_and_recase_key(".", Some(self.casing), k), v))
                .collect()
        })
    }
}

/// Load a settings object from the config locations and re-join the components with the standard
/// `config` crate separator `.`.
fn split_and_recase_key(sep: &str, case: Option<Case>, key: String) -> String {
    if let Some(case) = case {
        // if case is given, replace case of each key component and separate them with `.`
        key.split(sep).map(|s| s.to_case(case)).join(".")
    } else if !sep.is_empty() && sep != "." {
        // Just standardize the separator to `.`
        key.replace(sep, ".")
    } else {
        // no changes needed if there was no separator defined and we are preserving case.
        key
    }
}
