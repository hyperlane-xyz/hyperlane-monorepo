use std::path::Path;

use solana_program::pubkey::Pubkey;

use crate::{
    artifacts::{write_json, SingularProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    registry::FileSystemRegistry,
    AmountRoutingIsmCmd, AmountRoutingIsmSubCmd, Context,
};

use hyperlane_sealevel_amount_routing_ism::{
    accounts::StorageAccount,
    instruction::{
        init_instruction, set_config_instruction, transfer_ownership_instruction, ConfigData,
    },
    storage_pda_seeds,
};

pub(crate) fn process_amount_routing_ism_cmd(mut ctx: Context, cmd: AmountRoutingIsmCmd) {
    match cmd.cmd {
        AmountRoutingIsmSubCmd::Deploy(deploy) => {
            let environments_dir = create_new_directory(
                &deploy.env_args.environments_dir,
                &deploy.env_args.environment,
            );
            let ism_dir = create_new_directory(&environments_dir, "amount-routing-ism");
            let chain_dir = create_new_directory(&ism_dir, &deploy.chain);
            let context_dir = create_new_directory(&chain_dir, &deploy.context);
            let key_dir = create_new_directory(&context_dir, "keys");

            let registry = FileSystemRegistry::new(deploy.registry.to_path_buf());
            let chain_metadatas = registry.get_metadata();
            let chain_metadata = chain_metadatas.get(&deploy.chain).unwrap();
            let local_domain = chain_metadata.domain_id;

            let config = ConfigData {
                threshold: deploy.threshold,
                lower_ism: deploy.lower_ism,
                upper_ism: deploy.upper_ism,
            };

            let program_id = deploy_amount_routing_ism(
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
        AmountRoutingIsmSubCmd::Init(init) => {
            let config = ConfigData {
                threshold: init.threshold,
                lower_ism: init.lower_ism,
                upper_ism: init.upper_ism,
            };
            let instruction = init_instruction(init.program_id, ctx.payer_pubkey, config).unwrap();
            ctx.new_txn().add(instruction).send_with_payer();
        }
        AmountRoutingIsmSubCmd::SetConfig(set_config) => {
            let config = ConfigData {
                threshold: set_config.threshold,
                lower_ism: set_config.lower_ism,
                upper_ism: set_config.upper_ism,
            };
            let instruction =
                set_config_instruction(set_config.program_id, ctx.payer_pubkey, config).unwrap();
            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!(
                        "Set amount routing ISM config: threshold={}, lower_ism={}, upper_ism={}",
                        set_config.threshold, set_config.lower_ism, set_config.upper_ism
                    ),
                )
                .send_with_payer();
        }
        AmountRoutingIsmSubCmd::Query(query) => {
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
        AmountRoutingIsmSubCmd::TransferOwnership(transfer) => {
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

pub(crate) fn deploy_amount_routing_ism(
    ctx: &mut Context,
    built_so_dir: &Path,
    key_dir: &Path,
    local_domain: u32,
    config: ConfigData,
) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_amount_routing_ism",
        built_so_dir
            .join("hyperlane_sealevel_amount_routing_ism.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        local_domain,
    )
    .unwrap();

    println!("Deployed Amount Routing ISM at program ID {}", program_id);

    let instruction = init_instruction(program_id, ctx.payer_pubkey, config.clone()).unwrap();
    ctx.new_txn()
        .add_with_description(
            instruction,
            format!(
                "Initializing Amount Routing ISM with payer/owner {}, threshold={}, lower_ism={}, upper_ism={}",
                ctx.payer_pubkey, config.threshold, config.lower_ism, config.upper_ism
            ),
        )
        .send_with_payer();
    println!(
        "Initialized Amount Routing ISM at program ID {}",
        program_id
    );

    program_id
}
