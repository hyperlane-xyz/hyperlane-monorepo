use std::str::FromStr;

use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
use url::Url;

use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::{ContractLocator, HyperlaneDomain, KnownHyperlaneDomain, NativeToken};

use crate::grpc::{WasmGrpcProvider, WasmProvider};
use crate::{ConnectionConf, CosmosAddress, CosmosAmount, RawCosmosAmount};

#[ignore]
#[tokio::test]
async fn test_wasm_contract_info_success() {
    // given
    let provider = provider("neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4");

    // when
    let result = provider.wasm_contract_info().await;

    // then
    assert!(result.is_ok());

    let contract_info = result.unwrap();

    assert_eq!(
        contract_info.creator,
        "neutron1dwnrgwsf5c9vqjxsax04pdm0mx007yrre4yyvm",
    );
    assert_eq!(
        contract_info.admin,
        "neutron1fqf5mprg3f5hytvzp3t7spmsum6rjrw80mq8zgkc0h6rxga0dtzqws3uu7",
    );
}

#[ignore]
#[tokio::test]
async fn test_wasm_contract_info_no_contract() {
    // given
    let provider = provider("neutron1dwnrgwsf5c9vqjxsax04pdm0mx007yrre4yyvm");

    // when
    let result = provider.wasm_contract_info().await;

    // then
    assert!(result.is_err());
}

fn provider(address: &str) -> WasmGrpcProvider {
    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Neutron);
    let address = CosmosAddress::from_str(address).unwrap();
    let locator = ContractLocator::new(&domain, address.digest());

    WasmGrpcProvider::new(
        domain.clone(),
        ConnectionConf::new(
            vec![Url::parse("http://grpc-kralum.neutron-1.neutron.org:80").unwrap()],
            vec![Url::parse("https://rpc-kralum.neutron-1.neutron.org").unwrap()],
            "neutron-1".to_owned(),
            "neutron".to_owned(),
            "untrn".to_owned(),
            RawCosmosAmount::new("untrn".to_owned(), "0".to_owned()),
            32,
            OpSubmissionConfig {
                batch_contract_address: None,
                max_batch_size: 1,
                ..Default::default()
            },
            NativeToken {
                decimals: 6,
                denom: "untrn".to_owned(),
            },
        ),
        CosmosAmount {
            denom: "untrn".to_owned(),
            amount: Default::default(),
        },
        &locator,
        None,
        PrometheusClientMetrics::default(),
        None,
    )
    .unwrap()
}
