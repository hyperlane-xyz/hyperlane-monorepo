use std::collections::HashMap;

use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_interchain_accounts::{
    accounts::{InterchainAccountStorage, InterchainAccountStorageAccount},
    instruction::{
        enroll_remote_routers_instruction, init_instruction,
        set_interchain_security_module_instruction,
    },
    program_storage_pda_seeds,
};
use serde::{Deserialize, Serialize};
use solana_sdk::{instruction::Instruction, pubkey::Pubkey};

use crate::{
    cmd_utils::account_exists,
    router::{
        deploy_routers, ChainMetadata, ConnectionClient, Ownable, RouterConfig, RouterConfigGetter,
        RouterDeployer,
    },
    Context, CoreProgramIds, InterchainAccountCmd, InterchainAccountDeploy,
    InterchainAccountSubCmd, RpcClient,
};

pub(crate) fn process_interchain_account_cmd(mut ctx: Context, cmd: InterchainAccountCmd) {
    match cmd.cmd {
        InterchainAccountSubCmd::Deploy(deploy) => {
            deploy_interchain_account(&mut ctx, deploy);
        }
        InterchainAccountSubCmd::Query(query) => {
            let program_storage_key =
                Pubkey::find_program_address(program_storage_pda_seeds!(), &query.program_id);
            let account = ctx.client.get_account(&program_storage_key.0).unwrap();
            let storage = InterchainAccountStorageAccount::fetch(&mut &account.data[..])
                .unwrap()
                .into_inner();
            println!("InterchainAccount storage: {:?}", storage);
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct InterchainAccountConfig {
    #[serde(flatten)]
    router_config: RouterConfig,
}

struct InterchainAccountDeployer {}

impl InterchainAccountDeployer {
    fn new() -> Self {
        Self {}
    }

    fn get_storage(&self, client: &RpcClient, program_id: &Pubkey) -> InterchainAccountStorage {
        let (program_storage_account, _program_storage_bump) =
            Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);

        let account = client.get_account(&program_storage_account).unwrap();
        *InterchainAccountStorageAccount::fetch(&mut &account.data[..])
            .unwrap()
            .into_inner()
    }
}

impl RouterDeployer<InterchainAccountConfig> for InterchainAccountDeployer {
    fn program_name(&self, _config: &InterchainAccountConfig) -> &str {
        "hyperlane_sealevel_interchain_accounts"
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
        app_config: &InterchainAccountConfig,
        program_id: Pubkey,
    ) {
        let (program_storage_account, _program_storage_bump) =
            Pubkey::find_program_address(program_storage_pda_seeds!(), &program_id);
        if account_exists(client, &program_storage_account).unwrap() {
            println!("InterchainAccount storage already exists, skipping init");
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

        // Default to the Overhead IGP
        let interchain_gas_paymaster = Some(
            app_config
                .router_config()
                .connection_client
                .interchain_gas_paymaster_config(client)
                .unwrap_or((
                    core_program_ids.igp_program_id,
                    InterchainGasPaymasterType::OverheadIgp(core_program_ids.overhead_igp_account),
                )),
        );

        ctx.new_txn()
            .add_with_description(
                init_instruction(
                    program_id,
                    ctx.payer_pubkey,
                    domain_id,
                    mailbox,
                    ism,
                    interchain_gas_paymaster.clone(),
                    owner,
                )
                .unwrap(),
                format!(
                    "Initializing InterchainAccount program: domain_id: {}, mailbox: {}, ism: {:?}, igp {:?}, owner: {:?}",
            domain_id, mailbox, ism, interchain_gas_paymaster, owner
                )
            )
            .with_client(client)
            .send_with_payer();
    }
}

impl RouterConfigGetter for InterchainAccountConfig {
    fn router_config(&self) -> &RouterConfig {
        &self.router_config
    }
}

impl Ownable for InterchainAccountDeployer {
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
        unimplemented!("InterchainAccount does not support changing the owner")
    }
}

impl ConnectionClient for InterchainAccountDeployer {
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
        // There is no way to set the IGP on InterchainAccount
        // TODO: do I need to implement this?
        None
    }
}

fn deploy_interchain_account(ctx: &mut Context, deploy: InterchainAccountDeploy) {
    deploy_routers(
        ctx,
        InterchainAccountDeployer::new(),
        "InterchainAccount",
        &deploy.context,
        deploy.config_file,
        deploy.chain_config_file,
        deploy.env_args.environments_dir,
        &deploy.env_args.environment,
        deploy.built_so_dir,
    )
}
