use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use macro_rules_attribute::apply;

use crate::config::Config;
use crate::logging::log;
use crate::program::Program;
use crate::utils::{as_task, AgentHandles, TaskHandle};
use crate::{INFRA_PATH, MONOREPO_ROOT_PATH};

#[apply(as_task)]
pub fn start_anvil(config: Arc<Config>) -> AgentHandles {
    log!("Installing typescript dependencies...");
    let yarn_monorepo = Program::new("yarn").working_dir(MONOREPO_ROOT_PATH);
    yarn_monorepo.clone().cmd("install").run().join();
    if !config.is_ci_env {
        // don't need to clean in the CI
        yarn_monorepo.clone().cmd("clean").run().join();
    }
    yarn_monorepo.clone().cmd("build").run().join();

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
    let anvil = anvil_args.spawn("ETH");

    sleep(Duration::from_secs(10));

    let yarn_infra = Program::new("yarn").working_dir(INFRA_PATH);

    log!("Deploying hyperlane ism contracts...");
    yarn_infra.clone().cmd("deploy-ism").run().join();

    log!("Deploying hyperlane core contracts...");
    yarn_infra.clone().cmd("deploy-core").run().join();

    anvil
}
