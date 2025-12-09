//! ISM (Interchain Security Module) query implementation for Solana
//!
//! This module provides a unified interface to query different types of ISM programs.

use borsh::BorshDeserialize;
use solana_program::pubkey::Pubkey;

use crate::{Context, IsmCmd, IsmType};

use hyperlane_sealevel_multisig_ism_message_id::{
    access_control_pda_seeds, accounts::{AccessControlAccount, DomainDataAccount},
    domain_data_pda_seeds,
};

/// Processes ISM commands
pub(crate) fn process_ism_cmd(mut ctx: Context, cmd: IsmCmd) {
    let query = cmd.query;
    
    match query.ism_type {
        IsmType::MultisigMessageId => {
            query_multisig_ism_message_id(&mut ctx, query.program_id, query.domains);
        }
        IsmType::Test => {
            query_test_ism(&mut ctx, query.program_id);
        }
    }
}

/// Queries a Multisig ISM Message ID program
fn query_multisig_ism_message_id(
    ctx: &mut Context,
    program_id: Pubkey,
    domains: Option<Vec<u32>>,
) {
    println!("=================================");
    println!("Multisig ISM Message ID Query");
    println!("Program ID: {}", program_id);
    println!("=================================\n");

    // Query access control PDA
    let (access_control_pda_key, access_control_bump) =
        Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);

    println!("Access Control PDA: {}", access_control_pda_key);
    println!("Access Control Bump: {}\n", access_control_bump);

    let accounts = ctx
        .client
        .get_multiple_accounts_with_commitment(&[access_control_pda_key], ctx.commitment)
        .unwrap()
        .value;

    if let Some(account) = &accounts[0] {
        let access_control = AccessControlAccount::fetch(&mut &account.data[..])
            .unwrap()
            .into_inner();
        println!("Access Control Data:");
        println!("  Owner: {:?}", access_control.owner);
        println!("  Bump Seed: {}", access_control.bump_seed);
    } else {
        println!("Access Control PDA not initialized");
    }

    // Query domain data if domains are specified
    if let Some(domains) = domains {
        println!("\n---------------------------------");
        println!("Domain Data");
        println!("---------------------------------");
        
        for domain in domains {
            println!("\nDomain: {}", domain);
            
            let (domain_data_pda_key, domain_data_bump) =
                Pubkey::find_program_address(domain_data_pda_seeds!(domain), &program_id);
            
            println!("  Domain Data PDA: {}", domain_data_pda_key);
            println!("  Domain Data Bump: {}", domain_data_bump);

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&[domain_data_pda_key], ctx.commitment)
                .unwrap()
                .value;

            if let Some(account) = &accounts[0] {
                let domain_data = DomainDataAccount::fetch(&mut &account.data[..])
                    .unwrap()
                    .into_inner();
                
                println!("  Validators ({}):", domain_data.validators_and_threshold.validators.len());
                for (i, validator) in domain_data.validators_and_threshold.validators.iter().enumerate() {
                    println!("    {}: {}", i + 1, validator);
                }
                println!("  Threshold: {}", domain_data.validators_and_threshold.threshold);
                println!("  Bump Seed: {}", domain_data.bump_seed);
            } else {
                println!("  Status: Not initialized");
            }
        }
    } else {
        println!("\nℹ️  Tip: Use --domains to query specific domain configurations");
        println!("   Example: --domains 1,2,3");
    }

    println!("\n=================================");
}

/// Queries a Test ISM program
fn query_test_ism(ctx: &mut Context, program_id: Pubkey) {
    println!("=================================");
    println!("Test ISM Query");
    println!("Program ID: {}", program_id);
    println!("=================================\n");

    let (storage_pda_key, storage_bump) =
        Pubkey::find_program_address(&[b"test_ism", b"-", b"storage"], &program_id);

    println!("Storage PDA: {}", storage_pda_key);
    println!("Storage Bump: {}\n", storage_bump);

    let accounts = ctx
        .client
        .get_multiple_accounts_with_commitment(&[storage_pda_key], ctx.commitment)
        .unwrap()
        .value;

    if let Some(account) = &accounts[0] {
        // Try to deserialize the storage, handling both formats (with and without discriminator)
        let storage = if account.data.len() >= 8 {
            // Try with 8-byte discriminator first (new format)
            match hyperlane_sealevel_test_ism::program::TestIsmStorage::deserialize(
                &mut &account.data[8..],
            ) {
                Ok(s) => s,
                Err(_) => {
                    // Fall back to no discriminator (old format)
                    match hyperlane_sealevel_test_ism::program::TestIsmStorage::deserialize(
                        &mut &account.data[..],
                    ) {
                        Ok(s) => s,
                        Err(e) => {
                            println!("❌ Error deserializing Test ISM storage: {}", e);
                            println!("Account data (hex): {:02x?}", account.data);
                            return;
                        }
                    }
                }
            }
        } else {
            // Small data, try without discriminator
            match hyperlane_sealevel_test_ism::program::TestIsmStorage::deserialize(
                &mut &account.data[..],
            ) {
                Ok(s) => s,
                Err(e) => {
                    println!("❌ Error deserializing Test ISM storage: {}", e);
                    println!("Account data (hex): {:02x?}", account.data);
                    return;
                }
            }
        };

        println!("Storage Data:");
        println!(
            "  Accept: {} ({})",
            storage.accept,
            if storage.accept {
                "✅ Accepts all messages"
            } else {
                "❌ Rejects all messages"
            }
        );
        println!("\n⚠️  WARNING: This is a TEST ISM with no access control!");
        println!("   Do NOT use in production!");
    } else {
        println!("❌ Test ISM Storage not initialized");
    }

    println!("\n=================================");
}

