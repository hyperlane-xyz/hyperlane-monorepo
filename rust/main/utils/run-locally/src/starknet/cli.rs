use std::path::PathBuf;

use crate::{program::Program, utils::TaskHandle};

use super::types::DeclareResponse;

#[derive(Default, Clone)]
pub struct StarknetCLI {
    pub bin: PathBuf,
    rpc_addr: String,
    key: String,
    account: String,
}

#[allow(dead_code)]
impl StarknetCLI {
    pub fn new(bin: PathBuf) -> Self {
        Self {
            bin,
            ..Default::default()
        }
    }

    fn cli(&self) -> Program {
        Program::new(self.bin.clone()).working_dir("../../")
    }

    pub fn init(&mut self, key: String, account_address: String, rpc_addr: String, index: u32) {
        self.key = key;
        self.rpc_addr = rpc_addr;

        // fetch the account from the address
        self.account = self
            .bin
            .parent()
            .unwrap()
            .join(format!("account_{index}.json"))
            .to_string_lossy()
            .to_string();

        self.cli()
            .cmd("account")
            .cmd("fetch")
            .cmd(account_address)
            .arg("output", &self.account)
            .arg("rpc", &self.rpc_addr)
            .run()
            .join();
    }

    pub fn declare(&self, sierra_path: PathBuf) -> DeclareResponse {
        let run_result = self
            .cli()
            .cmd("declare")
            .cmd(sierra_path.to_str().unwrap())
            .arg("account", &self.account)
            .arg("private-key", &self.key)
            .arg("rpc", &self.rpc_addr)
            .run_with_output()
            .join();

        println!("declare result: {:?}", run_result);

        DeclareResponse {
            class_hash: run_result.first().unwrap().to_string(),
        }
    }

    pub fn deploy(&self, class_hash: String, constructor_args: Vec<String>) -> String {
        let run_result = self
            .cli()
            .cmd("deploy")
            .cmd(class_hash)
            .cmds(constructor_args)
            .arg("account", &self.account)
            .arg("private-key", &self.key)
            .arg("rpc", &self.rpc_addr)
            .arg("salt", "1".to_string()) // Always use salt 1, this makes the deploy deterministic
            .run_with_output()
            .join();

        println!("deploy result: {:?}", run_result);

        run_result.first().unwrap().to_string()
    }

    pub fn invoke(&self, address: String, function_name: &str, constructor_args: Vec<String>) {
        let (success, run_result) = self
            .cli()
            .cmd("invoke")
            .cmd(address)
            .cmd(function_name)
            .cmds(constructor_args)
            .arg("account", &self.account)
            .arg("private-key", &self.key)
            .arg("rpc", &self.rpc_addr)
            .run_with_status_and_output()
            .join();

        assert!(success, "Starknet invoke failed");
        println!("invoke result: {:?}", run_result);
    }

    pub fn send_tx(&self, contract_address: String, function_name: String, args: Vec<String>) {
        let (success, run_result) = self
            .cli()
            .cmd("invoke")
            .cmd(contract_address)
            .cmd(function_name)
            .cmds(args)
            .arg("account", &self.account)
            .arg("private-key", &self.key)
            .arg("rpc", &self.rpc_addr)
            .run_with_status_and_output()
            .join();

        assert!(success, "Starknet send transaction failed");
        println!("send-tx result: {:?}", run_result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn assert_cli_status(exit_code: u8) {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("fixture-starkli");
        std::fs::write(
            &executable,
            format!(
                "#!/bin/sh\nif [ \"$1\" = account ]; then exit 0; fi\nprintf 'fixture-output\\n'\nexit {exit_code}\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut cli = StarknetCLI::new(executable);
        cli.init(
            "public-fixture-key".to_owned(),
            "public-fixture-account".to_owned(),
            "http://127.0.0.1:1".to_owned(),
            0,
        );
        let invoke = catch_unwind(AssertUnwindSafe(|| {
            cli.invoke("0x1".to_owned(), "fixture", Vec::new());
        }));
        let send = catch_unwind(AssertUnwindSafe(|| {
            cli.send_tx("0x1".to_owned(), "fixture".to_owned(), Vec::new());
        }));
        assert_eq!(invoke.is_ok(), exit_code == 0);
        assert_eq!(send.is_ok(), exit_code == 0);
    }

    #[test]
    fn invoke_and_send_tx_reject_failed_cli_status() {
        assert_cli_status(7);
    }

    #[test]
    fn invoke_and_send_tx_accept_successful_cli_status() {
        assert_cli_status(0);
    }
}
