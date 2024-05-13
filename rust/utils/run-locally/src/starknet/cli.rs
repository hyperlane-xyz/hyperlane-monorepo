use std::path::PathBuf;

use crate::{program::Program, utils::TaskHandle};

use super::types::DeclareResponse;

#[derive(Default, Clone)]
pub struct StarknetCLI {
    pub bin: PathBuf,
    rpc_addr: String,
    keystore_path: String,
    keystore_password: String,
    account_path: String,
    chain_id: String,
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
        Program::new(self.bin.clone())
    }

    pub fn init(
        &mut self,
        keystore_path: String,
        account_path: String,
        keystore_password: String,
        rpc_addr: String,
        chain_id: String,
    ) {
        self.account_path = account_path;
        self.keystore_path = keystore_path;
        self.keystore_password = keystore_password;
        self.rpc_addr = rpc_addr;
        self.chain_id = chain_id;
    }

    pub fn declare(&self, sierra_path: PathBuf) -> DeclareResponse {
        let run_result = self
            .cli()
            .cmd("declare")
            .cmd(sierra_path.to_str().unwrap())
            .arg("keystore", self.keystore_path.clone())
            .arg("account", self.account_path.clone())
            .arg("rpc-url", self.rpc_addr.clone())
            .arg("chain-id", self.chain_id.clone())
            .run_with_output()
            .join();

        println!("declare result: {:?}", run_result);

        let output: Result<DeclareResponse, serde_json::Error> =
            serde_json::from_str(run_result.first().unwrap());

        output.unwrap()
    }

    pub fn deploy(&self, class_hash: String, constructor_args: Vec<String>) -> String {
        let run_result = self
            .cli()
            .cmd("deploy")
            .cmd(class_hash)
            .cmds(constructor_args)
            .arg("keystore", self.keystore_path.clone())
            .arg("account", self.account_path.clone())
            .arg("rpc-url", self.rpc_addr.clone())
            .arg("chain-id", self.chain_id.clone())
            .run_with_output()
            .join();

        println!("deploy result: {:?}", run_result);

        run_result.first().unwrap().to_string()
    }

    pub fn send_tx(&self, contract_address: String, function_name: String, args: Vec<String>) {
        let run_result = self
            .cli()
            .cmd("invoke")
            .cmd(contract_address)
            .cmd(function_name)
            .cmds(args)
            .arg("keystore", self.keystore_path.clone())
            .arg("account", self.account_path.clone())
            .arg("rpc-url", self.rpc_addr.clone())
            .arg("chain-id", self.chain_id.clone())
            .run_with_output()
            .join();

        println!("send-tx result: {:?}", run_result);
    }
}
