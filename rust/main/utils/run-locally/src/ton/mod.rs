use log::info;
use macro_rules_attribute::apply;
use serde_json::Value;
use std::process::Command;
use std::str::from_utf8;
use std::{
    env, fs,
    path::{Path, PathBuf},
    thread::sleep,
    time::Duration,
};
use tempfile::tempdir;

use crate::{
    logging::log,
    program::Program,
    ton::types::{generate_ton_config, TonAgentConfig},
    utils::{as_task, concat_path, make_static, stop_child, AgentHandles, TaskHandle},
};
mod types;

pub struct TonHyperlaneStack {
    pub validators: Vec<AgentHandles>,
    pub relayer: AgentHandles,
    pub scraper: AgentHandles,
    pub postgres: AgentHandles,
}

impl Drop for TonHyperlaneStack {
    fn drop(&mut self) {
        for v in &mut self.validators {
            stop_child(&mut v.1);
        }
        stop_child(&mut self.scraper.1);
        stop_child(&mut self.postgres.1);
        stop_child(&mut self.relayer.1);
    }
}

#[allow(dead_code)]
fn run_locally() {
    info!("Start run_locally() for Ton");
    let domains: Vec<u32> = env::var("DOMAINS")
        .expect("DOMAINS env variable is missing")
        .split(',')
        .map(|d| d.parse::<u32>().expect("Invalid domain format"))
        .collect();
    let validator_key = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

    info!("domains:{:?}", domains);

    for &domain in &domains {
        deploy_all_contracts(domain);
        sleep(Duration::from_secs(30));

        send_set_validators_and_threshold(domain, validator_key).expect(&format!(
            "Failed to set validators and threshold for domain {}",
            domain
        ));
    }
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

    let scraper_metrics_port = metrics_port + 10;
    info!("Running postgres db...");
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "ton-scraper-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL", None);

    sleep(Duration::from_secs(10));

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

    let scraper = launch_ton_scraper(
        agent_config_path.clone(),
        relay_chains.clone(),
        scraper_metrics_port,
        debug,
    );

    info!("Waiting for agents to run for 3 minutes...");
    sleep(Duration::from_secs(300));

    let _ = TonHyperlaneStack {
        validators: validators.into_iter().map(|v| v.join()).collect(),
        relayer: relayer.join(),
        scraper: scraper.join(),
        postgres,
    };
}

fn resolve_abs_path<P: AsRef<Path>>(rel_path: P) -> String {
    let mut configs_path = env::current_dir().unwrap();
    configs_path.push(rel_path);
    configs_path
        .canonicalize()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned()
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
#[apply(as_task)]
#[allow(clippy::let_and_return)]
fn launch_ton_scraper(
    agent_config_path: String,
    chains: Vec<String>,
    metrics: u32,
    debug: bool,
) -> AgentHandles {
    let bin = concat_path("../../target/debug", "scraper");

    info!(
        "Current working directory: {:?}",
        env::current_dir().unwrap()
    );
    info!("CHAINSTOSCRAPE env variable: {}", chains.join(","));

    let scraper = Program::default()
        .bin(bin)
        .working_dir("../../")
        .env("CONFIG_FILES", resolve_abs_path(agent_config_path))
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHAINSTOSCRAPE", chains.join(","))
        .hyp_env("tontest1", "1")
        .hyp_env("tontest2", "1")
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("TRACING_LEVEL", if debug { "info" } else { "warn" })
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("TON_SCR", None);

    scraper
}

pub fn send_dispatch(dispatch_domain: u32, target_domain: u32) -> Result<(), String> {
    log!("Launching sendDispatch script...");

    let working_dir = "../../../../altvm_contracts/ton";

    let output = Command::new("yarn")
        .arg("run")
        .arg("send:dispatch")
        .env("RUST_LOG", "debug")
        .env("DOMAIN", &dispatch_domain.to_string())
        .env("WALLET_VERSION", "v4")
        .env("DISPATCH_DOMAIN", &dispatch_domain.to_string())
        .env("TARGET_DOMAIN", &target_domain.to_string())
        .current_dir(working_dir)
        .output()
        .expect("Failed to execute send:dispatch");

    let stdout = from_utf8(&output.stdout).unwrap_or("[Invalid UTF-8]");
    let stderr = from_utf8(&output.stderr).unwrap_or("[Invalid UTF-8]");

    if !output.status.success() {
        log!("sendDispatch failed with status: {}", output.status);
        log!("stderr:\n{}", stderr);
        return Err(format!(
            "sendDispatch failed with status: {}\nstderr:\n{}",
            output.status, stderr
        ));
    }

    log!("sendDispatch script executed successfully!\n");

    if !stderr.trim().is_empty() {
        log!("stderr:\n{}", stderr);
        return Err(format!("stderr:\n{}", stderr));
    }

    log!("stdout:\n{}", stdout);

    log!("sendDispatch script completed!");
    Ok(())
}

pub fn send_set_validators_and_threshold(domain: u32, validator_key: &str) -> Result<(), String> {
    log!("Launching sendSetValidatorsAndThreshold script...");

    let working_dir = "../../../../altvm_contracts/ton";

    let output = Command::new("yarn")
        .arg("run")
        .arg("send:setv")
        .arg("--mnemonic")
        .arg("--testnet")
        .env("SET_VALIDATORS_DOMAIN", &domain.to_string())
        .env("WALLET_VERSION", "v4")
        .env("VALIDATOR_KEY", validator_key)
        .env("RUST_LOG", "debug")
        .current_dir(working_dir)
        .output()
        .expect("Failed to execute sendSetValidatorsAndThreshold");

    let stdout = from_utf8(&output.stdout).unwrap_or("[Invalid UTF-8]");
    let stderr = from_utf8(&output.stderr).unwrap_or("[Invalid UTF-8]");

    if !output.status.success() {
        log!(
            "sendSetValidatorsAndThreshold failed with status: {}",
            output.status
        );
        log!("stderr:\n{}", stderr);
        return Err(format!(
            "sendSetValidatorsAndThreshold failed with status: {}\nstderr:\n{}",
            output.status, stderr
        ));
    }
    if !stderr.trim().is_empty() {
        log!("stderr:\n{}", stderr);
        return Err(format!("stderr:\n{}", stderr));
    }

    log!("sendSetValidatorsAndThreshold script executed successfully!");
    log!("stdout:\n{}", stdout);

    Ok(())
}

pub fn deploy_all_contracts(domain: u32) -> Option<Value> {
    log!("Launching deploy:all script with DOMAIN={}...", domain);

    let working_dir = "../../../../altvm_contracts/ton";

    let output = Command::new("yarn")
        .arg("run")
        .arg("deploy:all")
        .env("RUST_LOG", "debug")
        .env("DOMAIN", domain.to_string())
        .env("WALLET_VERSION", "v4")
        .current_dir(working_dir)
        .output()
        .expect("Failed to execute deploy:all");

    let stdout = from_utf8(&output.stdout).unwrap_or("[Invalid UTF-8]");
    let stderr = from_utf8(&output.stderr).unwrap_or("[Invalid UTF-8]");

    if !output.status.success() {
        log!("deploy:all failed with status: {}", output.status);
        log!("stderr:\n{}", stderr);
        return None;
    }

    log!("deploy:all script executed successfully!");

    log!("stdout:\n{}", stdout);

    let deployed_contracts_path = format!("{}/deployedContracts.json", working_dir);
    let output_file = format!("{}/deployedContracts_{}.json", working_dir, domain);

    match fs::read_to_string(&deployed_contracts_path) {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(mut json) => {
                log!("Successfully read deployed contracts:");
                log!("{}", json);

                fs::write(&output_file, content)
                    .expect("Failed to save deployed contract addresses");

                log!("Saved deployed contracts to {}", output_file);
                json["saved_file"] = serde_json::Value::String(output_file);
                Some(json)
            }
            Err(err) => {
                log!("Failed to parse deployedContracts.json: {}", err);
                None
            }
        },
        Err(err) => {
            log!("Failed to read deployedContracts.json: {}", err);
            None
        }
    }
}

#[cfg(feature = "ton")]
mod test {
    #[test]
    fn test_run() {
        use crate::ton::run_locally;
        env_logger::init();

        run_locally()
    }
}
