//! Test ISM (Interchain Security Module) implementation for Solana
//! 
//! This module provides a simple ISM implementation designed for testing purposes.
//! The Test ISM can be configured to either accept or reject all messages,
//! making it useful for integration testing without requiring actual validation logic.
//! 
//! WARNING: This ISM is for testing only and should NEVER be deployed to production
//! as it has no access control and can be configured by anyone to accept all messages.

use std::path::Path;

use solana_program::pubkey::Pubkey;
use borsh::BorshSerialize;

use crate::{
    artifacts::{write_json, SingularProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    registry::FileSystemRegistry,
    Context, TestIsmCmd, TestIsmSubCmd,
};

/// Creates and sends the Test ISM initialization instruction.
/// This sets up the storage PDA for the Test ISM program.
fn initialize_test_ism(ctx: &mut Context, program_id: Pubkey, description: String) {
    let init_instruction = hyperlane_sealevel_test_ism::program::TestIsmInstruction::Init;
    let encoded = init_instruction
        .try_to_vec()
        .expect("Failed to serialize init instruction");
    
    let (storage_pda_key, _) = Pubkey::find_program_address(
        &[b"test_ism", b"-", b"storage"],
        &program_id,
    );
    
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
        .add_with_description(instruction, description)
        .send_with_payer();
}

/// Processes Test ISM commands including deploy, init, set accept/reject, and query operations
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

            // Load chain metadata to get the proper domain ID
            let registry = FileSystemRegistry::new(environments_dir.clone());
            let chain_metadata_map = registry.get_metadata();
            let chain_metadata = chain_metadata_map
                .get(&deploy.chain)
                .unwrap_or_else(|| panic!("Chain {} not found in registry", deploy.chain));
            
            let ism_program_id = deploy_test_ism(
                &mut ctx,
                &deploy.built_so_dir,
                &key_dir,
                chain_metadata.domain_id,
            );

            write_json::<SingularProgramIdArtifact>(
                &context_dir.join("program-ids.json"),
                ism_program_id.into(),
            );
        }
        TestIsmSubCmd::Init(init) => {
            initialize_test_ism(&mut ctx, init.program_id, "Initialize Test ISM".to_string());
        }
        TestIsmSubCmd::SetAccept(set_accept) => {
            let instruction_data = 
                hyperlane_sealevel_test_ism::program::TestIsmInstruction::SetAccept(set_accept.accept);
            let encoded = instruction_data
                .try_to_vec()
                .expect("Failed to serialize set accept instruction");
            
            let (storage_pda_key, _) = Pubkey::find_program_address(
                &[b"test_ism", b"-", b"storage"],
                &set_accept.program_id,
            );
            
            let instruction = solana_program::instruction::Instruction {
                program_id: set_accept.program_id,
                accounts: vec![
                    solana_program::instruction::AccountMeta::new(storage_pda_key, false),
                ],
                data: encoded,
            };
            
            let description = format!(
                "Set Test ISM accept to {}",
                if set_accept.accept { "true (accept all)" } else { "false (reject all)" }
            );
            
            ctx.new_txn()
                .add_with_description(instruction, description)
                .send_with_payer();
        }
        TestIsmSubCmd::Query(query) => {
            let (storage_pda_key, _) = Pubkey::find_program_address(
                &[b"test_ism", b"-", b"storage"],
                &query.program_id,
            );

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&[storage_pda_key], ctx.commitment)
                .unwrap()
                .value;
            
            if let Some(account) = &accounts[0] {
                use borsh::BorshDeserialize;
                
                // Ensure account data is large enough to contain discriminator and storage
                // The first 8 bytes are the Anchor/Borsh discriminator that identifies the account type
                if account.data.len() < 8 {
                    println!("Error: Account data too small (expected at least 8 bytes, got {})", account.data.len());
                    return;
                }
                
                let storage = match hyperlane_sealevel_test_ism::program::TestIsmStorage::deserialize(
                    &mut &account.data[8..] // Skip 8-byte AccountData discriminator
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        println!("Error deserializing Test ISM storage: {}", e);
                        return;
                    }
                };
                
                println!("Test ISM Storage:");
                println!("  Accept: {} ({})", 
                    storage.accept,
                    if storage.accept { "accepts all messages" } else { "rejects all messages" }
                );
            } else {
                println!("Test ISM not initialized");
            }
        }
    }
}

/// Deploys and initializes a Test ISM program on Solana.
/// 
/// # Arguments
/// * `ctx` - Context containing client and payer information
/// * `built_so_dir` - Directory containing the compiled .so file
/// * `key_dir` - Directory to store program keypairs
/// * `local_domain` - The Hyperlane domain ID for this chain
/// 
/// # Returns
/// The deployed program's public key
pub(crate) fn deploy_test_ism(
    ctx: &mut Context,
    built_so_dir: &Path,
    key_dir: &Path,
    local_domain: u32,
) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_test_ism",
        built_so_dir
            .join("hyperlane_sealevel_test_ism.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        local_domain,
    )
    .unwrap();

    println!("Deployed Test ISM at program ID {}", program_id);

    // Initialize the Test ISM
    initialize_test_ism(
        ctx,
        program_id,
        format!("Initializing Test ISM with payer {}", ctx.payer_pubkey),
    );
    
    println!("Initialized Test ISM at program ID {}", program_id);

    program_id
}