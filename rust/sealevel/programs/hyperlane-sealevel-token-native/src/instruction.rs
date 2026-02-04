//! Instructions for the program.

use hyperlane_sealevel_token_lib::instruction::{init_instruction as lib_init_instruction, Init};
use shank::{ShankInstruction, ShankType};

use crate::hyperlane_token_native_collateral_pda_seeds;

use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

// ============================================================================
// Proxy types for IDL generation
// ============================================================================

/// Proxy for the shared Instruction enum from hyperlane_sealevel_token_lib.
/// This tells Shank to import the instruction definitions from the library's IDL.
#[derive(Debug, ShankInstruction)]
#[shank(import_from = "hyperlane_sealevel_token_lib", rename = "Instruction")]
pub enum TokenInstructionProxy {}

/// Proxy for Init instruction data.
#[derive(borsh::BorshDeserialize, borsh::BorshSerialize, ShankType)]
#[shank(import_from = "hyperlane_sealevel_token_lib", rename = "Init")]
pub struct InitProxy;

/// Proxy for TransferRemote instruction data.
#[derive(borsh::BorshDeserialize, borsh::BorshSerialize, ShankType)]
#[shank(
    import_from = "hyperlane_sealevel_token_lib",
    rename = "TransferRemote"
)]
pub struct TransferRemoteProxy;

/// Proxy for RemoteRouterConfig from hyperlane_sealevel_connection_client.
#[derive(borsh::BorshDeserialize, borsh::BorshSerialize, ShankType)]
#[shank(
    import_from = "hyperlane_sealevel_connection_client",
    rename = "RemoteRouterConfig"
)]
pub struct RemoteRouterConfigProxy;

/// Proxy for GasRouterConfig from hyperlane_sealevel_connection_client.
#[derive(borsh::BorshDeserialize, borsh::BorshSerialize, ShankType)]
#[shank(
    import_from = "hyperlane_sealevel_connection_client",
    rename = "GasRouterConfig"
)]
pub struct GasRouterConfigProxy;

/// Proxy for InterchainGasPaymasterType from hyperlane_sealevel_igp.
#[derive(borsh::BorshDeserialize, borsh::BorshSerialize, ShankType)]
#[shank(
    import_from = "hyperlane_sealevel_igp",
    rename = "InterchainGasPaymasterType"
)]
pub struct InterchainGasPaymasterTypeProxy;

// ============================================================================
// Program-specific instruction builders
// ============================================================================

/// Gets an instruction to initialize the program.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    init: Init,
) -> Result<SolanaInstruction, ProgramError> {
    let mut instruction = lib_init_instruction(program_id, payer, init)?;

    // Add additional account metas:
    // 0. `[writable]` The native collateral PDA account.

    let (native_collateral_key, _native_collatera_bump) =
        Pubkey::find_program_address(hyperlane_token_native_collateral_pda_seeds!(), &program_id);

    instruction
        .accounts
        .append(&mut vec![AccountMeta::new(native_collateral_key, false)]);

    Ok(instruction)
}
