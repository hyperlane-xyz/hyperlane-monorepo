use std::path::Path;

use solana_program::pubkey::Pubkey;

use crate::{
    artifacts::{write_json, SingularProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    registry::FileSystemRegistry,
    Context, TrustedRelayerIsmCmd, TrustedRelayerIsmSubCmd,
};

use hyperlane_sealevel_trusted_relayer_ism::{
    accounts::StorageAccount,
    instruction::{init_instruction, set_relayer_instruction, transfer_ownership_instruction},
    storage_pda_seeds,
};

pub(crate) fn process_trusted_relayer_ism_cmd(mut ctx: Context, cmd: TrustedRelayerIsmCmd) {
    match cmd.cmd {
        TrustedRelayerIsmSubCmd::Deploy(deploy) => {
            let environments_dir = create_new_directory(
                &deploy.env_args.environments_dir,
                &deploy.env_args.environment,
            );
            let ism_dir = create_new_directory(&environments_dir, "trusted-relayer-ism");
            let chain_dir = create_new_directory(&ism_dir, &deploy.chain);
            let context_dir = create_new_directory(&chain_dir, &deploy.context);
            let key_dir = create_new_directory(&context_dir, "keys");

            let registry = FileSystemRegistry::new(deploy.registry.to_path_buf());
            let chain_metadatas = registry.get_metadata();
            let chain_metadata = chain_metadatas.get(&deploy.chain).unwrap();
            let local_domain = chain_metadata.domain_id;

            let program_id = deploy_trusted_relayer_ism(
                &mut ctx,
                &deploy.built_so_dir,
                &key_dir,
                local_domain,
                deploy.relayer,
            );

            write_json::<SingularProgramIdArtifact>(
                &context_dir.join("program-ids.json"),
                program_id.into(),
            );
        }
        TrustedRelayerIsmSubCmd::Init(init) => {
            let instruction =
                init_instruction(init.program_id, ctx.payer_pubkey, init.relayer).unwrap();
            ctx.new_txn().add(instruction).send_with_payer();
        }
        TrustedRelayerIsmSubCmd::SetRelayer(set_relayer) => {
            let instruction = set_relayer_instruction(
                set_relayer.program_id,
                ctx.payer_pubkey,
                set_relayer.relayer,
            )
            .unwrap();
            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!("Set trusted relayer to {}", set_relayer.relayer),
                )
                .send_with_payer();
        }
        TrustedRelayerIsmSubCmd::Query(query) => {
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
        TrustedRelayerIsmSubCmd::TransferOwnership(transfer) => {
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

pub(crate) fn deploy_trusted_relayer_ism(
    ctx: &mut Context,
    built_so_dir: &Path,
    key_dir: &Path,
    local_domain: u32,
    relayer: Pubkey,
) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_trusted_relayer_ism",
        built_so_dir
            .join("hyperlane_sealevel_trusted_relayer_ism.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        local_domain,
    )
    .unwrap();

    println!("Deployed Trusted Relayer ISM at program ID {}", program_id);

    let instruction = init_instruction(program_id, ctx.payer_pubkey, relayer).unwrap();
    ctx.new_txn()
        .add_with_description(
            instruction,
            format!(
                "Initializing Trusted Relayer ISM with payer/owner {} and relayer {}",
                ctx.payer_pubkey, relayer
            ),
        )
        .send_with_payer();
    println!(
        "Initialized Trusted Relayer ISM at program ID {}",
        program_id
    );

    program_id
}
