use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};
use std::{env, fs};

use macro_rules_attribute::apply;
use maplit::hashmap;
use tempfile::tempdir;
use utils::to_strk_message_bytes;

use crate::logging::log;
use crate::metrics::agent_balance_sum;
use crate::program::Program;
use crate::starknet::types::{AgentConfigOut, ValidatorConfig};
use crate::starknet::utils::{KEYPAIR_PASSWORD, STARKNET_ACCOUNT, STARKNET_KEYPAIR};
use crate::utils::{as_task, concat_path, stop_child, AgentHandles, TaskHandle};
use crate::{fetch_metric, AGENT_BIN_PATH};

use self::cli::StarknetCLI;
use self::source::{CLISource, CodeSource, StarknetCLISource};
use self::types::{AgentConfig, Deployments, StarknetEndpoint};

mod cli;
mod source;
mod types;
mod utils;

const KATANA_CLI_GIT: &str = "https://github.com/dojoengine/dojo";
const KATANA_CLI_VERSION: &str = "1.3.0";
const STARKNET_CLI_GIT: &str = "https://github.com/xJonathanLEI/starkli";
const STARKNET_CLI_VERSION: &str = "0.3.8";

const CAIRO_HYPERLANE_GIT: &str = "https://github.com/aroralanuk/starknet";
const CAIRO_HYPERLANE_VERSION: &str = "0.3.4";

#[allow(dead_code)]
pub fn install_starknet(
    starknet_cli_dir: Option<PathBuf>,
    starknet_cli_src: Option<StarknetCLISource>,
    cli_dir: Option<PathBuf>,
    cli_src: Option<CLISource>,
    codes_dir: Option<PathBuf>,
    codes_src: Option<CodeSource>,
) -> (PathBuf, PathBuf, BTreeMap<String, PathBuf>) {
    let katanad = cli_src
        .unwrap_or(CLISource::Remote {
            url: KATANA_CLI_GIT.to_string(),
            version: KATANA_CLI_VERSION.to_string(),
        })
        .install(cli_dir);

    let starklid = starknet_cli_src
        .unwrap_or(StarknetCLISource::Remote {
            url: STARKNET_CLI_GIT.to_string(),
            version: STARKNET_CLI_VERSION.to_string(),
        })
        .install(starknet_cli_dir);

    // println!("codes_src {:?}", codes_src);

    let codes = codes_src
        .unwrap_or(CodeSource::Remote {
            url: CAIRO_HYPERLANE_GIT.to_string(),
            version: CAIRO_HYPERLANE_VERSION.to_string(),
        })
        .install(codes_dir);

    (starklid, katanad, codes)
}

#[derive(Clone)]
pub struct StarknetConfig {
    pub cli_path: PathBuf,
    pub node_addr_base: String,
    pub node_port_base: u32,
}

pub struct StarknetResp {
    pub node: AgentHandles,
    pub endpoint: StarknetEndpoint,
}

impl StarknetResp {
    pub fn cli(&self, bin: &Path) -> StarknetCLI {
        StarknetCLI::new(bin.to_path_buf())
    }
}

impl Drop for StarknetResp {
    fn drop(&mut self) {
        if let Err(e) = self.node.1.kill() {
            eprintln!("Failed to kill katana subprocess: {}", e);
        }
        if let Err(e) = self.node.1.wait() {
            eprintln!("Failed to wait for katana subprocess: {}", e);
        }
    }
}

pub struct StarknetNetwork {
    pub launch_resp: StarknetResp,
    pub deployments: Deployments,
    pub metrics_port: u32,
    pub domain: u32,
}

impl Drop for StarknetNetwork {
    fn drop(&mut self) {
        stop_child(&mut self.launch_resp.node.1);
    }
}

impl From<(StarknetResp, Deployments, String, u32, u32)> for StarknetNetwork {
    fn from(v: (StarknetResp, Deployments, String, u32, u32)) -> Self {
        Self {
            launch_resp: v.0,
            deployments: v.1,
            metrics_port: v.3,
            domain: v.4,
        }
    }
}
pub struct StarknetHyperlaneStack {
    pub validators: Vec<AgentHandles>,
    pub relayer: AgentHandles,
}

impl Drop for StarknetHyperlaneStack {
    fn drop(&mut self) {
        for v in &mut self.validators {
            stop_child(&mut v.1);
        }
        stop_child(&mut self.relayer.1);
    }
}

#[apply(as_task)]
fn launch_starknet_node(config: StarknetConfig) -> StarknetResp {
    let cli = Program::new(config.cli_path);

    println!(
        "host: {}, port: {}",
        config.node_addr_base, config.node_port_base
    );

    // let node: AgentHandles = cli
    //     .flag("disable-fee")  // Add this line to include --disable-fee
    //     .spawn("STARKNET", None);
    let node: AgentHandles = cli
        // .arg("host", config.node_addr_base.clone())
        .arg("http.port", config.node_port_base.to_string())
        .arg("block-time", "1000".to_string())
        .spawn("STARKNET", None);

    let endpoint: StarknetEndpoint = StarknetEndpoint {
        rpc_addr: format!("http://{}:{}", config.node_addr_base, config.node_port_base),
    };

    StarknetResp { node, endpoint }
}

#[apply(as_task)]
fn launch_starknet_validator(
    agent_config: AgentConfig,
    agent_config_path: PathBuf,
    debug: bool,
) -> AgentHandles {
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
        .hyp_env("VALIDATOR_SIGNER_TYPE", "hexKey")
        .hyp_env(
            "VALIDATOR_KEY",
            "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
        )
        .hyp_env("SIGNER_SIGNER_TYPE", agent_config.signer.typ)
        .hyp_env("SIGNER_KEY", agent_config.signer.key)
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .spawn("VAL", None);

    validator
}

#[apply(as_task)]
fn launch_starknet_relayer(
    agent_config_path: PathBuf,
    relay_chains: Vec<String>,
    metrics: u32,
    debug: bool,
) -> AgentHandles {
    let relayer_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer");
    let relayer_base = tempdir().unwrap();

    let relayer = Program::default()
        .bin(relayer_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path.to_str().unwrap())
        .env("RUST_BACKTRACE", "1")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env("DB", relayer_base.as_ref().to_str().unwrap())
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("GASPAYMENTENFORCEMENT", "[{\"type\": \"none\"}]")
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("RLY", None);

    relayer
}

const ENV_CLI_PATH_KEY: &str = "E2E_KATANA_CLI_PATH";
const ENV_STARKNET_CLI_PATH_KEY: &str = "E2E_STARKLI_CLI_PATH";
const ENV_HYPERLANE_STARKNET_PATH_KEY: &str = "E2E_HYPERLANE_STARKNET_PATH";

#[allow(dead_code)]
fn run_locally() {
    const TIMEOUT_SECS: u64 = 60 * 10;
    let debug = true;

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

    let cli_src = Some(
        env::var(ENV_CLI_PATH_KEY)
            .as_ref()
            .map(|v| CLISource::local(v))
            .unwrap_or_default(),
    );

    let starknet_cli_src = Some(
        env::var(ENV_STARKNET_CLI_PATH_KEY)
            .as_ref()
            .map(|v| StarknetCLISource::local(v))
            .unwrap_or_default(),
    );

    let code_src = Some(
        env::var(ENV_HYPERLANE_STARKNET_PATH_KEY)
            .as_ref()
            .map(|v| CodeSource::local(v))
            .unwrap_or_default(),
    );

    let (starklid, katanad, sierra_classes) =
        install_starknet(None, starknet_cli_src, None, cli_src, None, code_src);

    let addr_base = "0.0.0.0";
    let default_config = StarknetConfig {
        cli_path: katanad.clone(),
        node_addr_base: addr_base.to_string(),
        node_port_base: 5050,
    };

    let port_start = 5050u32;
    let metrics_port_start = 9090u32;
    let domain_start = 23448593u32;
    let node_count = 2;

    let nodes = (0..node_count)
        .map(|i| {
            (
                launch_starknet_node(StarknetConfig {
                    node_port_base: port_start + (i * 10),
                    ..default_config.clone()
                }),
                format!("KATANA"),
                metrics_port_start + i,
                domain_start + i,
            )
        })
        .collect::<Vec<_>>();

    let domains = nodes.iter().map(|v| v.3).collect::<Vec<_>>();

    let deployer = "0xb3ff441a68610b30fd5e2abbf3a1548eb6ba6f3559f2862bf2dc757e5828ca"; // 1st katana account
    let _linker = "validator";
    let validator = &ValidatorConfig {
        private_key: "0x0014d6672dcb4b77ca36a887e9a11cd9d637d5012468175829e9c6e770c61642"
            .to_string(),
        address: "0x00e29882a1fcba1e7e10cad46212257fea5c752a4f9b1b1ec683c503a2cf5c8a".to_string(),
    };
    let _relayer = "hpl-relayer";

    sleep(Duration::from_secs(5));

    let nodes = nodes
        .into_iter()
        .map(|v| (v.0.join(), v.1, v.2, v.3))
        .map(|(launch_resp, chain_id, metrics_port, domain)| {
            let mut starknet_cli = launch_resp.cli(&starklid);
            starknet_cli.init(
                STARKNET_KEYPAIR.into(),
                STARKNET_ACCOUNT.into(),
                KEYPAIR_PASSWORD.into(),
                launch_resp.endpoint.rpc_addr.clone(),
            );

            let declarations =
                utils::declare_all(starknet_cli.clone(), sierra_classes.clone()).join();

            let remotes = domains
                .iter()
                .filter(|v| *v != &domain)
                .cloned()
                .collect::<Vec<_>>();

            let deployments = utils::deploy_all(
                starknet_cli,
                deployer.to_string(),
                declarations,
                domain,
                remotes,
            );

            (launch_resp, deployments, chain_id, metrics_port, domain)
        })
        .collect::<Vec<_>>();

    // nodes with base deployments
    let nodes = nodes
        .into_iter()
        .map(|v| (v.0, v.1.join(), v.2, v.3, v.4))
        .map(|v| v.into())
        .collect::<Vec<StarknetNetwork>>();

    // for debug
    println!(
        "{}",
        serde_json::to_string(
            &nodes
                .iter()
                .map(|v| (v.domain, v.deployments.clone()))
                .collect::<BTreeMap<_, _>>()
        )
        .unwrap()
    );

    let config_dir = tempdir().unwrap();

    // export agent config
    let agent_config_out = AgentConfigOut {
        chains: nodes
            .iter()
            .map(|v| {
                (
                    format!("starknettest{}", v.domain),
                    AgentConfig::new(starklid.clone(), validator, v),
                )
            })
            .collect::<BTreeMap<String, AgentConfig>>(),
    };

    let agent_config_path = concat_path(&config_dir, "config.json");
    fs::write(
        &agent_config_path,
        serde_json::to_string_pretty(&agent_config_out).unwrap(),
    )
    .unwrap();

    let hpl_val = agent_config_out
        .chains
        .clone()
        .into_values()
        .map(|agent_config| {
            launch_starknet_validator(agent_config, agent_config_path.clone(), debug)
        })
        .collect::<Vec<_>>();
    let hpl_rly_metrics_port = metrics_port_start + node_count + 1u32;
    let hpl_rly = launch_starknet_relayer(
        agent_config_path,
        agent_config_out.chains.into_keys().collect::<Vec<_>>(),
        hpl_rly_metrics_port,
        debug,
    );

    // give things a chance to fully start.
    sleep(Duration::from_secs(10));

    let starting_relayer_balance: f64 = agent_balance_sum(hpl_rly_metrics_port).unwrap_or_default();

    // dispatch messages
    let mut dispatched_messages = 0;

    for node in nodes.iter() {
        let targets = nodes
            .iter()
            .filter(|v| v.domain != node.domain && v.domain != 23448593)
            .collect::<Vec<_>>();

        if !targets.is_empty() {
            println!(
                "DISPATCHING MAILBOX: {} -> {:?}",
                node.domain,
                targets.iter().map(|v| v.domain).collect::<Vec<_>>()
            );
        }

        for target in targets {
            dispatched_messages += 1;
            let mut cli = StarknetCLI::new(starklid.clone());

            let msg_body: &[u8] = b"hello world";

            cli.init(
                STARKNET_KEYPAIR.into(),
                STARKNET_ACCOUNT.into(),
                KEYPAIR_PASSWORD.into(),
                node.launch_resp.endpoint.rpc_addr.clone(),
            );

            let (strk_msg_len, strk_msg) = to_strk_message_bytes(msg_body);
            let strk_msg_str = strk_msg
                .iter()
                .map(|v| format!("0x{:x}", v))
                .collect::<Vec<String>>();

            let fee_amount = 0u32;

            let initial_args = vec![
                target.domain.to_string(),
                format!("u256:{}", target.deployments.mock_receiver.clone()),
                strk_msg_len.to_string(),
                strk_msg_str.len().to_string(),
            ];

            // we set the options to `None` for now
            // which means no hook nor hook_metadata
            let options_args = vec!["1".to_string(), "1".to_string()];

            let args = initial_args
                .into_iter()
                .chain(strk_msg_str)
                .chain(vec![format!("u256:{}", fee_amount)])
                .chain(options_args)
                .collect();

            cli.send_tx(
                node.deployments.mailbox.clone(),
                "dispatch".to_string(),
                args,
            );
        }
    }

    let _stack = StarknetHyperlaneStack {
        validators: hpl_val.into_iter().map(|v| v.join()).collect(),
        relayer: hpl_rly.join(),
    };

    // Mostly copy-pasta from `rust/utils/run-locally/src/main.rs`
    let loop_start = Instant::now();
    let mut failure_occurred = false;
    loop {
        // look for the end condition.
        if termination_invariants_met(
            hpl_rly_metrics_port,
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
    messages_expected: u32,
    _starting_relayer_balance: f64,
) -> eyre::Result<bool> {
    // Commented as IGP is not implemented for Starknet
    // let gas_payments_scraped = fetch_metric(
    //     &relayer_metrics_port.to_string(),
    //     "hyperlane_contract_sync_stored_events",
    //     &hashmap! {"data_type" => "gas_payment"},
    // )?
    // .iter()
    // .sum::<u32>();
    // let expected_gas_payments = messages_expected;
    // if gas_payments_scraped != expected_gas_payments {
    //     log!(
    //         "Relayer has indexed {} gas payments, expected {}",
    //         gas_payments_scraped,
    //         expected_gas_payments
    //     );
    //     return Ok(false);
    // }

    let delivered_messages_count = fetch_metric(
        &relayer_metrics_port.to_string(),
        "hyperlane_operations_processed_count",
        &hashmap! {"phase" => "confirmed"},
    )?
    .iter()
    .sum::<u32>();
    if delivered_messages_count != messages_expected {
        log!(
            "Relayer confirmed {} submitted messages, expected {}",
            delivered_messages_count,
            messages_expected
        );
        return Ok(false);
    }

    let _ending_relayer_balance: f64 = agent_balance_sum(relayer_metrics_port).unwrap();

    // Make sure the balance was correctly updated in the metrics.
    // if starting_relayer_balance <= ending_relayer_balance {
    //     log!(
    //         "Expected starting relayer balance to be greater than ending relayer balance, but got {} <= {}",
    //         starting_relayer_balance,
    //         ending_relayer_balance
    //     );
    //     return Ok(false);
    // }

    log!("Termination invariants have been met");
    Ok(true)
}

#[cfg(feature = "starknet")]
mod test {
    use super::*;

    #[test]
    fn test_run() {
        run_locally()
    }
}
