use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};

use hyperlane_core::ReorgPeriod;
use hyperlane_core::{ContractLocator, HyperlaneDomain, KnownHyperlaneDomain, H256};
use hyperlane_radix::{ConnectionConf, RadixProvider, RadixSigner};
use macro_rules_attribute::apply;
use maplit::hashmap;
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

const HYPERLANE_RADIX_GIT: &str = "https://github.com/hyperlane-xyz/hyperlane-radix";
const HYPERLANE_RADIX_VERSION: &str = "1.0.0";

use crate::radix::cli::RadixCli;
use crate::radix::types::{AgentConfig, AgentConfigOut, Deployment};

use crate::utils::download;
use crate::{
    fetch_metric, log,
    metrics::agent_balance_sum,
    program::Program,
    utils::{as_task, concat_path, stop_child, AgentHandles, TaskHandle},
    AGENT_BIN_PATH,
};

pub mod cli;
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
    }
}

#[allow(dead_code)]
pub fn download_radix_contracts() -> (PathBuf, PathBuf) {
    let dir_path = tempdir().unwrap().into_path();
    let dir_path = dir_path.to_str().unwrap();

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
        .cmd("-d")
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
            transfers += 1;
        }
    }
    transfers
}

#[apply(as_task)]
fn launch_radix_validator(agent_config: AgentConfig, agent_config_path: PathBuf) -> AgentHandles {
    let validator_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "validator");
    let validator_base = tempdir().expect("Failed to create a temp dir").into_path();
    let validator_base_db = concat_path(&validator_base, "db");

    fs::create_dir_all(&validator_base_db).unwrap();
    println!("Validator DB: {:?}", validator_base_db);

    let checkpoint_path = concat_path(&validator_base, "checkpoint");
    let signature_path = concat_path(&validator_base, "signature");

    let validator = Program::default()
        .bin(validator_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path.to_str().unwrap())
        .env(
            "MY_VALIDATOR_SIGNATURE_DIRECTORY",
            signature_path.to_str().unwrap(),
        )
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHECKPOINTSYNCER_PATH", checkpoint_path.to_str().unwrap())
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
        .hyp_env("ORIGINCHAINNAME", agent_config.name)
        .hyp_env("DB", validator_base_db.to_str().unwrap())
        .hyp_env("METRICSPORT", agent_config.metrics_port.to_string())
        .hyp_env("VALIDATOR_KEY", KEY.1)
        .hyp_env("DEFAULTSIGNER_KEY", KEY.1)
        .hyp_env("DEFAULTSIGNER_TYPE", "radixKey")
        .hyp_env("DEFAULTSIGNER_SUFFIX", SUFFIX)
        .spawn("VAL", None);

    validator
}

#[apply(as_task)]
fn launch_radix_relayer(
    agent_config_path: String,
    relay_chains: Vec<String>,
    metrics: u32,
) -> AgentHandles {
    let relayer_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer");
    let relayer_base = tempdir().unwrap();

    let relayer = Program::default()
        .bin(relayer_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("LOG_LEVEL", "DEBUG")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env("DB", relayer_base.as_ref().to_str().unwrap())
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("DEFAULTSIGNER_KEY", KEY.1)
        .hyp_env("DEFAULTSIGNER_TYPE", "radixKey")
        .hyp_env("DEFAULTSIGNER_SUFFIX", SUFFIX)
        .hyp_env(
            "GASPAYMENTENFORCEMENT",
            r#"[{
                "type": "minimum",
                "payment": "1"
            }]"#,
        )
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("RLY", None);

    relayer
}

#[apply(as_task)]
fn launch_radix_scraper(
    agent_config_path: String,
    chains: Vec<String>,
    metrics: u32,
) -> AgentHandles {
    let bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "scraper");

    let scraper = Program::default()
        .bin(bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHAINSTOSCRAPE", chains.join(","))
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("SCR", None);

    scraper
}

#[allow(dead_code)]
async fn run_locally() {
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

    let mut config = ConnectionConf::new(
        vec![core],
        vec![gateway],
        "stokenet".to_owned(),
        Vec::new(),
        Vec::new(),
    );
    config.network = NETWORK;

    let relayer_key = hex::decode(KEY.1.strip_prefix("0x").unwrap()).unwrap();

    let signer = RadixSigner::new(relayer_key, config.network.hrp_suffix.to_string()).unwrap();
    let locator = ContractLocator::new(
        &HyperlaneDomain::Known(KnownHyperlaneDomain::Test1),
        H256::zero(),
    );

    let provider = RadixProvider::new(Some(signer), &config, &locator, &ReorgPeriod::None).unwrap();

    let mut cli = RadixCli::new(provider, NETWORK);
    cli.fund_account().await;

    let (code_path, rdp) = download_radix_contracts();

    cli.publish_package(
        Path::new(code_path.to_str().unwrap()),
        Path::new(rdp.to_str().unwrap()),
    )
    .await;

    let metrics_port_start = 9090u32;
    let domains = vec![9913374u32, 9913375u32];
    let node_count = domains.len() as u32;
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
    let config_dir = tempdir().unwrap();
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
        serde_json::to_string_pretty(&agent_config_out).unwrap(),
    )
    .unwrap();

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
    let path = agent_config_path.to_str().unwrap();

    let hpl_rly_metrics_port = metrics_port_start + node_count;
    let hpl_rly = launch_radix_relayer(path.to_owned(), chains.clone(), hpl_rly_metrics_port);

    let hpl_scr_metrics_port = hpl_rly_metrics_port + 1u32;
    let hpl_scr = launch_radix_scraper(path.to_owned(), chains.clone(), hpl_scr_metrics_port);

    // give things a chance to fully start.
    sleep(Duration::from_secs(20));

    let starting_relayer_balance: f64 = agent_balance_sum(hpl_rly_metrics_port).unwrap();

    // dispatch the second batch of messages (after agents start)
    dispatched_messages += dispatch(&deployments, dispatched_messages).await;

    let _stack = RadixStack {
        validators: hpl_val.into_iter().map(|v| v.join()).collect(),
        relayer: hpl_rly.join(),
        scraper: hpl_scr.join(),
        postgres,
    };

    // TODO: refactor to share code
    let loop_start = Instant::now();
    let mut failure_occurred = false;
    const TIMEOUT_SECS: u64 = 60 * 10;
    loop {
        // look for the end condition.
        if termination_invariants_met(
            hpl_rly_metrics_port,
            hpl_scr_metrics_port,
            dispatched_messages,
            starting_relayer_balance,
        )
        .unwrap_or(false)
        {
            // end condition reached successfully
            break;
        } else if (Instant::now() - loop_start).as_secs() > TIMEOUT_SECS {
            // we ran out of time
            log!("timeout reached before message submission was confirmed");
            failure_occurred = true;
            break;
        }

        sleep(Duration::from_secs(5));
    }

    if failure_occurred {
        panic!("E2E tests failed");
    } else {
        log!("E2E tests passed");
    }
}

fn termination_invariants_met(
    relayer_metrics_port: u32,
    scraper_metrics_port: u32,
    messages_expected: u32,
    starting_relayer_balance: f64,
) -> eyre::Result<bool> {
    let expected_gas_payments = messages_expected;
    let gas_payments_event_count = fetch_metric(
        &relayer_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    if gas_payments_event_count != expected_gas_payments {
        log!(
            "Relayer has indexed {} gas payments, expected {}",
            gas_payments_event_count,
            expected_gas_payments
        );
        return Ok(false);
    }

    let msg_processed_count = fetch_metric(
        &relayer_metrics_port.to_string(),
        "hyperlane_operations_processed_count",
        &hashmap! {"phase" => "confirmed"},
    )?
    .iter()
    .sum::<u32>();
    if msg_processed_count != messages_expected {
        log!(
            "Relayer confirmed {} submitted messages, expected {}",
            msg_processed_count,
            messages_expected
        );
        return Ok(false);
    }

    let ending_relayer_balance: f64 = agent_balance_sum(relayer_metrics_port).unwrap();

    // Make sure the balance was correctly updated in the metrics.
    // Ideally, make sure that the difference is >= gas_per_tx * gas_cost, set here:
    // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/c2288eb31734ba1f2f997e2c6ecb30176427bc2c/rust/utils/run-locally/src/cosmos/cli.rs#L55
    // What's stopping this is that the format returned by the `uosmo` balance query is a surprisingly low number (0.000003999999995184)
    // but then maybe the gas_per_tx is just very low - how can we check that? (maybe by simulating said tx)
    if starting_relayer_balance <= ending_relayer_balance {
        log!(
            "Expected starting relayer balance to be greater than ending relayer balance, but got {} <= {}",
            starting_relayer_balance,
            ending_relayer_balance
        );
        return Ok(false);
    }

    let dispatched_messages_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_dispatch"},
    )?
    .iter()
    .sum::<u32>();
    if dispatched_messages_scraped != messages_expected {
        log!(
            "Scraper has scraped {} dispatched messages, expected {}",
            dispatched_messages_scraped,
            messages_expected
        );
        return Ok(false);
    }

    let gas_payments_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    if gas_payments_scraped != expected_gas_payments {
        log!(
            "Scraper has scraped {} gas payments, expected {}",
            gas_payments_scraped,
            expected_gas_payments
        );
        return Ok(false);
    }

    let delivered_messages_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_delivery"},
    )?
    .iter()
    .sum::<u32>();
    if delivered_messages_scraped != messages_expected {
        log!(
            "Scraper has scraped {} delivered messages, expected {}",
            delivered_messages_scraped,
            messages_expected
        );
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
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
