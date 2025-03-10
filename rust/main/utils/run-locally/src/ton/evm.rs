use log::info;
use macro_rules_attribute::apply;
use std::{fs, path::PathBuf};
use tempfile::tempdir;

use crate::{
    logging::log,
    program::Program,
    ton::utils::resolve_abs_path,
    utils::{as_task, concat_path, make_static, AgentHandles},
};

#[apply(as_task)]
pub fn launch_evm_to_ton_relayer(
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
        .hyp_env("tontest1", "777001")
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("GASPAYMENTENFORCEMENT", "[{\"type\": \"none\"}]") //
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("EVM_TON_RLY", None);

    relayer
}

#[apply(as_task)]
pub fn launch_evm_validator(
    agent_config_path: String,
    private_key: String,
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
        .hyp_env("ORIGINCHAINNAME", "arbitrumsepolia")
        .hyp_env("DB", validator_base.to_str().unwrap())
        .hyp_env("METRICSPORT", metrics_port.to_string())
        .hyp_env("VALIDATOR_SIGNER_TYPE", "hexkey")
        .hyp_env(
            "VALIDATOR_KEY",
            "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
        )
        .hyp_env("SIGNER_SIGNER_TYPE", "hexKey")
        .hyp_env("SIGNER_KEY", private_key)
        .hyp_env("LOG_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("LOG_FORMAT", "pretty")
        .spawn(make_static(format!("EVM-VL{}", metrics_port % 2 + 1)), None);

    validator
}
