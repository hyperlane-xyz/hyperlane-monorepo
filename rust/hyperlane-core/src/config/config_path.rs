use std::fmt::{Display, Formatter};
use std::ops::Add;
use std::sync::Arc;

use convert_case::{Case, Casing};
use itertools::Itertools;

/// Path within a config tree.
#[derive(Debug, Default, PartialEq, Eq, Clone)]
pub struct ConfigPath(Vec<Arc<String>>);

impl Display for ConfigPath {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.json_name())
    }
}

impl<S: Into<String>> Add<S> for &ConfigPath {
    type Output = ConfigPath;

    fn add(self, rhs: S) -> Self::Output {
        self.join(rhs)
    }
}

impl Add<ConfigPath> for &ConfigPath {
    type Output = ConfigPath;

    fn add(self, rhs: ConfigPath) -> Self::Output {
        self.merge(&rhs)
    }
}

impl ConfigPath {
    /// Add a new part to the path.
    pub fn join(&self, part: impl Into<String>) -> Self {
        let part = part.into();
        debug_assert!(!part.contains('.'));
        let mut new = self.clone();
        new.0.push(Arc::new(part));
        new
    }

    /// Merge two paths.
    pub fn merge(&self, other: &Self) -> Self {
        Self(
            self.0
                .iter()
                .cloned()
                .chain(other.0.iter().cloned())
                .collect(),
        )
    }

    /// Get the JSON formatted path.
    pub fn json_name(&self) -> String {
        self.0
            .iter()
            .map(|s| s.as_str().to_case(Case::Camel))
            .join(".")
    }

    /// Get the environment variable formatted path.
    pub fn env_name(&self) -> String {
        ["HYP", "BASE"]
            .into_iter()
            .chain(self.0.iter().map(|s| s.as_str()))
            .map(|s| s.to_uppercase())
            .join("_")
    }

    /// Get the expected command line argument name
    pub fn arg_name(&self) -> String {
        let name = self
            .0
            .iter()
            .map(|s| s.as_str().to_case(Case::Camel))
            .join(".");
        format!("--{name}")
    }
}

#[test]
fn env_casing() {
    assert_eq!(
        "hypBaseTest1Conf",
        "hyp_base_test1_conf".to_case(Case::Camel)
    );
}
