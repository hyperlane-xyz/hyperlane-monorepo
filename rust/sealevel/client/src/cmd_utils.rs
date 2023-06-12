use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use solana_sdk::signature::{Keypair, Signer};

/// Open a file in append mode, or create it if it does not exist.
fn append_to(p: impl AsRef<Path>) -> File {
    File::options()
        .create(true)
        .append(true)
        .open(p)
        .expect("Failed to open file")
}

pub fn build_cmd(
    cmd: &[&str],
    log: impl AsRef<Path>,
    log_all: bool,
    wd: Option<&str>,
    env: Option<&HashMap<&str, &str>>,
    assert_success: bool,
) {
    assert!(!cmd.is_empty(), "Must specify a command!");
    let mut c = Command::new(cmd[0]);
    c.args(&cmd[1..]);
    if log_all {
        c.stdout(Stdio::inherit());
    } else {
        c.stdout(append_to(log));
    }
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

pub(crate) fn deploy_program(
    payer: &Keypair,
    payer_path: &str,
    program_keypair_path: &str,
    program_path: &str,
    url: &str,
    log_file: impl AsRef<Path>,
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
            payer.pubkey().to_string().as_str(),
            "--program-id",
            program_keypair_path,
        ],
        log_file,
        true,
        None,
        None,
        true,
    );
}

pub(crate) fn create_new_file(parent_dir: &PathBuf, name: &str) -> PathBuf {
    let path = parent_dir.join(name);
    let file = File::create(path.clone())
        .expect(format!("Failed to create file {}", path.display()).as_str());
    path
}

pub(crate) fn create_new_directory(parent_dir: &PathBuf, name: &str) -> PathBuf {
    let path = parent_dir.join(name);
    std::fs::create_dir_all(path.clone())
        .expect(format!("Failed to create directory {}", path.display()).as_str());
    path
}

pub(crate) fn create_and_write_keypair(
    key_dir: &PathBuf,
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
