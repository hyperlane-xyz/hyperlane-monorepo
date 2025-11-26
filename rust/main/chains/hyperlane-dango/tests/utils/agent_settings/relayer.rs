use {
    crate::utils::agent_settings::{args::Args2, launcher::Launcher, ChainSetting2},
    std::collections::{BTreeMap, BTreeSet},
};

#[derive(Default)]
pub struct RelayerAgent {
    chains_args: BTreeMap<String, String>,
    chains: BTreeSet<String>,
}

impl RelayerAgent {
    pub fn with_chain<C>(mut self, setting: ChainSetting2<C>) -> Self
    where
        C: Args2,
    {
        self.chains.insert(setting.chain_name.clone());
        self.chains_args.extend(setting.args());
        self
    }
}

impl Args2 for RelayerAgent {
    fn args(mut self) -> BTreeMap<String, String> {
        let chains = self.chains.into_iter().collect::<Vec<_>>().join(",");
        self.chains_args.insert("relayChains".to_string(), chains);
        self.chains_args
    }
}

impl Launcher for RelayerAgent {
    const PATH: &'static str = "relayer";
}
