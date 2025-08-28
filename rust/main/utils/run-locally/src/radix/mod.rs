use std::collections::HashMap;

use hyperlane_core::ReorgPeriod;
use hyperlane_core::{ContractLocator, HyperlaneDomain, KnownHyperlaneDomain, H256};
use hyperlane_radix::{ConnectionConf, RadixProvider, RadixSigner};
use scrypto::network::NetworkDefinition;
use url::Url;

use crate::{program::Program, radix::cli::RadixCli, utils::AgentHandles};

pub mod cli;

fn start_localnet() -> AgentHandles {
    let path = "/Users/jamin/Desktop/code/kyve/hyperlane-monorepo/rust/main/utils/run-locally/";
    Program::new("docker")
        .working_dir(path)
        .cmd("compose")
        .arg("profile", "fullnode")
        .arg("profile", "network-gateway-image")
        .cmd("up")
        .flag("remove-orphans")
        .spawn("GATEWAY", None)
}

#[allow(dead_code)]
fn run_locally() {
    let core = Url::parse("https://babylon-stokenet-eu-west-1-fullnode0.radixdlt.com/core")
        .expect("Failed to parse URL");
    let gateway = Url::parse("https://stokenet.radixdlt.com").expect("Failed to parse URL");

    let header = HashMap::from([(
        "Authorization".to_string(),
        "Basic ZXh0ZXJuYWxfaHlwZXJsYW5lOnh4SkgqeEZpTHBqY3RLdlVmVksheVB6cDlVMzNURk03".to_string(),
    )]);

    let mut config = ConnectionConf::new(
        vec![core],
        vec![gateway],
        "stokenet".to_owned(),
        vec![header],
        Vec::new(),
    );
    config.network = NetworkDefinition::stokenet();

    let relayer_key =
        hex::decode("8ef41fc20bf963ce18494c0f13e9303f70abc4c1d1ecfdb0a329d7fd468865b8").unwrap();

    let signer = RadixSigner::new(relayer_key, config.network.hrp_suffix.to_string()).unwrap();
    let locator = ContractLocator::new(
        &HyperlaneDomain::Known(KnownHyperlaneDomain::Test1),
        H256::zero(),
    );

    let provider = RadixProvider::new(Some(signer), &config, &locator, &ReorgPeriod::None).unwrap();

    let cli = RadixCli::new(provider);

    let code_path = "/Users/jamin/Desktop/code/kyve/hyperlane-radix/target/wasm32-unknown-unknown/release/hyperlane_radix.wasm";
    let rdp = "/Users/jamin/Desktop/code/kyve/hyperlane-radix/target/wasm32-unknown-unknown/release/hyperlane_radix.rpd";

    let package = tokio::runtime::Runtime::new()
        .expect("Failed to create runtime")
        .block_on(cli.publish_package(std::path::Path::new(code_path), std::path::Path::new(rdp)));

    println!("{}", package);
}

#[cfg(feature = "radix")]
#[cfg(test)]
mod test {
    #[test]
    fn test_run() {
        use crate::radix::run_locally;

        run_locally();
    }
}
