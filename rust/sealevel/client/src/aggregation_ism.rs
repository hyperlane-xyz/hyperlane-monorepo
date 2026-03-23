use std::path::Path;

use solana_program::pubkey::Pubkey;

use crate::{
    artifacts::{write_json, SingularProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    registry::FileSystemRegistry,
    AggregationIsmCmd, AggregationIsmSubCmd, Context,
};

use hyperlane_sealevel_aggregation_ism::{
    accounts::StorageAccount,
    instruction::{
        init_instruction, set_config_instruction, transfer_ownership_instruction, InitConfig,
        SetConfigData,
    },
    storage_pda_seeds,
};

pub(crate) fn process_aggregation_ism_cmd(mut ctx: Context, cmd: AggregationIsmCmd) {
    match cmd.cmd {
        AggregationIsmSubCmd::Deploy(deploy) => {
            let environments_dir = create_new_directory(
                &deploy.env_args.environments_dir,
                &deploy.env_args.environment,
            );
            let ism_dir = create_new_directory(&environments_dir, "aggregation-ism");
            let chain_dir = create_new_directory(&ism_dir, &deploy.chain);
            let context_dir = create_new_directory(&chain_dir, &deploy.context);
            let key_dir = create_new_directory(&context_dir, "keys");

            let registry = FileSystemRegistry::new(deploy.registry.to_path_buf());
            let chain_metadatas = registry.get_metadata();
            let chain_metadata = chain_metadatas.get(&deploy.chain).unwrap();
            let local_domain = chain_metadata.domain_id;

            let config = InitConfig {
                threshold: deploy.threshold,
                modules: deploy.modules,
            };

            let program_id = deploy_aggregation_ism(
                &mut ctx,
                &deploy.built_so_dir,
                &key_dir,
                local_domain,
                config,
            );

            write_json::<SingularProgramIdArtifact>(
                &context_dir.join("program-ids.json"),
                program_id.into(),
            );
        }
        AggregationIsmSubCmd::Init(init) => {
            let config = InitConfig {
                threshold: init.threshold,
                modules: init.modules,
            };
            let instruction = init_instruction(init.program_id, ctx.payer_pubkey, config).unwrap();
            ctx.new_txn().add(instruction).send_with_payer();
        }
        AggregationIsmSubCmd::SetConfig(set_config) => {
            let description = format!(
                "Set aggregation ISM config: threshold={}, modules={:?}",
                set_config.threshold, set_config.modules
            );
            let config = SetConfigData {
                threshold: set_config.threshold,
                modules: set_config.modules,
            };
            let instruction =
                set_config_instruction(set_config.program_id, ctx.payer_pubkey, config).unwrap();
            ctx.new_txn()
                .add_with_description(instruction, description)
                .send_with_payer();
        }
        AggregationIsmSubCmd::Query(query) => {
            let (storage_pda_key, _) =
                Pubkey::find_program_address(storage_pda_seeds!(), &query.program_id);

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&[storage_pda_key], ctx.commitment)
                .unwrap()
                .value;

            if let Some(account) = &accounts[0] {
                let storage = StorageAccount::fetch(&mut &account.data[..])
                    .unwrap()
                    .into_inner();
                println!("Storage PDA: {}", storage_pda_key);
                println!("{:#?}", storage);
            } else {
                println!("Storage PDA not initialized");
            }
        }
        AggregationIsmSubCmd::TransferOwnership(transfer) => {
            let instruction = transfer_ownership_instruction(
                transfer.program_id,
                ctx.payer_pubkey,
                Some(transfer.new_owner),
            )
            .unwrap();
            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!("Transfer ownership to {:?}", transfer.new_owner),
                )
                .send_with_payer();
        }
    }
}

pub(crate) fn deploy_aggregation_ism(
    ctx: &mut Context,
    built_so_dir: &Path,
    key_dir: &Path,
    local_domain: u32,
    config: InitConfig,
) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_aggregation_ism",
        built_so_dir
            .join("hyperlane_sealevel_aggregation_ism.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        local_domain,
    )
    .unwrap();

    println!("Deployed Aggregation ISM at program ID {}", program_id);

    let instruction = init_instruction(program_id, ctx.payer_pubkey, config.clone()).unwrap();
    ctx.new_txn()
        .add_with_description(
            instruction,
            format!(
                "Initializing Aggregation ISM with payer/owner {}, threshold={}, modules={:?}",
                ctx.payer_pubkey, config.threshold, config.modules
            ),
        )
        .send_with_payer();
    println!("Initialized Aggregation ISM at program ID {}", program_id);

    program_id
}
