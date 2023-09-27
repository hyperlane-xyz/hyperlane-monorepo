use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::Duration;

use crate::logging::log;
use crate::program::Program;
use crate::utils::{as_task, concat_path, AgentHandles, ArbitraryData, TaskHandle};
use macro_rules_attribute::apply;

use tempfile::{tempdir, NamedTempFile};

#[apply(as_task)]
pub fn install_aptos_cli() {
    log!("Installing Aptos CLI");
    // aptos node run-local-testnet --with-faucet --faucet-port 8081 --force-restart --assume-yes
    let aptos_cli_dir = tempdir().unwrap();
    Program::new("curl")
        .flag("location")
        .flag("silent")
        .arg("output", "install_aptos_cli.py")
        .working_dir(aptos_cli_dir.as_ref().to_str().unwrap())
        .cmd(format!("https://aptos.dev/scripts/install_cli.py"))
        .run()
        .join();
    Program::new("python3")
        .working_dir(aptos_cli_dir.as_ref().to_str().unwrap())
        .cmd(format!("install_aptos_cli.py"))
        .run()
        .join();
}

#[apply(as_task)]
pub fn start_aptos_local_testnet() -> AgentHandles {
    log!("Running Aptos Local Testnet");
    // aptos node run-local-testnet --with-faucet --faucet-port 8081 --force-restart --assume-yes
    let local_net_program = Program::new("/root/.local/bin/aptos")
        .cmd("node")
        .cmd("run-local-testnet")
        .flag("with-faucet")
        .arg("faucet-port", "8081")
        .flag("force-restart")
        .flag("assume-yes")
        .spawn("APTOS-NODE");

    // wait for faucet to get started.
    sleep(Duration::from_secs(20));

    Program::new("bash")
        .working_dir("../move/e2e/")
        .cmd("compile-and-deploy.sh")
        .run()
        .join();

    local_net_program
}

#[apply(as_task)]
pub fn start_aptos_deploying() {
    Program::new("bash")
        .working_dir("../move/e2e/")
        .cmd("compile-and-deploy.sh")
        .run()
        .join();
}

#[apply(as_task)]
pub fn init_aptos_modules_state() {
    Program::new("bash")
        .working_dir("../move/e2e/")
        .cmd("init_states.sh")
        .cmd("init_ln1_modules")
        .run()
        .join();
    Program::new("bash")
        .working_dir("../move/e2e/")
        .cmd("init_states.sh")
        .cmd("init_ln2_modules")
        .run()
        .join();
}

#[apply(as_task)]
pub fn aptos_send_messages() {
    Program::new("bash")
        .working_dir("../move/e2e/")
        .cmd("init_states.sh")
        .cmd("send_hello_ln1_to_ln2")
        .run()
        .join();
    Program::new("bash")
        .working_dir("../move/e2e/")
        .cmd("init_states.sh")
        .cmd("send_hello_ln2_to_ln1")
        .run()
        .join();
}
