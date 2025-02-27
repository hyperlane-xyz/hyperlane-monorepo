use fuels::test_helpers::FuelService;

use super::deploy::FuelDeployments;

pub struct FuelConfig {
    pub node: FuelService,
    pub metrics_port: u32,
    pub domain: u32,
}

pub struct FuelNetwork {
    pub name: String,
    pub config: FuelConfig,
    pub deployments: FuelDeployments,
}
