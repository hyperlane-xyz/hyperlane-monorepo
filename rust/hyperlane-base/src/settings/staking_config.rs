use hyperlane_core::H160;
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub struct StakingConf {
    /// Address of the HyperlaneServiceManager contract
    pub service_managers: HashMap<u32, H160>,
}

impl StakingConf {
    pub fn default_staking_config() -> StakingConf {
        let mut service_managers = HashMap::new();
        service_managers.insert(1, H160::from_low_u64_be(0x1234)); // mainnet
        service_managers.insert(17000, H160::from_low_u64_be(0x5678)); // holesky

        StakingConf { service_managers }
    }
}
