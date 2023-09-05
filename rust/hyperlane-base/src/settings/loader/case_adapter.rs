use std::fmt::Debug;

use config::{ConfigError, Map, Source, Value};
use convert_case::Case;
use derive_new::new;

use crate::settings::loader::split_and_recase_key;

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
