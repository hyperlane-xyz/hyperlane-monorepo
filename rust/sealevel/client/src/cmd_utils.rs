use clap::builder::{TypedValueParser, ValueParser};
use clap::Arg;
use std::ffi::OsStr;
use std::marker::PhantomData;
use std::str::FromStr;
use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use solana_client::{client_error::ClientError, rpc_client::RpcClient};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

pub(crate) fn account_exists(client: &RpcClient, account: &Pubkey) -> Result<bool, ClientError> {
    // Using `get_account_with_commitment` instead of `get_account` so we get Ok(None) when the account
    // doesn't exist, rather than an error
    let exists = client
        .get_account_with_commitment(account, CommitmentConfig::processed())?
        .value
        .is_some();
    Ok(exists)
}

pub(crate) fn deploy_program_idempotent(
    payer_path: &str,
    program_keypair: &Keypair,
    program_keypair_path: &str,
    program_path: &str,
    url: &str,
) -> Result<(), ClientError> {
    let client = RpcClient::new(url.to_string());
    if !account_exists(&client, &program_keypair.pubkey())? {
        deploy_program(payer_path, program_keypair_path, program_path, url);
    } else {
        println!("Program {} already deployed", program_keypair.pubkey());
    }

    Ok(())
}

pub(crate) fn deploy_program(
    payer_path: &str,
    program_keypair_path: &str,
    program_path: &str,
    url: &str,
) {
    build_cmd(
        &[
            "solana",
            "--url",
            url,
            "-k",
            payer_path,
            "program",
            "deploy",
            program_path,
            "--upgrade-authority",
            payer_path,
            "--program-id",
            program_keypair_path,
        ],
        None,
        None,
        true,
    );
}

pub(crate) fn create_new_directory(parent_dir: &Path, name: &str) -> PathBuf {
    let path = parent_dir.join(name);
    std::fs::create_dir_all(path.clone())
        .unwrap_or_else(|_| panic!("Failed to create directory {}", path.display()));
    path
}

pub(crate) fn create_and_write_keypair(
    key_dir: &Path,
    key_name: &str,
    use_existing_key: bool,
) -> (Keypair, PathBuf) {
    let path = key_dir.join(key_name);

    if use_existing_key {
        if let Ok(file) = File::open(path.clone()) {
            println!("Using existing key at path {}", path.display());
            let keypair_bytes: Vec<u8> = serde_json::from_reader(file).unwrap();
            let keypair = Keypair::from_bytes(&keypair_bytes[..]).unwrap();
            return (keypair, path);
        }
    }

    let keypair = Keypair::new();
    let keypair_json = serde_json::to_string(&keypair.to_bytes()[..]).unwrap();

    let mut file = File::create(path.clone()).expect("Failed to create keypair file");
    file.write_all(keypair_json.as_bytes())
        .expect("Failed to write keypair to file");
    println!("Wrote keypair {} to {}", keypair.pubkey(), path.display());

    (keypair, path)
}

/// Parser for comma separated lists
#[derive(Clone)]
pub(crate) struct CslParser<T>(PhantomData<T>);
impl<T> CslParser<T>
where
    T: FromStr + Clone + Send + Sync + 'static,
    T::Err: std::error::Error + Sized,
{
    pub(crate) fn make() -> ValueParser {
        ValueParser::new(Self(PhantomData::<T>::default()))
    }
}

impl<T> TypedValueParser for CslParser<T>
where
    T: FromStr + Clone + Send + Sync + 'static,
    T::Err: std::error::Error + Sized,
{
    type Value = Vec<T>;

    fn parse_ref(
        &self,
        _cmd: &clap::Command,
        _arg: Option<&Arg>,
        value: &OsStr,
    ) -> Result<Self::Value, clap::Error> {
        value
            .to_str()
            .ok_or_else(|| clap::Error::new(clap::error::ErrorKind::InvalidUtf8))
            .map(|s: &str| s.split(',').map(T::from_str).collect::<Result<_, _>>())?
            .map_err(|e| clap::Error::raw(clap::error::ErrorKind::InvalidValue, e))
    }
}

fn build_cmd(
    cmd: &[&str],
    wd: Option<&str>,
    env: Option<&HashMap<&str, &str>>,
    assert_success: bool,
) {
    assert!(!cmd.is_empty(), "Must specify a command!");
    let mut c = Command::new(cmd[0]);
    c.args(&cmd[1..]);
    c.stdout(Stdio::inherit());
    if let Some(wd) = wd {
        c.current_dir(wd);
    }
    if let Some(env) = env {
        c.envs(env);
    }
    let status = c.status().expect("Failed to run command");
    if assert_success {
        assert!(
            status.success(),
            "Command returned non-zero exit code: {}",
            cmd.join(" ")
        );
    }
}
