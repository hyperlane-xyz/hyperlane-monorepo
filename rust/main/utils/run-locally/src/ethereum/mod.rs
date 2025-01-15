use std::str::FromStr;
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
use crate::utils::{as_task, AgentHandles, TaskHandle};
use crate::{INFRA_PATH, MONOREPO_ROOT_PATH};

mod multicall;

#[apply(as_task)]
pub fn start_anvil(config: Arc<Config>) -> AgentHandles {
    log!("Installing typescript dependencies...");
    let yarn_monorepo = Program::new("yarn").working_dir(MONOREPO_ROOT_PATH);
    if !config.is_ci_env {
        // test.yaml workflow installs dependencies
        yarn_monorepo.clone().cmd("install").run().join();
        // don't need to clean in the CI
        yarn_monorepo.clone().cmd("clean").run().join();
        // test.yaml workflow builds the monorepo
        yarn_monorepo.clone().cmd("build").run().join();
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

    let yarn_infra = Program::new("yarn").working_dir(INFRA_PATH);

    log!("Deploying hyperlane ism contracts...");
    yarn_infra.clone().cmd("deploy-ism").run().join();

    log!("Deploying hyperlane core contracts...");
    yarn_infra.clone().cmd("deploy-core").run().join();

    log!("Updating agent config...");
    yarn_infra
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

pub async fn simulate_reorg() {
    let merkle_tree_hook_address =
        H160::from_str("0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E").unwrap();
    let slot = U256::from(103);
    let value =
        H256::from_str("0x0000000000000000000000000000000000000000000000000000000000000001")
            .unwrap();

    let anvil_rpc_url = "http://127.0.0.1:8545";
    let provider = Provider::<Http>::try_from(anvil_rpc_url)
        .unwrap()
        .interval(Duration::from_millis(50u64));

    // let start_slot = 0;
    // let end_slot = 120;
    // for slot in start_slot..end_slot {
    //     match provider
    //         .request::<(H160, U256, &str), H256>(
    //             "eth_getStorageAt",
    //             (merkle_tree_hook_address, U256::from(slot), "latest"),
    //         )
    //         .await
    //     {
    //         Ok(value) => println!("Slot {}: {}", slot, value),
    //         Err(e) => log!("Error fetching slot {}: {}", slot, e),
    //     }
    // }

    // get current storage value
    let current_value = provider
        .request::<(H160, U256, &str), H256>(
            "eth_getStorageAt",
            (merkle_tree_hook_address, slot, "latest"),
        )
        .await
        .unwrap();
    log!("Current storage value: {}", current_value);
    // // panic here
    // panic!("Current storage value");

    let result = provider
        .request::<(H160, U256, H256), bool>(
            "anvil_setStorageAt",
            (merkle_tree_hook_address, slot, value),
        )
        .await
        .unwrap();
    println!(
        "Successfully set storage at slot {} to value {} = {:?}",
        slot, value, result
    );
    // get new storage value
    let new_value = provider
        .request::<(H160, U256, &str), H256>(
            "eth_getStorageAt",
            (merkle_tree_hook_address, slot, "latest"),
        )
        .await
        .unwrap();
    println!("New storage value: {}", new_value);
}
