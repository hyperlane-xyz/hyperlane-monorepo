use {
    crate::utils::{Args, ChainSettings},
    std::collections::BTreeMap,
};

pub type EvmSettings = ChainSettings<Evm>;

#[derive(Debug, Default)]
pub struct Evm {}

impl Args for Evm {
    fn args(self) -> BTreeMap<String, String> {
        BTreeMap::new()
    }
}
