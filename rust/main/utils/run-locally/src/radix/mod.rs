use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};

use hyperlane_core::{
    ContractLocator, HyperlaneDomain, HyperlaneProvider, KnownHyperlaneDomain, H256,
};
use hyperlane_core::{ReorgPeriod, SubmitterType};
use hyperlane_radix::{ConnectionConf, RadixProvider, RadixSigner};

use macro_rules_attribute::apply;
use scrypto::network::NetworkDefinition;
use tempfile::tempdir;
use url::Url;

pub const CHAIN_ID: u32 = 240;
pub const SUFFIX: &str = "loc";
pub const KEY: (&str, &str) = (
    "dd1fe72baace37f21ddbe1c2558b9b4f9748fc6a",
    "0x8ef41fc20bf963ce18494c0f13e9303f70abc4c1d1ecfdb0a329d7fd468865b8",
);
pub const CORE_API: &str = "http://localhost:3333/core";
pub const GATEWAY_API: &str = "http://localhost:5308/";
pub const NETWORK: NetworkDefinition = NetworkDefinition::localnet();
pub const SUBMITTER_TYPE: SubmitterType = SubmitterType::Lander;

const HYPERLANE_RADIX_GIT: &str = "https://github.com/hyperlane-xyz/hyperlane-radix";
const HYPERLANE_RADIX_VERSION: &str = "1.0.0";

use crate::radix::cli::RadixCli;
use crate::radix::radix_termination_invariants::radix_termination_invariants_met;
use crate::radix::types::{AgentConfig, AgentConfigOut, Deployment};

use crate::utils::download;
use crate::AGENT_LOGGING_DIR;
use crate::{
    log,
    metrics::agent_balance_sum,
    program::Program,
    utils::{as_task, concat_path, stop_child, AgentHandles, TaskHandle},
    wait_for_condition, AGENT_BIN_PATH, RELAYER_METRICS_PORT, SCRAPER_METRICS_PORT,
};

pub mod cli;
pub mod radix_termination_invariants;
pub mod types;

pub struct RadixStack {
    pub validators: Vec<AgentHandles>,
    pub relayer: AgentHandles,
    pub scraper: AgentHandles,
    pub postgres: AgentHandles,
}

// this is for clean up
// kills all the remaining children
impl Drop for RadixStack {
    fn drop(&mut self) {
        stop_child(&mut self.relayer.1);
        stop_child(&mut self.scraper.1);
        stop_child(&mut self.postgres.1);

        Program::new("docker")
            .working_dir("./src/radix/")
            .cmd("compose")
            .arg("profile", "fullnode")
            .arg("profile", "network-gateway-image")
            .cmd("down")
            .filter_logs(|_| false)
            .run()
            .join();

        self.validators
            .iter_mut()
            .for_each(|x| stop_child(&mut x.1));

        fs::remove_dir_all::<&Path>(AGENT_LOGGING_DIR.as_ref()).unwrap_or_default();
    }
}

#[allow(dead_code)]
pub fn download_radix_contracts() -> (PathBuf, PathBuf) {
    let dir_path = tempdir()
        .expect("Failed to create temporary directory")
        .keep();
    let dir_path = dir_path
        .to_str()
        .expect("Failed to convert temp directory path to string");

    log!("Downloading hyperlane-radix v{}", HYPERLANE_RADIX_VERSION);
    let uri = format!(
        "{HYPERLANE_RADIX_GIT}/releases/download/v{HYPERLANE_RADIX_VERSION}/hyperlane_radix.wasm"
    );
    download("hyperlane_radix.wasm", &uri, dir_path);
    let uri = format!(
        "{HYPERLANE_RADIX_GIT}/releases/download/v{HYPERLANE_RADIX_VERSION}/hyperlane_radix.rpd"
    );
    download("hyperlane_radix.rpd", &uri, dir_path);

    let wasm_path = concat_path(dir_path, "hyperlane_radix.wasm");
    let rpd_path = concat_path(dir_path, "hyperlane_radix.rpd");

    (wasm_path, rpd_path)
}

fn start_localnet() {
    Program::new("docker")
        .working_dir("./src/radix/")
        .cmd("compose")
        .arg("profile", "fullnode")
        .arg("profile", "network-gateway-image")
        .cmd("up")
        .raw_arg("--detach")
        .filter_logs(|_| false)
        .run()
        .join();
}

async fn dispatch(deployments: &Vec<Deployment>, nonce: u32) -> u32 {
    let mut transfers = 0;
    for local in deployments {
        for other in deployments {
            if other.domain == local.domain {
                continue;
            }

            local
                .cli
                .remote_transfer(local.contracts.collateral, other.domain, nonce + 1)
                .await;
            sleep(Duration::from_secs(5));
            transfers += 1;
        }
    }
    transfers
}

#[apply(as_task)]
fn launch_radix_validator(agent_config: AgentConfig, agent_config_path: PathBuf) -> AgentHandles {
    let validator_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "validator");
    let validator_base = tempdir()
        .expect("Failed to create temporary directory for validator")
        .keep();
    let validator_base_db = concat_path(&validator_base, "db");

    fs::create_dir_all(&validator_base_db).expect("Failed to create validator database directory");
    println!("Validator DB: {validator_base_db:?}");

    let checkpoint_path = concat_path(&validator_base, "checkpoint");
    let signature_path = concat_path(&validator_base, "signature");

    let validator = Program::default()
        .bin(validator_bin)
        .working_dir("../../")
        .env(
            "CONFIG_FILES",
            agent_config_path
                .to_str()
                .expect("Failed to convert agent config path to string"),
        )
        .env(
            "MY_VALIDATOR_SIGNATURE_DIRECTORY",
            signature_path
                .to_str()
                .expect("Failed to convert signature path to string"),
        )
        .env("RUST_BACKTRACE", "1")
        .hyp_env(
            "CHECKPOINTSYNCER_PATH",
            checkpoint_path
                .to_str()
                .expect("Failed to convert checkpoint path to string"),
        )
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
        .hyp_env("ORIGINCHAINNAME", agent_config.name)
        .hyp_env(
            "DB",
            validator_base_db
                .to_str()
                .expect("Failed to convert validator DB path to string"),
        )
        .hyp_env("METRICSPORT", agent_config.metrics_port.to_string())
        .hyp_env("VALIDATOR_KEY", KEY.1)
        .hyp_env("DEFAULTSIGNER_KEY", KEY.1)
        .hyp_env("DEFAULTSIGNER_TYPE", "radixKey")
        .hyp_env("DEFAULTSIGNER_SUFFIX", SUFFIX)
        .spawn("VAL", None);

    validator
}

#[apply(as_task)]
fn launch_radix_relayer(agent_config_path: String, relay_chains: Vec<String>) -> AgentHandles {
    let relayer_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer");
    let relayer_base = tempdir().expect("Failed to create temporary directory for relayer");

    let relayer = Program::default()
        .bin(relayer_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("LOG_LEVEL", "debug")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env(
            "DB",
            relayer_base
                .as_ref()
                .to_str()
                .expect("Failed to convert relayer base path to string"),
        )
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("DEFAULTSIGNER_KEY", KEY.1)
        .hyp_env("DEFAULTSIGNER_TYPE", "radixKey")
        .hyp_env("DEFAULTSIGNER_SUFFIX", SUFFIX)
        .hyp_env("CHAINS_RADIXTEST0_SUBMITTER", SUBMITTER_TYPE.to_string())
        .hyp_env("CHAINS_RADIXTEST1_SUBMITTER", SUBMITTER_TYPE.to_string())
        .hyp_env(
            "GASPAYMENTENFORCEMENT",
            r#"[{
                "type": "minimum",
                "payment": "1"
            }]"#,
        )
        .hyp_env("CACHEDEFAULTEXPIRATIONSECONDS", "5")
        .hyp_env("METRICSPORT", RELAYER_METRICS_PORT)
        .spawn("RLY", Some(&AGENT_LOGGING_DIR));

    relayer
}

#[apply(as_task)]
fn launch_radix_scraper(agent_config_path: String, chains: Vec<String>) -> AgentHandles {
    let bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "scraper");

    Program::default()
        .bin(bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHAINSTOSCRAPE", chains.join(","))
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("METRICSPORT", SCRAPER_METRICS_PORT)
        .spawn("SCR", None)
}

#[allow(dead_code)]
pub async fn run_locally() {
    log!("Staring local net");
    start_localnet();
    // Give some time for the localnet to startup
    sleep(Duration::from_secs(20));

    log!("Building rust...");
    Program::new("cargo")
        .cmd("build")
        .working_dir("../../")
        .arg("features", "test-utils")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .arg("bin", "scraper")
        .arg("bin", "init-db")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run()
        .join();

    let core = Url::parse(CORE_API).expect("Failed to parse URL");
    let gateway = Url::parse(GATEWAY_API).expect("Failed to parse URL");

    let mut config =
        ConnectionConf::new(vec![core], vec![gateway], NETWORK.logical_name.to_string());
    config.network = NETWORK;

    let relayer_key = hex::decode(
        KEY.1
            .strip_prefix("0x")
            .expect("Relayer key should have 0x prefix"),
    )
    .expect("Failed to decode relayer key as hex");

    let signer = RadixSigner::new(relayer_key, config.network.hrp_suffix.to_string())
        .expect("Failed to create Radix signer");
    let locator = ContractLocator::new(
        &HyperlaneDomain::Known(KnownHyperlaneDomain::Test1),
        H256::zero(),
    );

    let encoded_address = signer.encoded_address.clone();
    let provider = RadixProvider::new(
        Some(signer),
        &config,
        &locator,
        &ReorgPeriod::None,
        Default::default(),
        None,
    )
    .expect("Failed to create Radix provider");

    let mut cli = RadixCli::new(provider.clone(), NETWORK);
    cli.fund_account().await;
    let resp = provider
        .get_balance(encoded_address.clone())
        .await
        .expect("Failed to get balance");
    log!("Funding balance: {:?}", resp);

    let (code_path, rdp) = download_radix_contracts();

    cli.publish_package(
        Path::new(
            code_path
                .to_str()
                .expect("Failed to convert WASM code path to string"),
        ),
        Path::new(rdp.to_str().expect("Failed to convert RPD path to string")),
    )
    .await;

    let metrics_port_start = 9090u32;
    // Localdomains: radixtest0, radixtest1
    let domains = vec![9913374u32, 9913375u32];
    let contracts = cli.deploy_contracts(domains.clone()).await;
    let deployments = contracts
        .into_iter()
        .enumerate()
        .map(|(index, contracts)| Deployment {
            cli: cli.clone(),
            name: format!("radixtest{index}"),
            metrics: metrics_port_start + index as u32,
            domain: domains[index],
            contracts,
        })
        .collect::<Vec<_>>();

    // Mostly copy-pasta from `rust/main/utils/run-locally/src/main.rs`

    // count all the dispatched messages
    let mut dispatched_messages = 0;
    // dispatch the first batch of messages (before agents start)
    dispatched_messages += dispatch(&deployments, dispatched_messages).await;
    let config_dir = tempdir().expect("Failed to create temporary directory for agent config");
    // export agent config
    let agent_config_out = AgentConfigOut {
        chains: deployments
            .iter()
            .map(|v| (v.name.clone(), AgentConfig::new(v)))
            .collect::<BTreeMap<String, AgentConfig>>(),
    };

    let agent_config_path = concat_path(&config_dir, "config.json");
    fs::write(
        &agent_config_path,
        serde_json::to_string_pretty(&agent_config_out)
            .expect("Failed to serialize agent config to JSON"),
    )
    .expect("Failed to write agent config file");

    log!("Config path: {:#?}", agent_config_path);
    log!("Running postgres db...");
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "scraper-testnet-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL", None);

    sleep(Duration::from_secs(15));

    log!("Init postgres db...");
    Program::new(concat_path(format!("../../{AGENT_BIN_PATH}"), "init-db"))
        .run()
        .join();

    let hpl_val = agent_config_out
        .chains
        .clone()
        .into_values()
        .map(|agent_config| launch_radix_validator(agent_config, agent_config_path.clone()))
        .collect::<Vec<_>>();

    let chains = agent_config_out.chains.into_keys().collect::<Vec<_>>();
    let path = agent_config_path
        .to_str()
        .expect("Failed to convert agent config path to string");

    let hpl_rly = launch_radix_relayer(path.to_owned(), chains.clone());
    let hpl_scr = launch_radix_scraper(path.to_owned(), chains.clone());

    // give things a chance to fully start.
    sleep(Duration::from_secs(20));

    let relayer_metrics_port: u32 = RELAYER_METRICS_PORT
        .parse()
        .expect("Failed to parse relayer metrics port");
    let scraper_metrics_port: u32 = SCRAPER_METRICS_PORT
        .parse()
        .expect("Failed to parse scraper metrics port");

    let starting_relayer_balance: f64 =
        agent_balance_sum(relayer_metrics_port).expect("Failed to get starting relayer balance");

    // dispatch the second batch of messages (after agents start)
    dispatched_messages += dispatch(&deployments, dispatched_messages).await;

    let _stack = RadixStack {
        validators: hpl_val.into_iter().map(|v| v.join()).collect(),
        relayer: hpl_rly.join(),
        scraper: hpl_scr.join(),
        postgres,
    };

    // Use the standard wait_for_condition function with config
    let config = crate::config::Config::load(); // Load the config for invariants
    let loop_start = Instant::now();
    let test_passed = wait_for_condition(
        &config,
        loop_start,
        || {
            radix_termination_invariants_met(
                &config,
                starting_relayer_balance,
                scraper_metrics_port,
                dispatched_messages,
            )
        },
        || true,  // Always continue (no external shutdown signal for radix tests)
        || false, // No long-running process checks for radix
    );

    if !test_passed {
        panic!("Radix E2E tests failed");
    } else {
        log!("Radix E2E tests passed");
    }
}

#[cfg(feature = "radix")]
#[cfg(test)]
mod test {
    #[test]
    fn test_run() {
        use crate::radix::run_locally;

        tokio::runtime::Runtime::new()
            .expect("Failed to create runtime")
            .block_on(run_locally());
    }
}
