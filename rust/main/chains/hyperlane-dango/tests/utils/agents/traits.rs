use std::collections::{BTreeMap, BTreeSet};

pub trait Args: Sized {
    fn args(self) -> BTreeMap<String, String>;
    fn args_with_prefix<'a>(self, prefix: &'a str) -> BTreeMap<String, String> {
        self.args()
            .into_iter()
            .map(|(key, value)| (format!("{}.{}", prefix, key), value))
            .collect()
    }
}

impl<T> Args for Option<T>
where
    T: Args,
{
    fn args(self) -> BTreeMap<String, String> {
        if let Some(inner) = self {
            inner.args()
        } else {
            BTreeMap::new()
        }
    }
}

pub trait AgentArgs {
    fn args(self, chains: BTreeSet<String>) -> BTreeMap<String, String>;
}

pub trait Launcher {
    const PATH: &'static str;
}
