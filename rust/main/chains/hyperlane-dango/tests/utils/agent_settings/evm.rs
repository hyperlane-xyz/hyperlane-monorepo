use {
    crate::utils::{Args2, ChainSetting2},
    std::collections::BTreeMap,
};

pub type EvmChainSettings = ChainSetting2<EvmSettings>;

#[derive(Debug, Default)]
pub struct EvmSettings {}

impl Args2 for EvmSettings {
    fn args(self) -> BTreeMap<String, String> {
        BTreeMap::new()
    }
}
