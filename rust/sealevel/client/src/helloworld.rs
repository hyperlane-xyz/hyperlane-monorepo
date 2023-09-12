use std::collections::HashMap;

use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_hello_world::{
    accounts::HelloWorldStorageAccount,
    instruction::{
        enroll_remote_routers_instruction, init_instruction,
        set_interchain_security_module_instruction,
    },
    program_storage_pda_seeds,
};
use serde::{Deserialize, Serialize};
use solana_sdk::{instruction::Instruction, pubkey::Pubkey, signature::Signer};

use crate::{
    cmd_utils::account_exists,
    router::{
        deploy_routers, ChainMetadata, ConnectionClient, Deployable, RouterConfig,
        RouterConfigGetter,
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
}

impl Deployable<HelloWorldConfig> for HelloWorldDeployer {
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
        let (program_storage_account, _program_storage_bump) =
            Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);

        let account = client.get_account(&program_storage_account).unwrap();
        let storage = HelloWorldStorageAccount::fetch(&mut &account.data[..])
            .unwrap()
            .into_inner();

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

        println!("about to init...");

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

        println!(
            "Initializing HelloWorld program: domain_id: {}, mailbox: {}, ism: {:?}, owner: {:?}",
            domain_id, mailbox, ism, owner
        );

        ctx.new_txn()
            .add(
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

impl ConnectionClient for HelloWorldDeployer {
    fn get_interchain_security_module(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
    ) -> Option<Pubkey> {
        let (program_storage_account, _program_storage_bump) =
            Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);

        let account = client.get_account(&program_storage_account).unwrap();
        let storage = HelloWorldStorageAccount::fetch(&mut &account.data[..])
            .unwrap()
            .into_inner();

        storage.ism
    }

    fn set_interchain_security_module_instruction(
        &self,
        client: &RpcClient,
        program_id: &Pubkey,
        ism: Option<Pubkey>,
    ) -> Instruction {
        let program_storage_key =
            Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
        let account = client.get_account(&program_storage_key.0).unwrap();
        let storage = HelloWorldStorageAccount::fetch(&mut &account.data[..])
            .unwrap()
            .into_inner();

        set_interchain_security_module_instruction(*program_id, storage.owner.unwrap(), ism)
            .unwrap()
    }
}

fn deploy_helloworld(ctx: &mut Context, deploy: HelloWorldDeploy) {
    deploy_routers(
        ctx,
        HelloWorldDeployer::new(),
        "helloworld",
        &deploy.context,
        deploy.config_file,
        deploy.chain_config_file,
        deploy.environments_dir,
        &deploy.environment,
        deploy.built_so_dir,
    )
}
