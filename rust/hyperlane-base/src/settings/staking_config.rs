use hyperlane_core::H160;
use std::{collections::HashMap, str::FromStr};

#[derive(Clone, Debug, Default)]
pub struct StakingConf {
    /// Address of the HyperlaneServiceManager contract
    pub service_managers: HashMap<u32, H160>,
}

impl StakingConf {
    pub fn default_staking_config() -> StakingConf {
        let mut service_managers = HashMap::new();
        service_managers.insert(
            1,
            H160::from_str("0x055733000064333CaDDbC92763c58BF0192fFeBf").unwrap(),
        );
        service_managers.insert(
            17000,
            H160::from_str("0x055733000064333CaDDbC92763c58BF0192fFeBf").unwrap(),
        ); // holesky

        StakingConf { service_managers }
    }
}
