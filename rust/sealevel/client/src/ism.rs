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
use hyperlane_sealevel_token::plugin::SyntheticPlugin;
use hyperlane_sealevel_token_collateral::plugin::CollateralPlugin;
use hyperlane_sealevel_token_native::plugin::NativePlugin;
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneTokenAccount,
    hyperlane_token_pda_seeds,
};

/// Processes ISM commands
pub(crate) fn process_ism_cmd(mut ctx: Context, cmd: IsmCmd) {
    let query = cmd.query;
    
    // If token is provided, extract domains from token
    let domains = if let Some(token_program_id) = query.token {
        println!("🔍 Fetching domains from token: {}", token_program_id);
        match get_domains_from_token(&mut ctx, token_program_id, query.program_id) {
            Ok(domains) => {
                if domains.is_empty() {
                    println!("⚠️  Warning: Token has no remote routers configured");
                    None
                } else {
                    println!("✅ Found {} remote domain(s) from token: {:?}", domains.len(), domains);
                    Some(domains)
                }
            }
            Err(e) => {
                println!("❌ Error fetching token data: {}", e);
                return;
            }
        }
    } else {
        query.domains
    };
    
    match query.ism_type {
        IsmType::MultisigMessageId => {
            query_multisig_ism_message_id(&mut ctx, query.program_id, domains);
        }
        IsmType::Test => {
            query_test_ism(&mut ctx, query.program_id);
        }
    }
}

/// Fetches token account and extracts remote domains, verifying ISM matches if configured
fn get_domains_from_token(
    ctx: &mut Context,
    token_program_id: Pubkey,
    expected_ism_program_id: Pubkey,
) -> Result<Vec<u32>, String> {
    // Get token PDA account
    let (token_pda_key, _token_bump) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &token_program_id);

    let accounts = ctx
        .client
        .get_multiple_accounts_with_commitment(&[token_pda_key], ctx.commitment)
        .map_err(|e| format!("Failed to fetch token account: {}", e))?
        .value;

    let account = accounts[0]
        .as_ref()
        .ok_or_else(|| "Token account not found".to_string())?;

    // Try to deserialize with different plugin types and extract ISM + remote_routers
    let (ism, remote_routers): (Option<Pubkey>, std::collections::HashMap<u32, hyperlane_core::H256>) = {
        // Try SyntheticPlugin first
        if let Ok(token_account) = HyperlaneTokenAccount::<SyntheticPlugin>::fetch(&mut &account.data[..]) {
            let token = token_account.into_inner();
            (token.interchain_security_module, token.remote_routers)
        } else if let Ok(token_account) = HyperlaneTokenAccount::<NativePlugin>::fetch(&mut &account.data[..]) {
            let token = token_account.into_inner();
            (token.interchain_security_module, token.remote_routers)
        } else if let Ok(token_account) = HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &account.data[..]) {
            let token = token_account.into_inner();
            (token.interchain_security_module, token.remote_routers)
        } else {
            return Err("Failed to deserialize token account with any plugin type (tried Synthetic, Native, Collateral)".to_string());
        }
    };

    // Verify ISM matches if configured (skip validation if None - uses mailbox default)
    if let Some(token_ism) = ism {
        if token_ism != expected_ism_program_id {
            return Err(format!(
                "Token ISM ({}) does not match expected ISM ({})",
                token_ism, expected_ism_program_id
            ));
        }
    }

    // Extract domains from remote_routers
    let mut domains: Vec<u32> = remote_routers.keys().copied().collect();
    domains.sort();
    Ok(domains)
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
        println!("   Or use --token to automatically query domains from a token's remote routers");
        println!("   Example: --token <token_program_id>");
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

