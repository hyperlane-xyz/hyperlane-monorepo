use hyperlane_ton::TonProvider;
use log::{info, warn};

use std::{env, fs, thread::sleep, time::Duration};

use crate::ton::launch_ton_relayer;
use crate::ton::launch_ton_validator;
use crate::ton::types::read_deployed_contracts;
use crate::{
    logging::log, ton::setup::deploy_and_setup_domains, ton::types::generate_ton_config,
    ton::utils::build_rust_bins, utils::TaskHandle,
};
use hyperlane_core::HyperlaneDomain;
use hyperlane_core::KnownHyperlaneDomain;
use hyperlane_ton::ton_api_center::TonApiCenterTestUtils;
use hyperlane_ton::wallet_version_from_str;
use hyperlane_ton::TonConnectionConf;
use hyperlane_ton::TonSigner;
use reqwest::Client;
use serde_json::Value;
use url::Url;

use crate::ton::TonHyperlaneStack;

#[allow(dead_code)]
pub async fn run_ton_to_ton_warp_route() {
    info!("Start run_locally() for Ton");
    let domains: Vec<u32> = env::var("DOMAINS")
        .expect("DOMAINS env variable is missing")
        .split(',')
        .map(|d| d.parse::<u32>().expect("Invalid domain format"))
        .collect();
    let origin_token_standard =
        env::var("ORIGIN_TOKEN_STANDARD").expect("Failed to get ORIGIN_TOKEN_STANDARD");
    let destination_token_standart =
        env::var("DESTINATION_TOKEN_STANDARD").expect("Failed to get DESTINATION_TOKEN_STANDARD");
    let validator_key = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

    info!("domains:{:?}", domains);

    deploy_and_setup_domains(&domains, &validator_key);

    for &domain in &domains {
        let domain_str = &format!("{}", domain);
        let deployed_contracts_addresses = read_deployed_contracts(domain_str);
        let mailbox_address = deployed_contracts_addresses
            .get("mailboxAddress")
            .expect("Not found mailbox");
        deploy_warp_route(
            domain,
            origin_token_standard.as_str(),
            destination_token_standart.as_str(),
            mailbox_address.as_str(),
        )
        .expect("Failed to deploy warp route");
    }
    let amount = env::var("AMOUNT")
        .expect("Failed to get amount")
        .parse::<u64>()
        .expect("Failed");

    info!("deploy_all_contracts and send_dispatch finished!");

    let mnemonic = env::var("MNEMONIC").expect("MNEMONIC env is missing");
    let wallet_version = env::var("WALLET_VERSION").expect("WALLET_VERSION env is missing");
    let api_key = env::var("API_KEY").expect("API_KEY env is missing");

    let mnemonic_vec: Vec<String> = mnemonic
        .split_whitespace()
        .map(|word| word.to_string())
        .collect();
    let wallet_version_ton = wallet_version_from_str(&wallet_version)
        .expect("Failed to convert ton walletVersion from str");

    let wallet = TonSigner::from_mnemonic(mnemonic_vec, wallet_version_ton)
        .expect("Failed to create signer from mnemonic");
    let recipient = wallet.address.to_base64_url();

    let http_client = Client::new();
    let api_url = "https://testnet.toncenter.com/api/";
    let connection_conf = TonConnectionConf::new(
        Url::parse(api_url).expect("Failed to parse url"),
        api_key.to_string(),
        100,
    );
    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::TonTest1); // It doesn't matter now.

    let provider = TonProvider::new(http_client, connection_conf, domain);

    let initial_balance: u128 = get_balance(&provider, domains[1], &recipient)
        .await
        .expect("Failed to get initial_balance");

    info!("Initial jetton wallet balance: {}", initial_balance);
    let _ = send_transfer(domains[0], domains[1], amount, &recipient);
    sleep(Duration::from_secs(80));
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

    info!("Waiting for agents to run for 1.5 minutes...");
    sleep(Duration::from_secs(90));

    let current_balance: u128 = get_balance(&provider, domains[1], &recipient)
        .await
        .expect("Failed to get initial_balance");
    if current_balance <= initial_balance {
        warn!("current_balance <= initial_balance");
    }
    info!("current_balance:{:?}", current_balance);

    let _ = send_burn(domains[1], domains[0], 1, &recipient);
    sleep(Duration::from_secs(60));
    info!("Send burn executed, waiting for agents to run for 1 minutes...");
    let balance_after_burn = get_balance(&provider, domains[1], &recipient)
        .await
        .expect("Failed to get initial_balance");
    info!("balance_after_burn:{:?}", balance_after_burn);

    if balance_after_burn >= current_balance {
        warn!("burn failed because balance_after_burn >= current_balance");
    }
    sleep(Duration::from_secs(60));

    let _ = TonHyperlaneStack {
        validators: validators.into_iter().map(|v| v.join()).collect(),
        relayer: relayer.join(),
    };
}

use std::process::Command;
use std::str::from_utf8;

pub fn deploy_warp_route(
    domain: u32,
    origin_token_standart: &str,
    destination_token_standart: &str,
    mailbox_address: &str,
) -> Result<String, String> {
    log!("Launching Warp Route deployment...");

    let working_dir = "../../../../altvm_contracts/ton";

    let output = Command::new("yarn")
        .arg("run")
        .arg("deploy:warp")
        .arg("--mnemonic")
        .arg("--testnet")
        .env("DOMAIN", domain.to_string())
        .env("ORIGIN_TOKEN_STANDARD", origin_token_standart)
        .env("DESTINATION_TOKEN_STANDARD", destination_token_standart)
        .env("MAILBOX_ADDRESS", mailbox_address)
        .current_dir(working_dir)
        .output()
        .expect("Failed to execute deploy:warp");

    let stdout = from_utf8(&output.stdout).unwrap_or("[Invalid UTF-8]");
    let stderr = from_utf8(&output.stderr).unwrap_or("[Invalid UTF-8]");

    if !output.status.success() {
        log!("Deploy failed with status: {}", output.status);
        log!("stderr:\n{}", stderr);
        return Err(format!(
            "Deploy failed with status: {}\nstderr:\n{}",
            output.status, stderr
        ));
    }

    log!("Deploy script executed successfully!");
    log!("stdout:\n{}", stdout);

    let deployed_contracts_path = format!("{}/warp-contracts-{}.json", working_dir, domain);

    match fs::read_to_string(&deployed_contracts_path) {
        Ok(content) => Ok(content),
        Err(err) => {
            log!("Failed to read deployed contracts: {}", err);
            Err("Failed to read deployed contracts".into())
        }
    }
}
pub fn send_transfer(
    origin_domain: u32,
    dest_domain: u32,
    amount: u64,
    recipient: &str,
) -> Result<(), String> {
    info!("Launching sendTransfer script...");

    let working_dir = "../../../../altvm_contracts/ton";

    let output = Command::new("yarn")
        .arg("run")
        .arg("warp:send")
        .arg("--mnemonic")
        .arg("--testnet")
        .env("WALLET_VERSION", "v4")
        .env("ORIGIN_DOMAIN", &origin_domain.to_string())
        .env("DESTINATION_DOMAIN", &dest_domain.to_string())
        .env("AMOUNT", &amount.to_string())
        .env("ORIGIN_TOKEN_STANDARD", "NATIVE")
        .env("RECIPIENT", &recipient)
        .current_dir(working_dir)
        .output()
        .expect("Failed to execute sendTransfer");

    let stdout = from_utf8(&output.stdout).unwrap_or("[Invalid UTF-8]");
    let stderr = from_utf8(&output.stderr).unwrap_or("[Invalid UTF-8]");

    if !output.status.success() {
        info!("warpSend failed with status: {}", output.status);
        info!("stderr:\n{}", stderr);
        return Err(format!(
            "sendTransfer failed with status: {}\nstderr:\n{}",
            output.status, stderr
        ));
    }
    if !stderr.trim().is_empty() {
        log!("stderr:\n{}", stderr);
        return Err(format!("stderr:\n{}", stderr));
    }

    log!("sendTransfer script executed successfully!");
    log!("stdout:\n{}", stdout);

    Ok(())
}

pub fn send_burn(
    origin_domain: u32,
    dest_domain: u32,
    amount: u64,
    recipient: &str,
) -> Result<(), String> {
    log!("Launching sendTransfer script...");

    let working_dir = "../../../../altvm_contracts/ton";

    let output = Command::new("yarn")
        .arg("run")
        .arg("warp:burn")
        .arg("--mnemonic")
        .arg("--testnet")
        .env("WALLET_VERSION", "v4")
        .env("ORIGIN_DOMAIN", origin_domain.to_string())
        .env("DESTINATION_DOMAIN", dest_domain.to_string())
        .env("ORIGIN_TOKEN_STANDARD", "SYNTHETIC")
        .env("AMOUNT", amount.to_string())
        .env("RECIPIENT", recipient)
        .current_dir(working_dir)
        .output()
        .expect("Failed to execute sendTransfer");

    let stdout = from_utf8(&output.stdout).unwrap_or("[Invalid UTF-8]");
    let stderr = from_utf8(&output.stderr).unwrap_or("[Invalid UTF-8]");

    if !output.status.success() {
        log!("warp burn failed with status: {}", output.status);
        log!("stderr:\n{}", stderr);
        return Err(format!(
            "send burn failed with status: {}\nstderr:\n{}",
            output.status, stderr
        ));
    }

    log!("warp burn script executed successfully!");
    log!("stdout:\n{}", stdout);

    Ok(())
}

pub async fn get_balance(
    provider: &TonProvider,
    domain: u32,
    owner_address: &str,
) -> Result<u128, Box<dyn std::error::Error>> {
    let warp_json = read_warp_contracts(domain).expect("Failed to read warp contracts");

    let jetton_wallet_address = warp_json
        .get("jettonMinter")
        .and_then(|v| v.as_str())
        .expect("Jetton minter (wallet) address not found in JSON");

    let initial_response = provider
        .get_jetton_wallets(
            Some(vec![jetton_wallet_address.to_string()]),
            Some(vec![owner_address.to_string()]),
            None,
            None,
            Some(100),
            Some(0),
            None,
        )
        .await
        .expect("Failed to jettons");

    if initial_response.jetton_wallets.is_empty() {
        return Ok(0);
    }

    let first_wallet = initial_response
        .jetton_wallets
        .get(0)
        .expect("No wallets found in the response");

    let balance: u128 = first_wallet
        .balance
        .parse()
        .expect("Invalid balance format");
    return Ok(balance);
}

pub fn read_warp_contracts(domain: u32) -> Option<Value> {
    let file_path = format!(
        "../../../../altvm_contracts/ton/warp-contracts-{}.json",
        domain
    );

    match fs::read_to_string(&file_path) {
        Ok(content) => match serde_json::from_str::<Value>(&content) {
            Ok(json) => {
                log!("Successfully read warp contracts from: {}", file_path);
                Some(json)
            }
            Err(err) => {
                log!("Failed to parse JSON from {}: {}", file_path, err);
                None
            }
        },
        Err(err) => {
            log!("Failed to read file {}: {}", file_path, err);
            None
        }
    }
}
