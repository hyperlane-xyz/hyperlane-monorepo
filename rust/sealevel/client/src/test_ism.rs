use std::path::Path;

use solana_program::pubkey::Pubkey;

use crate::{
    artifacts::{write_json, SingularProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    Context, TestIsmCmd, TestIsmSubCmd,
};

pub(crate) fn process_test_ism_cmd(mut ctx: Context, cmd: TestIsmCmd) {
    match cmd.cmd {
        TestIsmSubCmd::Deploy(deploy) => {
            let environments_dir = create_new_directory(
                &deploy.env_args.environments_dir,
                &deploy.env_args.environment,
            );
            let ism_dir = create_new_directory(&environments_dir, "test-ism");
            let chain_dir = create_new_directory(&ism_dir, &deploy.chain);
            let context_dir = create_new_directory(&chain_dir, &deploy.context);
            let key_dir = create_new_directory(&context_dir, "keys");

            let ism_program_id = deploy_test_ism(&mut ctx, &deploy.built_so_dir, &key_dir);

            write_json::<SingularProgramIdArtifact>(
                &context_dir.join("program-ids.json"),
                ism_program_id.into(),
            );
        }
        TestIsmSubCmd::Init(init) => {
            let init_instruction = hyperlane_sealevel_test_ism::program::TestIsmInstruction::Init;
            let encoded = borsh::BorshSerialize::try_to_vec(&init_instruction).unwrap();

            let instruction = solana_program::instruction::Instruction {
                program_id: init.program_id,
                accounts: vec![
                    solana_program::instruction::AccountMeta::new_readonly(
                        solana_program::system_program::id(),
                        false,
                    ),
                    solana_program::instruction::AccountMeta::new(ctx.payer_pubkey, true),
                    solana_program::instruction::AccountMeta::new(
                        Pubkey::find_program_address(
                            &[b"test_ism", b"-", b"storage"],
                            &init.program_id,
                        )
                        .0,
                        false,
                    ),
                ],
                data: encoded,
            };

            ctx.new_txn()
                .add_with_description(instruction, "Initialize Test ISM".to_string())
                .send_with_payer();
        }
        TestIsmSubCmd::SetAccept(set_accept) => {
            let instruction_data =
                hyperlane_sealevel_test_ism::program::TestIsmInstruction::SetAccept(
                    set_accept.accept,
                );
            let encoded = borsh::BorshSerialize::try_to_vec(&instruction_data).unwrap();

            let (storage_pda_key, _) = Pubkey::find_program_address(
                &[b"test_ism", b"-", b"storage"],
                &set_accept.program_id,
            );

            let instruction = solana_program::instruction::Instruction {
                program_id: set_accept.program_id,
                accounts: vec![solana_program::instruction::AccountMeta::new(
                    storage_pda_key,
                    false,
                )],
                data: encoded,
            };

            let description = format!(
                "Set Test ISM accept to {}",
                if set_accept.accept {
                    "true (accept all)"
                } else {
                    "false (reject all)"
                }
            );

            ctx.new_txn()
                .add_with_description(instruction, description)
                .send_with_payer();
        }
        TestIsmSubCmd::Query(query) => {
            let (storage_pda_key, _) =
                Pubkey::find_program_address(&[b"test_ism", b"-", b"storage"], &query.program_id);

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&[storage_pda_key], ctx.commitment)
                .unwrap()
                .value;

            if let Some(account) = &accounts[0] {
                use borsh::BorshDeserialize;
                let storage = hyperlane_sealevel_test_ism::program::TestIsmStorage::deserialize(
                    &mut &account.data[8..], // Skip AccountData discriminator
                )
                .unwrap();

                println!("Test ISM Storage:");
                println!(
                    "  Accept: {} ({})",
                    storage.accept,
                    if storage.accept {
                        "accepts all messages"
                    } else {
                        "rejects all messages"
                    }
                );
            } else {
                println!("Test ISM not initialized");
            }
        }
    }
}

pub(crate) fn deploy_test_ism(ctx: &mut Context, built_so_dir: &Path, key_dir: &Path) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_test_ism",
        built_so_dir
            .join("hyperlane_sealevel_test_ism.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        0, // No specific domain for test ISM
    )
    .unwrap();

    println!("Deployed Test ISM at program ID {}", program_id);

    // Initialize the Test ISM
    let init_instruction = hyperlane_sealevel_test_ism::program::TestIsmInstruction::Init;
    let encoded = borsh::BorshSerialize::try_to_vec(&init_instruction).unwrap();

    let (storage_pda_key, _) =
        Pubkey::find_program_address(&[b"test_ism", b"-", b"storage"], &program_id);

    let instruction = solana_program::instruction::Instruction {
        program_id,
        accounts: vec![
            solana_program::instruction::AccountMeta::new_readonly(
                solana_program::system_program::id(),
                false,
            ),
            solana_program::instruction::AccountMeta::new(ctx.payer_pubkey, true),
            solana_program::instruction::AccountMeta::new(storage_pda_key, false),
        ],
        data: encoded,
    };

    ctx.new_txn()
        .add_with_description(
            instruction,
            format!("Initializing Test ISM with payer {}", ctx.payer_pubkey),
        )
        .send_with_payer();

    println!("Initialized Test ISM at program ID {}", program_id);

    program_id
}
