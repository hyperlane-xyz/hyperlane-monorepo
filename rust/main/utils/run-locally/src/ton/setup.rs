use serde_json::Value;
use std::fs;
use std::process::Command;
use std::str::from_utf8;
use std::thread::sleep;
use std::time::Duration;

use crate::logging::log;

pub fn deploy_and_setup_domains(domains: &[u32], validator_key: &str) {
    for &domain in domains {
        deploy_and_setup_domain(domain, validator_key);
    }
}
pub fn deploy_and_setup_domain(domain: u32, validator_key: &str) {
    deploy_all_contracts(domain);
    sleep(Duration::from_secs(30));
    send_set_validators_and_threshold(domain, validator_key)
        .expect("Failed to set validators and threshold");
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
