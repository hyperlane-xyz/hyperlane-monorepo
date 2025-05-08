use std::{
    collections::HashMap,
    fs::File,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread::sleep,
    time::Duration,
};

use solana_client::{
    client_error::{ClientError, ClientErrorKind},
    rpc_client::RpcClient,
};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

const SOLANA_DOMAIN: u32 = 1399811149;

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

    let client = RpcClient::new(url.to_string());
    if account_exists(&client, &program_keypair.pubkey())? {
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
            // Success!
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
    ];

    let compute_unit_price_str = compute_unit_price.to_string();
    if compute_unit_price > 0 {
        command.extend(vec!["--with-compute-unit-price", &compute_unit_price_str]);
    }

    // Success!
    if let Ok(true) = run_cmd(command.as_slice(), None, None) {
        // TODO: use commitment level instead of just sleeping here?
        println!("Sleeping for 5 seconds to fully allow program to be deployed");
        sleep(Duration::from_secs(5));

        return Ok(());
    }

    Err(ClientErrorKind::Custom(format!(
        "Attempted program deploy failed for {}",
        program_name
    ))
    .into())
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
        let keypair = Keypair::from_bytes(&keypair_bytes[..]).unwrap();
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
