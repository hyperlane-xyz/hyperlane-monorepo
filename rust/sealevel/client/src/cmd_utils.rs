use std::{
    collections::HashMap,
    fs::File,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

use solana_client::{
    client_error::{ClientError, ClientErrorKind},
    rpc_client::RpcClient,
};
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

use crate::ECLIPSE_DOMAIN;

const SOLANA_DOMAIN: u32 = 1399811149;
const PROGRAM_READY_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn get_compute_unit_price_micro_lamports_for_id(domain: u32) -> u64 {
    get_compute_unit_price(domain == SOLANA_DOMAIN)
}

pub(crate) fn get_compute_unit_price_micro_lamports_for_chain_name(chain_name: &str) -> u64 {
    get_compute_unit_price(chain_name == "solanamainnet")
}

fn get_compute_unit_price(is_solanamainnet: bool) -> u64 {
    if is_solanamainnet {
        // Generally taking a low/medium value from https://www.quicknode.com/gas-tracker/solana
        500_000
    } else {
        0
    }
}

pub(crate) fn account_exists(client: &RpcClient, account: &Pubkey) -> Result<bool, ClientError> {
    // Using `get_account_with_commitment` instead of `get_account` so we get Ok(None) when the account
    // doesn't exist, rather than an error
    let exists = client
        .get_account_with_commitment(account, CommitmentConfig::processed())?
        .value
        .is_some();
    Ok(exists)
}

pub(crate) fn deploy_program(
    payer_keypair_path: &str,
    program_key_dir: &Path,
    program_name: &str,
    program_path: &str,
    url: &str,
    local_domain: u32,
) -> Result<Pubkey, ClientError> {
    let (program_keypair, program_keypair_path) = create_or_get_keypair(
        program_key_dir,
        format!("{}-keypair.json", program_name).as_str(),
    );
    let program_id = program_keypair.pubkey();

    let client = RpcClient::new_with_timeout(url.to_string(), Duration::from_secs(5));
    if account_exists(&client, &program_keypair.pubkey())? {
        wait_for_program_ready(&client, &program_id, PROGRAM_READY_TIMEOUT)?;
        println!("Program {} already deployed", program_keypair.pubkey());
        return Ok(program_id);
    }

    let (buffer_keypair, buffer_keypair_path) = create_or_get_keypair(
        program_key_dir,
        format!("{}-buffer.json", program_name).as_str(),
    );

    let mut compute_unit_price = get_compute_unit_price_micro_lamports_for_id(local_domain);

    for attempt in 0..10 {
        println!("Attempting program deploy Program ID: {}, buffer pubkey: {}, compute unit price: {}, attempt number {}", program_id, buffer_keypair.pubkey(), compute_unit_price, attempt);

        if attempt > 0 {
            println!(
                "As this is not the first deploy attempt, the buffer {} is re-used",
                buffer_keypair.pubkey()
            );
        }

        // Temporary measure for Eclipse due to incompatibility with Solana CLI 1.18.18
        // to avoid setting a non-zero compute unit price, which is not supported
        // by earlier versions of the Solana CLI.
        if local_domain == ECLIPSE_DOMAIN {
            compute_unit_price = 0;
        }

        if attempt_program_deploy(
            payer_keypair_path,
            program_name,
            program_path,
            &program_keypair_path,
            &buffer_keypair_path,
            url,
            compute_unit_price,
        )
        .is_ok()
        {
            // Check visibility at the same commitment used by subsequent client
            // transactions. Do not redeploy an accepted transaction on timeout.
            wait_for_program_ready(&client, &program_id, PROGRAM_READY_TIMEOUT)?;
            return Ok(program_id);
        }

        // Failed to deploy program, try again with a higher compute unit price

        println!(
            "Failed to deploy program with compute unit price {}",
            compute_unit_price
        );

        // Bump by 10% each time if non-zero, otherwise start at 1000 micro lamports
        compute_unit_price = if compute_unit_price > 0 {
            compute_unit_price * 11 / 10
        } else {
            1000
        };

        println!(
            "Sleeping 1s, then retrying with new compute unit price {}",
            compute_unit_price
        );
        sleep(Duration::from_secs(1));
    }

    Err(ClientErrorKind::Custom(format!("Failed to deploy program {}", program_name)).into())
}

fn attempt_program_deploy(
    payer_keypair_path: &str,
    program_name: &str,
    program_path: &str,
    program_keypair_path: &Path,
    buffer_keypair_path: &Path,
    url: &str,
    compute_unit_price: u64,
) -> Result<(), ClientError> {
    let mut command = vec![
        "solana",
        "--url",
        url,
        "-k",
        payer_keypair_path,
        "program",
        "deploy",
        program_path,
        "--upgrade-authority",
        payer_keypair_path,
        "--program-id",
        program_keypair_path.to_str().unwrap(),
        "--buffer",
        buffer_keypair_path.to_str().unwrap(),
        // Some chains/RPCs don't support TPUs (e.g. Solaxy), so we use RPC instead
        "--use-rpc",
    ];

    let compute_unit_price_str = compute_unit_price.to_string();
    if compute_unit_price > 0 {
        command.extend(vec!["--with-compute-unit-price", &compute_unit_price_str]);
    }

    if let Ok(true) = run_cmd(command.as_slice(), None, None) {
        return Ok(());
    }

    Err(ClientErrorKind::Custom(format!(
        "Attempted program deploy failed for {}",
        program_name
    ))
    .into())
}

fn wait_for_program_ready(
    client: &RpcClient,
    program_id: &Pubkey,
    timeout: Duration,
) -> Result<(), ClientError> {
    let deadline = Instant::now() + timeout;
    loop {
        if client
            .get_account_with_commitment(program_id, CommitmentConfig::confirmed())?
            .value
            .is_some_and(|account| account.executable)
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ClientErrorKind::Custom(format!(
                "Program {program_id} did not become executable at confirmed commitment"
            ))
            .into());
        }
        sleep(Duration::from_millis(100));
    }
}

pub(crate) fn create_new_directory(parent_dir: &Path, name: &str) -> PathBuf {
    let path = parent_dir.join(name);
    std::fs::create_dir_all(path.clone())
        .unwrap_or_else(|_| panic!("Failed to create directory {}", path.display()));
    path
}

pub(crate) fn create_or_get_keypair(key_dir: &Path, key_name: &str) -> (Keypair, PathBuf) {
    let path = key_dir.join(key_name);

    if let Ok(file) = File::open(path.clone()) {
        println!("Using existing key at path {}", path.display());
        let keypair_bytes: Vec<u8> = serde_json::from_reader(file).unwrap();
        let keypair = Keypair::try_from(keypair_bytes.as_slice()).unwrap();
        return (keypair, path);
    }

    let keypair = Keypair::new();
    let keypair_json = serde_json::to_string(&keypair.to_bytes()[..]).unwrap();

    let mut file = File::create(path.clone()).expect("Failed to create keypair file");
    file.write_all(keypair_json.as_bytes())
        .expect("Failed to write keypair to file");
    println!("Wrote keypair {} to {}", keypair.pubkey(), path.display());

    (keypair, path)
}

fn run_cmd(cmd: &[&str], wd: Option<&str>, env: Option<&HashMap<&str, &str>>) -> io::Result<bool> {
    assert!(!cmd.is_empty(), "Must specify a command!");
    if cmd.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "Must specify a command!",
        ));
    }
    let mut c = Command::new(cmd[0]);
    c.args(&cmd[1..]);
    c.stdout(Stdio::inherit());
    c.stderr(Stdio::inherit());
    if let Some(wd) = wd {
        c.current_dir(wd);
    }
    if let Some(env) = env {
        c.envs(env);
    }
    println!("Running command: {:?}", c);
    let status = c.status()?;
    Ok(status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use solana_client::rpc_request::RpcRequest;

    fn program_response(executable: bool) -> serde_json::Value {
        json!({"context": {"slot": 10}, "value": {
            "lamports": 1, "data": ["", "base64"],
            "owner": Pubkey::default().to_string(),
            "executable": executable, "rentEpoch": 0
        }})
    }

    #[test]
    fn program_readiness_accepts_executable_account_immediately() {
        let client = RpcClient::new_mock_with_mocks(
            "succeeds",
            HashMap::from([(RpcRequest::GetAccountInfo, program_response(true))]),
        );
        wait_for_program_ready(&client, &Pubkey::new_unique(), Duration::ZERO).unwrap();
    }

    #[test]
    fn program_readiness_rejects_missing_or_nonexecutable_accounts() {
        for response in [
            json!({"context": {"slot": 10}, "value": null}),
            program_response(false),
        ] {
            let client = RpcClient::new_mock_with_mocks(
                "succeeds",
                HashMap::from([(RpcRequest::GetAccountInfo, response)]),
            );
            assert!(
                wait_for_program_ready(&client, &Pubkey::new_unique(), Duration::ZERO).is_err()
            );
        }
    }

    #[test]
    fn program_readiness_waits_until_account_is_executable() {
        let client = RpcClient::new_mock_with_mocks_map(
            "succeeds",
            [
                (RpcRequest::GetAccountInfo, program_response(false)),
                (RpcRequest::GetAccountInfo, program_response(true)),
            ]
            .into_iter()
            .collect(),
        );
        wait_for_program_ready(&client, &Pubkey::new_unique(), Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn program_readiness_propagates_rpc_errors() {
        let client = RpcClient::new_mock("fails");
        assert!(wait_for_program_ready(&client, &Pubkey::new_unique(), Duration::ZERO).is_err());
    }
}
