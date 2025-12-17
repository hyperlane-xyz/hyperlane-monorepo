use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use ethers::providers::{Http, Provider};
use ethers::types::{H160, H256, U256};
use macro_rules_attribute::apply;

use crate::config::Config;
use crate::ethereum::multicall::{DEPLOYER_ADDRESS, SIGNED_DEPLOY_MULTICALL_TX};
use crate::logging::log;
use crate::program::Program;
use crate::utils::{as_task, get_ts_infra_path, get_workspace_path, AgentHandles, TaskHandle};

pub mod ethereum_termination_invariants;
mod multicall;

#[apply(as_task)]
pub fn start_anvil(config: Arc<Config>) -> AgentHandles {
    log!("Installing typescript dependencies...");

    let workspace_path = get_workspace_path();
    let ts_infra_path = get_ts_infra_path();

    let pnpm_monorepo = Program::new("pnpm").working_dir(workspace_path);
    if !config.is_ci_env {
        // test.yaml workflow installs dependencies
        pnpm_monorepo.clone().cmd("install").run().join();
        // don't need to clean in the CI
        pnpm_monorepo.clone().cmd("clean").run().join();
        // test.yaml workflow builds the monorepo
        pnpm_monorepo.clone().cmd("build").run().join();
    }

    if !config.is_ci_env {
        // Kill any existing anvil processes just in case since it seems to have issues getting cleaned up
        Program::new("pkill")
            .raw_arg("-SIGKILL")
            .cmd("anvil")
            .run_ignore_code()
            .join();
    }
    log!("Launching anvil...");
    let anvil_args = Program::new("anvil").flag("silent").filter_logs(|_| false); // for now do not keep any of the anvil logs
    let anvil = anvil_args.spawn("ETH", None);

    sleep(Duration::from_secs(10));

    let pnpm_infra = Program::new("pnpm").working_dir(&ts_infra_path);

    log!("Deploying hyperlane ism contracts...");
    pnpm_infra.clone().cmd("deploy-ism").run().join();

    log!("Deploying hyperlane core contracts...");
    pnpm_infra.clone().cmd("deploy-core").run().join();

    log!("Updating agent config...");
    pnpm_infra
        .clone()
        .cmd("update-agent-config:test")
        .run()
        .join();

    log!("Deploying multicall contract...");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(deploy_multicall());

    anvil
}

pub async fn deploy_multicall() {
    let anvil_rpc_url = "http://127.0.0.1:8545";
    let provider = Provider::<Http>::try_from(anvil_rpc_url)
        .unwrap()
        .interval(Duration::from_millis(50u64));

    // fund the deployer address
    provider
        .request::<(H160, U256), ()>(
            "anvil_setBalance",
            (DEPLOYER_ADDRESS, U256::from(1_000_000_000_000_000_000u64)),
        )
        .await
        .unwrap();

    // deploy multicall
    provider
        .request::<[serde_json::Value; 1], H256>(
            "eth_sendRawTransaction",
            [SIGNED_DEPLOY_MULTICALL_TX.into()],
        )
        .await
        .unwrap();
    log!("Successfully deployed multicall contract...");
}
