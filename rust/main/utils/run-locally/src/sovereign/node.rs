#![allow(dead_code)]

use std::{
    env, fs,
    path::{Path, PathBuf},
    thread::sleep,
    time::Duration,
};

use macro_rules_attribute::apply;
use tempfile::tempdir;
use toml_edit::{value, Document};

use crate::{
    logging::log,
    program::Program,
    utils::{as_task, concat_path, AgentHandles, TaskHandle},
};

const SOVEREIGN_ROLLUP_REPO: &str = "git@github.com:Sovereign-Labs/rollup-starter.git";
const SOVEREIGN_ROLLUP_BRANCH: &str = "main";
const SOVEREIGN_ROLLUP_PATH_ENV: &str = "SOVEREIGN_ROLLUP_PATH";
const SOVEREIGN_NODE_COUNT: usize = 2;
const SOVEREIGN_BASE_RPC_PORT: u16 = 12345;
const SOVEREIGN_BASE_CHAIN_ID: u32 = 50001;

/// Clone the Sovereign rollup starter repository, or use existing if present
/// Has Hyperlane Sovereign modules preconfigured.
pub fn clone_sovereign_rollup(clone_dir: PathBuf) -> PathBuf {
    if clone_dir.exists() && clone_dir.join("Cargo.toml").exists() {
        log!(
            "Using existing Sovereign rollup repository at {:?}",
            clone_dir
        );
        return clone_dir;
    }

    log!(
        "Cloning Sovereign rollup repository from {} to {:?}",
        SOVEREIGN_ROLLUP_REPO,
        clone_dir
    );

    // Clone the repository
    Program::new("git")
        .cmd("clone")
        .arg("branch", SOVEREIGN_ROLLUP_BRANCH)
        .arg("depth", "1") // Shallow clone for faster setup
        .cmd(SOVEREIGN_ROLLUP_REPO)
        .cmd(clone_dir.to_str().unwrap())
        .run()
        .join();

    log!("Successfully cloned Sovereign rollup repository");
    clone_dir
}

#[derive(Debug, Clone)]
pub struct SovereignParameters {
    /// Name of the rollup chain. Used for other things like docker image tag, etc
    pub name: String,
    /// REST API port that the rollup will listen on
    pub port: u16,
    /// Id that is used for the sovereign specific chain id and hyperlane domain id
    pub id: u32,
}

impl SovereignParameters {
    pub fn for_index(i: usize) -> Self {
        Self {
            name: format!("sov-rollup-{}", i),
            port: SOVEREIGN_BASE_RPC_PORT + i as u16,
            id: SOVEREIGN_BASE_CHAIN_ID + i as u32,
        }
    }

    pub fn docker_image(&self) -> String {
        format!("sovereign-rollup:{}", self.name)
    }
}

fn create_node_specific_constants(rollup_dir: &Path, params: &SovereignParameters) -> PathBuf {
    let constants_path = rollup_dir.join("constants.toml");
    let original_content = fs::read_to_string(&constants_path)
        .expect("Failed to read constants.toml from rollup repository");
    log!("Reading constants.toml and customizing for {}", params.name);

    let mut doc = original_content
        .parse::<Document>()
        .expect("Failed to parse constants.toml as valid TOML");

    if let Some(constants_table) = doc["constants"].as_table_mut() {
        constants_table["CHAIN_ID"] = value(params.id as i64);
        constants_table["CHAIN_NAME"] = value(&params.name);
        constants_table["HYPERLANE_BRIDGE_DOMAIN"] = value(params.id as i64);
    } else {
        panic!("Failed to find [constants] section in constants.toml");
    }

    let modified_content = doc.to_string();
    fs::write(&constants_path, modified_content)
        .expect("Failed to write node-specific constants.toml");

    constants_path
}

/// Build the Sovereign rollup node Docker image with specific constants
pub fn build_sovereign_node_docker_with_constants(rollup_dir: &Path, params: &SovereignParameters) {
    create_node_specific_constants(rollup_dir, params);

    let image_name = params.docker_image();

    Program::new("docker")
        .cmd("build")
        .arg("file", "integrations/rollup/Dockerfile.mock")
        .arg("build-arg", "BUILD_MODE=release")
        .arg("tag", &image_name)
        .cmd(".")
        .working_dir(rollup_dir)
        .run()
        .join();

    log!(
        "Successfully built Sovereign rollup Docker image: {}",
        image_name
    );
}

#[apply(as_task)]
pub fn start_sovereign_node_docker(
    params: SovereignParameters,
    rollup_path: PathBuf,
) -> AgentHandles {
    log!(
        "Starting Sovereign node '{}' with RPC port {} in Docker container",
        params.name,
        params.port,
    );

    // Create temporary directories for volume mounting
    let temp_dir = tempdir().expect("Failed to create temp directory");
    let da_dir = temp_dir.path().join("da");
    let state_dir = temp_dir.path().join("state");
    fs::create_dir_all(&da_dir).expect("Failed to create da directory");
    fs::create_dir_all(&state_dir).expect("Failed to create state directory");
    let rollup_config = rollup_path.join("configs/mock/rollup-dockerized.toml");

    let node_name_static = Box::leak(params.name.clone().into_boxed_str());
    let sovereign_node = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .flag("privileged")
        .arg("name", &params.name)
        .arg("volume", format!("{}:/mnt/da", da_dir.display()))
        .arg("volume", format!("{}:/mnt/state", state_dir.display()))
        .arg(
            "volume",
            format!("{}:/app/config/rollup.toml", rollup_config.display()),
        )
        .arg("publish", format!("{}:12346", params.port))
        .cmd(params.docker_image())
        .spawn(node_name_static, None);

    sleep(Duration::from_secs(10));

    log!(
        "Sovereign node '{}' started in Docker container",
        params.name,
    );

    sovereign_node
}

/// Setup the complete Sovereign testing environment using Docker
pub fn setup_sovereign_environment() -> (PathBuf, Vec<(AgentHandles, SovereignParameters)>) {
    log!(
        "Setting up Sovereign testing environment with {} nodes",
        SOVEREIGN_NODE_COUNT
    );

    let rollup_path = env::var(SOVEREIGN_ROLLUP_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("./sovereign-rollup"));
    let rollup_dir = clone_sovereign_rollup(rollup_path.clone());

    log!("Sovereign repository cloned to: {}", rollup_dir.display());

    // We modify the constants.toml per docker image so to avoid race conditions
    // we seqentially build the docker images and then start the containers
    for i in 0..SOVEREIGN_NODE_COUNT {
        let params = SovereignParameters::for_index(i);
        log!("Building Docker image for {}", params.name);
        let _ = build_sovereign_node_docker_with_constants(&rollup_dir, &params);
    }

    let mut agents = Vec::with_capacity(SOVEREIGN_NODE_COUNT);
    for i in 0..SOVEREIGN_NODE_COUNT {
        let params = SovereignParameters::for_index(i);
        let agent = start_sovereign_node_docker(params.clone(), rollup_path.clone()).join();
        agents.push((agent, params));
    }

    log!(
        "Sovereign testing environment setup complete with {} nodes",
        SOVEREIGN_NODE_COUNT
    );

    (rollup_dir, agents)
}

pub fn check_sovereign_node_health(rpc_url: &str) -> bool {
    log!("Checking health of Sovereign node at {}", rpc_url);

    let health_url = format!("{}/healthcheck", rpc_url);
    let result = std::process::Command::new("curl")
        .args(["-s", "-f", "-S", "--max-time", "5", &health_url])
        .output();

    match result {
        Ok(output) if output.status.success() => {
            log!("Sovereign node at {} is healthy", rpc_url);
            true
        }
        _ => {
            log!(
                "Sovereign node at {} is not responding to healthcheck",
                rpc_url
            );
            false
        }
    }
}
