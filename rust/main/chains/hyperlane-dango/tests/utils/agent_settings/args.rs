use std::collections::BTreeMap;

pub trait Args2: Sized {
    fn args(self) -> BTreeMap<String, String>;
    fn args_with_prefix<'a>(self, prefix: &'a str) -> BTreeMap<String, String> {
        self.args()
            .into_iter()
            .map(|(key, value)| (format!("{}.{}", prefix, key), value))
            .collect()
    }
}

impl<T> Args2 for Option<T>
where
    T: Args2,
{
    fn args(self) -> BTreeMap<String, String> {
        if let Some(inner) = self {
            inner.args()
        } else {
            BTreeMap::new()
        }
    }
}
