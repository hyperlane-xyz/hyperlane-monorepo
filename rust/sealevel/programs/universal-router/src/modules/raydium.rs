//! Raydium swap module
//!
//! CPIs into:
//!   Raydium CLMM  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK
//!   Raydium AMM V4  675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
//!
//! Both programs are called via raw `invoke` with manually constructed
//! `Instruction` structs; neither publishes a Rust CPI crate.

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_pack::Pack,
};

use crate::{
    constants::RAYDIUM_CLMM_PROGRAM_ID, error::RouterError,
    types::amount_sentinels::CONTRACT_BALANCE,
};

// ---------------------------------------------------------------------------
// RAYDIUM_CLMM_SWAP_EXACT_IN (0x00)
//
// remaining_accounts (17):
//   [0]  payer                     writable signer (authority)
//   [1]  amm_config                readonly
//   [2]  pool_state                writable
//   [3]  input_token_account       writable
//   [4]  output_token_account      writable
//   [5]  input_vault               writable
//   [6]  output_vault              writable
//   [7]  observation_state         writable
//   [8]  token_program             readonly (SPL Token)
//   [9]  token_program_2022        readonly (Token-2022)
//   [10] memo_program              readonly
//   [11] input_vault_mint          readonly
//   [12] output_vault_mint         readonly
//   [13] tick_array_0              writable
//   [14] tick_array_1              writable
//   [15] tick_array_2              writable
//   [16] raydium_clmm_program      readonly (program ID account)
// ---------------------------------------------------------------------------

/// Anchor discriminator for Raydium CLMM `swap_v2` = sha256("global:swap_v2")[..8]
const RAYDIUM_CLMM_SWAP_V2_DISC: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];

pub fn execute_raydium_clmm_swap_exact_in<'info>(
    amount_in: u64,
    amount_out_minimum: u64,
    sqrt_price_limit_x64: u128,
    is_base_input: bool,
    authority: &AccountInfo<'info>,
    accounts: &'info [AccountInfo<'info>],
) -> ProgramResult {
    if accounts.len() < 17 {
        return Err(RouterError::InsufficientAccounts.into());
    }

    let input_token_account = &accounts[3];

    let resolved_amount_in = if amount_in == CONTRACT_BALANCE {
        let data = input_token_account.data.borrow();
        spl_token::state::Account::unpack(&data)
            .map_err(|_| RouterError::InvalidInputs)?
            .amount
    } else {
        amount_in
    };

    if resolved_amount_in == 0 {
        return Err(RouterError::InsufficientOutput.into());
    }

    // Build swap_v2 ix data: disc(8) | amount(8) | threshold(8) | sqrt_limit(16) | is_base(1)
    let mut ix_data = Vec::with_capacity(41);
    ix_data.extend_from_slice(&RAYDIUM_CLMM_SWAP_V2_DISC);
    ix_data.extend_from_slice(&resolved_amount_in.to_le_bytes());
    ix_data.extend_from_slice(&amount_out_minimum.to_le_bytes());
    ix_data.extend_from_slice(&sqrt_price_limit_x64.to_le_bytes());
    ix_data.push(is_base_input as u8);

    let account_metas = vec![
        AccountMeta::new(*authority.key, true), // [0]  payer
        AccountMeta::new_readonly(*accounts[1].key, false), // [1]  amm_config
        AccountMeta::new(*accounts[2].key, false), // [2]  pool_state
        AccountMeta::new(*accounts[3].key, false), // [3]  input_token_account
        AccountMeta::new(*accounts[4].key, false), // [4]  output_token_account
        AccountMeta::new(*accounts[5].key, false), // [5]  input_vault
        AccountMeta::new(*accounts[6].key, false), // [6]  output_vault
        AccountMeta::new(*accounts[7].key, false), // [7]  observation_state
        AccountMeta::new_readonly(*accounts[8].key, false), // [8]  token_program (SPL Token)
        AccountMeta::new_readonly(*accounts[9].key, false), // [9]  token_program_2022
        AccountMeta::new_readonly(*accounts[10].key, false), // [10] memo_program
        AccountMeta::new_readonly(*accounts[11].key, false), // [11] input_vault_mint
        AccountMeta::new_readonly(*accounts[12].key, false), // [12] output_vault_mint
        AccountMeta::new(*accounts[13].key, false), // [13] tick_array_0
        AccountMeta::new(*accounts[14].key, false), // [14] tick_array_1
        AccountMeta::new(*accounts[15].key, false), // [15] tick_array_2
    ];

    let ix = Instruction {
        program_id: RAYDIUM_CLMM_PROGRAM_ID,
        accounts: account_metas,
        data: ix_data,
    };

    let account_infos = vec![
        authority.clone(),
        accounts[1].clone(),
        accounts[2].clone(),
        accounts[3].clone(),
        accounts[4].clone(),
        accounts[5].clone(),
        accounts[6].clone(),
        accounts[7].clone(),
        accounts[8].clone(),
        accounts[9].clone(),
        accounts[10].clone(),
        accounts[11].clone(),
        accounts[12].clone(),
        accounts[13].clone(),
        accounts[14].clone(),
        accounts[15].clone(),
        accounts[16].clone(), // raydium_clmm_program
    ];

    invoke(&ix, &account_infos)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// RAYDIUM_AMM_SWAP_EXACT_IN (0x01)
//
// Raydium AMM V4 is NOT an Anchor program — uses legacy binary serialization.
// SwapBaseIn tag = 9.
//
// remaining_accounts (18):
//   [0]  token_program
//   [1]  amm_id                     writable
//   [2]  amm_authority              readonly
//   [3]  amm_open_orders            writable
//   [4]  amm_target_orders          writable
//   [5]  pool_coin_token_account    writable
//   [6]  pool_pc_token_account      writable
//   [7]  serum_program_id           readonly
//   [8]  serum_market               writable
//   [9]  serum_bids                 writable
//   [10] serum_asks                 writable
//   [11] serum_event_queue          writable
//   [12] serum_coin_vault           writable
//   [13] serum_pc_vault             writable
//   [14] serum_vault_signer         readonly
//   [15] user_source_token_account  writable
//   [16] user_dest_token_account    writable
//   [17] user_owner                 writable signer (authority)
// ---------------------------------------------------------------------------

const RAYDIUM_AMM_SWAP_BASE_IN_TAG: u8 = 9;

pub fn execute_raydium_amm_swap_exact_in<'info>(
    amount_in: u64,
    amount_out_minimum: u64,
    authority: &AccountInfo<'info>,
    accounts: &'info [AccountInfo<'info>],
) -> ProgramResult {
    if accounts.len() < 18 {
        return Err(RouterError::InsufficientAccounts.into());
    }

    let user_source = &accounts[15];

    let resolved_amount_in = if amount_in == CONTRACT_BALANCE {
        let data = user_source.data.borrow();
        spl_token::state::Account::unpack(&data)
            .map_err(|_| RouterError::InvalidInputs)?
            .amount
    } else {
        amount_in
    };

    if resolved_amount_in == 0 {
        return Err(RouterError::InsufficientOutput.into());
    }

    // AMM V4 SwapBaseIn: tag(1) | amount_in(8) | min_amount_out(8)
    let mut ix_data = Vec::with_capacity(17);
    ix_data.push(RAYDIUM_AMM_SWAP_BASE_IN_TAG);
    ix_data.extend_from_slice(&resolved_amount_in.to_le_bytes());
    ix_data.extend_from_slice(&amount_out_minimum.to_le_bytes());

    let account_metas = accounts[..18]
        .iter()
        .enumerate()
        .map(|(i, acc)| {
            let is_signer = i == 17;
            let is_writable = matches!(
                i,
                1 | 3 | 4 | 5 | 6 | 8 | 9 | 10 | 11 | 12 | 13 | 15 | 16 | 17
            );
            if is_signer {
                AccountMeta::new(*acc.key, true)
            } else if is_writable {
                AccountMeta::new(*acc.key, false)
            } else {
                AccountMeta::new_readonly(*acc.key, false)
            }
        })
        .collect::<Vec<_>>();

    let ix = Instruction {
        program_id: crate::constants::RAYDIUM_AMM_V4_PROGRAM_ID,
        accounts: account_metas,
        data: ix_data,
    };

    // accounts[17] is the user_owner slot, but authority is the actual signer
    let mut account_infos: Vec<AccountInfo> = accounts[..17].to_vec();
    account_infos.push(authority.clone());

    invoke(&ix, &account_infos)?;

    Ok(())
}
