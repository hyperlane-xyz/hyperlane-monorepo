use std::path::Path;
use std::{thread::sleep, time::Duration};

use crate::program::Program;
use crate::utils::{concat_path, make_static, AgentHandles};
use crate::{TaskHandle, AGENT_BIN_PATH, AGENT_LOGGING_DIR};

use super::types::ChainRegistry;

const AGENTS_STARTING_METRICS_PORT: u16 = 9096;
pub const RELAYER_METRICS_PORT: u16 = AGENTS_STARTING_METRICS_PORT;
pub const SCRAPER_METRICS_PORT: u16 = AGENTS_STARTING_METRICS_PORT + 1;
const VALIDATOR_METRICS_PORT: u16 = AGENTS_STARTING_METRICS_PORT + 2;
pub const VALIDATOR_KEY: &str =
    "0x6c164a86d0eb22bdcad687c0aa2e202b81adf0b3281f99eda9e981f8d7dc8e68";
pub const VALIDATOR_ADDRESS: &str = "0xCFEA1DF4A1D03c1A2FA31063330Aa77cEa5Fa102";

pub fn start_scraper_db() -> AgentHandles {
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "scraper-testnet-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL", None);
    // give postgres time to start
    sleep(Duration::from_secs(15));

    Program::new(concat_path(format!("../../{AGENT_BIN_PATH}"), "init-db"))
        .run()
        .join();
    postgres
}

pub fn start_scraper(conf_path: &Path, conf: &ChainRegistry) -> AgentHandles {
    let bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "scraper");

    Program::default()
        .bin(bin)
        .working_dir("../../")
        .env("CONFIG_FILES", conf_path.display().to_string())
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHAINSTOSCRAPE", conf.as_relay_list())
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("METRICSPORT", SCRAPER_METRICS_PORT.to_string())
        .spawn("SCR", None)
}

pub fn start_relayer(conf_path: &Path, conf: &ChainRegistry, base_dir: &Path) -> AgentHandles {
    let bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer");
    let data_dir = base_dir.join("relayer");
    let debug = false;

    Program::default()
        .bin(bin)
        .working_dir("../../")
        .env("CONFIG_FILES", conf_path.display().to_string())
        .env("RUST_BACKTRACE", "1")
        .hyp_env("RELAYCHAINS", conf.as_relay_list())
        .hyp_env("DB", data_dir.display().to_string())
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("GASPAYMENTENFORCEMENT", "[{\"type\": \"none\"}]")
        .hyp_env("METRICSPORT", RELAYER_METRICS_PORT.to_string())
        .spawn("RLY", Some(&AGENT_LOGGING_DIR))
}

pub fn start_validators(
    conf_path: &Path,
    conf: &ChainRegistry,
    base_dir: &Path,
) -> Vec<AgentHandles> {
    let bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "validator");
    let data_dir = base_dir.join("validators");
    let mut validators = Vec::with_capacity(conf.chains.len());

    for (i, name) in conf.chains.keys().enumerate() {
        let dir = data_dir.join(name);
        let db_dir = dir.join("db");

        std::fs::create_dir_all(&db_dir).expect("failed to create validator db dir");

        let checkpoint_path = dir.join("checkpoint");
        let port = VALIDATOR_METRICS_PORT + i as u16;
        let id = make_static(format!("VAL-{name}"));

        let validator = Program::default()
            .bin(&bin)
            .working_dir("../../")
            .env("CONFIG_FILES", conf_path.display().to_string())
            .env("RUST_BACKTRACE", "1")
            .hyp_env("CHECKPOINTSYNCER_PATH", checkpoint_path.to_str().unwrap())
            .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
            .hyp_env("ORIGINCHAINNAME", name)
            .hyp_env("DB", db_dir.display().to_string())
            .hyp_env("METRICSPORT", port.to_string())
            .hyp_env("VALIDATOR_KEY", VALIDATOR_KEY)
            .spawn(id, Some(&AGENT_LOGGING_DIR));
        validators.push(validator);
    }

    validators
}
