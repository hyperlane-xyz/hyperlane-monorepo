use log::info;
use macro_rules_attribute::apply;
use std::{env, fs, path::PathBuf, thread::sleep, time::Duration};
use tempfile::tempdir;

use crate::{
    logging::log,
    program::Program,
    ton::evm::{launch_evm_to_ton_relayer, launch_evm_validator},
    ton::setup::{deploy_and_setup_domain, deploy_and_setup_domains, send_dispatch},
    ton::types::{generate_ton_config, TonAgentConfig},
    ton::utils::{build_rust_bins, resolve_abs_path},
    utils::{as_task, concat_path, make_static, stop_child, AgentHandles, TaskHandle},
};

mod evm;
mod setup;
mod types;
mod utils;
mod warp_route;
pub struct TonHyperlaneStack {
    pub validators: Vec<AgentHandles>,
    pub relayer: AgentHandles,
}

impl Drop for TonHyperlaneStack {
    fn drop(&mut self) {
        for v in &mut self.validators {
            stop_child(&mut v.1);
        }
        stop_child(&mut self.relayer.1);
    }
}

#[allow(dead_code)]
fn run_ton_to_ton() {
    info!("Start run_locally() for Ton");
    let domains: Vec<u32> = env::var("DOMAINS")
        .expect("DOMAINS env variable is missing")
        .split(',')
        .map(|d| d.parse::<u32>().expect("Invalid domain format"))
        .collect();
    let validator_key = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

    info!("domains:{:?}", domains);

    deploy_and_setup_domains(&domains, &validator_key);

    for &dispatch_domain in &domains {
        for &target_domain in &domains {
            if dispatch_domain != target_domain {
                send_dispatch(dispatch_domain, target_domain).expect(&format!(
                    "send_dispatch failed for dispatch_domain={} and target_domain={}",
                    dispatch_domain, target_domain
                ));
            }
        }
    }

    info!("deploy_all_contracts and send_dispatch finished!");
    let mnemonic = env::var("MNEMONIC").expect("MNEMONIC env is missing");
    let wallet_version = env::var("WALLET_VERSION").expect("WALLET_VERSION env is missing");
    let api_key = env::var("API_KEY").expect("API_KEY env is missing");

    log!("Building rust...");
    build_rust_bins(&["relayer", "validator", "scraper", "init-db"]);

    info!("current_dir: {}", env::current_dir().unwrap().display());
    let file_name = "ton_config";

    let domains_tuple = (domains[0].to_string(), domains[1].to_string());

    let agent_config = generate_ton_config(
        file_name,
        &mnemonic,
        &wallet_version,
        &api_key,
        (&domains_tuple.0, &domains_tuple.1),
    )
    .unwrap();

    let agent_config_path = format!("../../config/{file_name}.json");

    info!("Agent config path:{}", agent_config_path);
    let relay_chains = vec!["tontest1".to_string(), "tontest2".to_string()];
    let metrics_port = 9090;
    let debug = false;

    let relayer = launch_ton_relayer(
        agent_config_path.clone(),
        relay_chains.clone(),
        metrics_port,
        debug,
    );

    let persistent_path = "./persistent_data";
    let db_path = format!("{}/db", persistent_path);
    fs::create_dir_all(&db_path).expect("Failed to create persistent database path");

    let validator1 = launch_ton_validator(
        agent_config_path.clone(),
        agent_config[0].clone(),
        metrics_port + 1,
        debug,
        Some(format!("{}1", persistent_path)),
    );

    let validator2 = launch_ton_validator(
        agent_config_path.clone(),
        agent_config[1].clone(),
        metrics_port + 2,
        debug,
        Some(format!("{}2", persistent_path)),
    );

    let validators = vec![validator1, validator2];

    info!("Waiting for agents to run for 3 minutes...");
    sleep(Duration::from_secs(300));

    let _ = TonHyperlaneStack {
        validators: validators.into_iter().map(|v| v.join()).collect(),
        relayer: relayer.join(),
    };
}

#[allow(dead_code)]
fn run_ton_to_evm() {
    info!("Start run_locally() for Ton");
    let domains: Vec<u32> = env::var("DOMAINS")
        .expect("DOMAINS env variable is missing")
        .split(',')
        .map(|d| d.parse::<u32>().expect("Invalid domain format"))
        .collect();

    info!("domains:{:?}", domains);

    let mnemonic = env::var("MNEMONIC").expect("MNEMONIC env is missing");
    let wallet_version = env::var("WALLET_VERSION").expect("WALLET_VERSION env is missing");
    let api_key = env::var("API_KEY").expect("API_KEY env is missing");

    // needed add key for evm
    let private_key = env::var("evm_private_key")
        .expect("evm_private_key env variable is missing")
        .to_string();

    let domain_ton = 777001;
    let validator_key = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

    info!("current_dir: {}", env::current_dir().unwrap().display());
    let file_name = "ton_config";

    deploy_and_setup_domain(domain_ton, &validator_key);

    let agent_config = generate_ton_config(
        file_name,
        &mnemonic,
        &wallet_version,
        &api_key,
        ("777001", "777002"),
    )
    .unwrap();

    let agent_config_path = format!("../../config/{file_name}.json");

    info!("Agent config path:{}", agent_config_path);

    sleep(Duration::from_secs(300));

    log!("Building rust...");
    build_rust_bins(&["relayer", "validator", "scraper", "init-db"]);

    info!("current_dir: {}", env::current_dir().unwrap().display());
    let file_name = "evm_to_ton_config";

    let agent_config_path = format!("../../config/{file_name}.json");

    info!("Agent config path:{}", agent_config_path);
    let relay_chains = vec!["arbitrumsepolia".to_string(), "tontest1".to_string()];
    let metrics_port = 9090;
    let debug = false;

    let relayer = launch_evm_to_ton_relayer(
        agent_config_path.clone(),
        relay_chains.clone(),
        metrics_port,
        debug,
    );

    let persistent_path = "./persistent_data";
    let db_path = format!("{}/db", persistent_path);
    fs::create_dir_all(&db_path).expect("Failed to create persistent database path");

    let validator1: Box<dyn TaskHandle<Output = AgentHandles>> = Box::new(launch_evm_validator(
        agent_config_path.clone(),
        private_key,
        metrics_port + 1,
        debug,
        Some(format!("{}1", persistent_path)),
    ));

    let validator2: Box<dyn TaskHandle<Output = AgentHandles>> = Box::new(launch_ton_validator(
        agent_config_path.clone(),
        agent_config[0].clone(),
        metrics_port + 2,
        debug,
        Some(format!("{}2", persistent_path)),
    ));

    let validators = vec![validator1, validator2];

    info!("Waiting for agents to run for 3 minutes...");
    sleep(Duration::from_secs(300));

    let _ = TonHyperlaneStack {
        validators: validators.into_iter().map(|v| v.join_box()).collect(),
        relayer: relayer.join(),
    };
}

#[apply(as_task)]
pub fn launch_ton_relayer(
    agent_config_path: String,
    relay_chains: Vec<String>,
    metrics: u32,
    debug: bool,
) -> AgentHandles {
    let relayer_bin = concat_path("../../target/debug", "relayer");
    let relayer_base = tempdir().unwrap();

    let relayer = Program::default()
        .bin(relayer_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", resolve_abs_path(agent_config_path))
        .env("RUST_BACKTRACE", "1")
        .env("RUST_LOG", "info")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env("DB", relayer_base.as_ref().to_str().unwrap())
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("arbitrumsepolia", "421614")
        .hyp_env("tontest1", "1")
        .hyp_env("tontest2", "1")
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("GASPAYMENTENFORCEMENT", "[{\"type\": \"none\"}]") //
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("TON_RLY", None);

    relayer
}
#[apply(as_task)]
pub fn launch_ton_validator(
    agent_config_path: String,
    agent_config: TonAgentConfig,
    metrics_port: u32,
    debug: bool,
    persistent_path: Option<String>,
) -> AgentHandles {
    let validator_bin = concat_path("../../target/debug", "validator");
    let mut validator_base = tempdir().expect("Failed to create a temp dir").into_path();
    if let Some(persistent_path) = persistent_path {
        validator_base = PathBuf::from(persistent_path);
    }
    let validator_base_db = concat_path(&validator_base, "db");

    fs::create_dir_all(&validator_base_db).expect("Failed to create validator base DB directory");
    info!("Validator DB: {:?}", validator_base_db);

    let checkpoint_path = concat_path(&validator_base, "checkpoint");
    let signature_path = concat_path(&validator_base, "signature");

    let validator = Program::default()
        .bin(validator_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", resolve_abs_path(agent_config_path))
        .env(
            "MY_VALIDATOR_SIGNATURE_DIRECTORY",
            signature_path.to_str().unwrap(),
        )
        .env("RUST_BACKTRACE", "1")
        .env("RUST_LOG", "info")
        .hyp_env("CHECKPOINTSYNCER_PATH", checkpoint_path.to_str().unwrap())
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
        .hyp_env("ORIGINCHAINNAME", agent_config.name)
        .hyp_env("DB", validator_base.to_str().unwrap())
        .hyp_env("METRICSPORT", metrics_port.to_string())
        .hyp_env("VALIDATOR_SIGNER_TYPE", agent_config.signer.typ)
        .hyp_env(
            "VALIDATOR_KEY",
            "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
        )
        .hyp_env(
            "VALIDATOR_MNEMONICPHRASE",
            agent_config.signer.mnemonic_phrase,
        )
        .hyp_env(
            "VALIDATOR_WALLETVERSION",
            agent_config.signer.wallet_version,
        )
        .hyp_env("LOG_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("LOG_FORMAT", "pretty")
        .spawn(make_static(format!("TON-VL{}", metrics_port % 2 + 1)), None);

    validator
}

#[cfg(feature = "ton")]
mod test {
    #[tokio::test]
    async fn test_run() {
        use crate::ton::run_ton_to_ton;
        use std::env;
        env_logger::init();

        use crate::ton::run_ton_to_evm;
        use crate::ton::warp_route::run_ton_to_ton_warp_route;
        let test_case = env::var("TEST_CASE").expect("A required parameter is missing TEST_CASE");

        match test_case.as_str() {
            "ton_to_ton" => run_ton_to_ton(),
            "ton_to_evm" => run_ton_to_evm(),
            "ton_warp_route" => run_ton_to_ton_warp_route().await,
            _ => panic!("Unknown TEST_CASE: {}", test_case),
        }
    }
}
