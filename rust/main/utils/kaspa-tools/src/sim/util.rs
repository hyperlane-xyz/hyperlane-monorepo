use super::key_cosmos::EasyHubKey;
use eyre::Result;
use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::{ContractLocator, HyperlaneDomain, KnownHyperlaneDomain, NativeToken, H256};
use hyperlane_cosmos::RawCosmosAmount;
use hyperlane_cosmos::{
    native::ModuleQueryClient, ConnectionConf as CosmosConnectionConf, CosmosProvider,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
use url::Url;

pub const SOMPI_PER_KAS: u64 = 100_000_000;

pub fn som_to_kas(sompi: u64) -> String {
    format!("{} KAS", sompi as f64 / SOMPI_PER_KAS as f64)
}

pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time before Unix epoch")
        .as_millis()
}

pub async fn create_cosmos_provider(
    key: &EasyHubKey,
    rpc_url: &str,
    grpc_url: &str,
    chain_id: &str,
    prefix: &str,
    denom: &str,
    decimals: u32,
) -> Result<CosmosProvider<ModuleQueryClient>> {
    let conf = CosmosConnectionConf::new(
        vec![Url::parse(grpc_url).map_err(|e| eyre::eyre!("invalid gRPC URL: {}", e))?],
        vec![Url::parse(rpc_url).map_err(|e| eyre::eyre!("invalid RPC URL: {}", e))?],
        chain_id.to_string(),
        prefix.to_string(),
        denom.to_string(),
        RawCosmosAmount {
            amount: "100000000000.0".to_string(),
            denom: denom.to_string(),
        },
        32,
        OpSubmissionConfig::default(),
        NativeToken {
            decimals,
            denom: denom.to_string(),
        },
        1.0,
        None,
    )
    .map_err(|e| eyre::eyre!(e))?;

    let d = HyperlaneDomain::Known(KnownHyperlaneDomain::Osmosis);
    let locator = ContractLocator::new(&d, H256::zero());
    let signer = Some(key.signer());
    let metrics = PrometheusClientMetrics::default();
    let chain = None;

    CosmosProvider::<ModuleQueryClient>::new(&conf, &locator, signer, metrics, chain)
        .map_err(eyre::Report::from)
}
