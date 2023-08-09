use std::{collections::HashMap, path::Path};

use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use serde::{Deserialize, Serialize};
use solana_sdk::{instruction::Instruction, pubkey::Pubkey};

use crate::{
    router::{deploy_routers, ChainMetadata, Deployable, RouterConfig, RouterConfigGetter},
    Context, CoreProgramIds, HelloWorldCmd, HelloWorldDeploy, HelloWorldSubCmd, RpcClient,
};

pub(crate) fn process_helloworld_cmd(mut ctx: Context, cmd: HelloWorldCmd) {
    match cmd.cmd {
        HelloWorldSubCmd::Deploy(deploy) => {
            deploy_helloworld(&mut ctx, deploy);
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct HelloWorldConfig {
    #[serde(flatten)]
    router_config: RouterConfig,
}

struct HelloWorldDeployer {}

impl Deployable<HelloWorldConfig> for HelloWorldDeployer {
    fn program_name(&self, _config: &HelloWorldConfig) -> &str {
        "hyperlane_sealevel_hello_world"
    }

    fn enroll_remote_routers_instruction(
        &self,
        _program_id: Pubkey,
        _payer: Pubkey,
        _router_configs: Vec<RemoteRouterConfig>,
    ) -> Instruction {
        // ...
        todo!()
    }

    fn get_routers(&self, _rpc_client: &RpcClient, _program_id: &Pubkey) -> HashMap<u32, H256> {
        // ...
        todo!()
    }

    fn init_program_idempotent(
        &self,
        _ctx: &mut Context,
        _client: &RpcClient,
        _core_program_ids: &CoreProgramIds,
        _chain_config: &ChainMetadata,
        _app_config: &HelloWorldConfig,
        _program_id: Pubkey,
    ) {
        // ...
        todo!()
    }
}

impl RouterConfigGetter for HelloWorldConfig {
    fn router_config(&self) -> &RouterConfig {
        &self.router_config
    }
}

fn deploy_helloworld(ctx: &mut Context, deploy: HelloWorldDeploy) {
    deploy_routers(
        ctx,
        HelloWorldDeployer {},
        "helloworld",
        "helloworld",
        deploy.config_file,
        deploy.chain_config_file,
        deploy.environments_dir,
        &deploy.environment,
        deploy.built_so_dir,
    )
}
