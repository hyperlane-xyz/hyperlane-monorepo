use std::collections::HashMap;

use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_hello_world::{
    accounts::{HelloWorldStorage, HelloWorldStorageAccount},
    instruction::{
        enroll_remote_routers_instruction, init_instruction,
        set_interchain_security_module_instruction,
    },
    program_storage_pda_seeds,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use serde::{Deserialize, Serialize};
use solana_sdk::{instruction::Instruction, pubkey::Pubkey};

use crate::{
    cmd_utils::account_exists,
    registry::ChainMetadata,
    router::{
        deploy_routers, ConnectionClient, Ownable, RouterConfig, RouterConfigGetter, RouterDeployer,
    },
    Context, CoreProgramIds, HelloWorldCmd, HelloWorldDeploy, HelloWorldSubCmd, RpcClient,
};

pub(crate) fn process_helloworld_cmd(mut ctx: Context, cmd: HelloWorldCmd) {
    match cmd.cmd {
        HelloWorldSubCmd::Deploy(deploy) => {
            deploy_helloworld(&mut ctx, deploy);
        }
        HelloWorldSubCmd::Query(query) => {
            let program_storage_key =
                Pubkey::find_program_address(program_storage_pda_seeds!(), &query.program_id);
            let account = ctx.client.get_account(&program_storage_key.0).unwrap();
            let storage = HelloWorldStorageAccount::fetch(&mut &account.data[..])
                .unwrap()
                .into_inner();
            println!("HelloWorld storage: {:?}", storage);
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct HelloWorldConfig {
    #[serde(flatten)]
    router_config: RouterConfig,
}

struct HelloWorldDeployer {}

impl HelloWorldDeployer {
    fn new() -> Self {
        Self {}
    }

    fn get_storage(&self, client: &RpcClient, program_id: &Pubkey) -> HelloWorldStorage {
        let (program_storage_account, _program_storage_bump) =
            Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);

        let account = client.get_account(&program_storage_account).unwrap();
        *HelloWorldStorageAccount::fetch(&mut &account.data[..])
            .unwrap()
            .into_inner()
    }
}

impl RouterDeployer<HelloWorldConfig> for HelloWorldDeployer {
    fn program_name(&self, _config: &HelloWorldConfig) -> &str {
        "hyperlane_sealevel_hello_world"
    }

    fn enroll_remote_routers_instruction(
        &self,
        program_id: Pubkey,
        payer: Pubkey,
        router_configs: Vec<RemoteRouterConfig>,
    ) -> Instruction {
        enroll_remote_routers_instruction(program_id, payer, router_configs).unwrap()
    }

    fn get_routers(&self, client: &RpcClient, program_id: &Pubkey) -> HashMap<u32, H256> {
        let storage = self.get_storage(client, program_id);

        storage.routers
    }

    fn init_program_idempotent(
        &self,
        ctx: &mut Context,
        client: &RpcClient,
        core_program_ids: &CoreProgramIds,
        chain_config: &ChainMetadata,
        app_config: &HelloWorldConfig,
        program_id: Pubkey,
    ) {
        let (program_storage_account, _program_storage_bump) =
            Pubkey::find_program_address(program_storage_pda_seeds!(), &program_id);
        if account_exists(client, &program_storage_account).unwrap() {
            println!("HelloWorld storage already exists, skipping init");
            return;
        }

        let domain_id = chain_config.domain_id();
        let mailbox = app_config
            .router_config()
            .connection_client
            .mailbox(core_program_ids.mailbox);
        let ism = app_config
            .router_config()
            .connection_client
            .interchain_security_module();
        let owner = Some(app_config.router_config().ownable.owner(ctx.payer_pubkey));

        ctx.new_txn()
            .add_with_description(
                init_instruction(
                    program_id,
                    ctx.payer_pubkey,
                    domain_id,
                    mailbox,
                    ism,
                    // TODO revisit this when we want to deploy with IGPs
                    None,
                    owner,
                )
                .unwrap(),
                format!(
                    "Initializing HelloWorld program: domain_id: {}, mailbox: {}, ism: {:?}, owner: {:?}",
            domain_id, mailbox, ism, owner
                )
            )
            .with_client(client)
            .send_with_payer();
    }
}

impl RouterConfigGetter for HelloWorldConfig {
    fn router_config(&self) -> &RouterConfig {
        &self.router_config
    }
}

impl Ownable for HelloWorldDeployer {
    /// Gets the owner configured on-chain.
    fn get_owner(&self, client: &RpcClient, program_id: &Pubkey) -> Option<Pubkey> {
        let storage = self.get_storage(client, program_id);

        storage.owner
    }

    /// Gets an instruction to set the owner.
    fn set_owner_instruction(
        &self,
        _client: &RpcClient,
        _program_id: &Pubkey,
        _new_owner: Option<Pubkey>,
    ) -> Instruction {
        unimplemented!("HelloWorld does not support changing the owner")
    }
}

impl ConnectionClient for HelloWorldDeployer {
    fn get_interchain_security_module(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
    ) -> Option<Pubkey> {
        let storage = self.get_storage(client, program_id);

        storage.ism
    }

    fn set_interchain_security_module_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        ism: Option<Pubkey>,
    ) -> Instruction {
        let storage = self.get_storage(client, program_id);

        set_interchain_security_module_instruction(*program_id, storage.owner.unwrap(), ism)
            .unwrap()
    }

    fn get_interchain_gas_paymaster(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
    ) -> Option<(Pubkey, InterchainGasPaymasterType)> {
        let storage = self.get_storage(client, program_id);

        storage.igp
    }

    fn set_interchain_gas_paymaster_instruction(
        &self,
        _client: &RpcClient,
        _program_id: &Pubkey,
        _igp_config: Option<(Pubkey, InterchainGasPaymasterType)>,
    ) -> Option<Instruction> {
        // There is no way to set the IGP on HelloWorld
        None
    }
}

fn deploy_helloworld(ctx: &mut Context, deploy: HelloWorldDeploy) {
    deploy_routers(
        ctx,
        HelloWorldDeployer::new(),
        "helloworld",
        &deploy.context,
        deploy.config_file,
        deploy.registry,
        deploy.env_args.environments_dir,
        &deploy.env_args.environment,
        deploy.built_so_dir,
    )
}
