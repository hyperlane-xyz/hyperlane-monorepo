//! Instructions for the multicollateral token program.

use account_utils::{DiscriminatorData, DiscriminatorEncode};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_token_lib::instruction::{init_instruction as lib_init_instruction, Init};

use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::SysvarId,
};

use hyperlane_sealevel_token_collateral::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_escrow_pda_seeds,
};
use hyperlane_sealevel_token_lib::hyperlane_token_pda_seeds;
use solana_system_interface::program as system_program;

/// Discriminator for MultiCollateral-specific instructions.
/// Uses a different prefix to avoid collision with base token instructions
/// and MessageRecipientInstruction.
const MULTICOLLATERAL_INSTRUCTION_DISCRIMINATOR: [u8; 8] =
    [0x4d, 0x43, 0x4f, 0x4c, 0x4c, 0x41, 0x54, 0x00]; // "MCOLLAT\0"

/// An enrolled router entry: (domain, router_address).
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub struct EnrolledRouterConfig {
    /// The domain ID.
    pub domain: u32,
    /// The router address (bytes32).
    pub router: H256,
}

/// Instruction data for transferring to a specific target router.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemoteTo {
    /// The destination domain.
    pub destination_domain: u32,
    /// The remote recipient.
    pub recipient: H256,
    /// The amount of tokens to transfer (in local decimals).
    pub amount_or_id: u64,
    /// The specific target router on the destination domain.
    /// Must be enrolled in enrolled_routers for destination_domain.
    pub target_router: H256,
}

/// Instruction data for handling a local (same-chain) transfer via CPI.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct HandleLocal {
    /// The origin domain (should be local_domain).
    pub origin_domain: u32,
    /// The sender (program ID of the calling multicollateral program, as H256).
    pub sender: H256,
    /// The TokenMessage bytes (recipient + amount + metadata).
    pub message: Vec<u8>,
}

/// MultiCollateral-specific instructions, beyond base token instructions.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum MultiCollateralInstruction {
    /// Enroll additional routers for multicollateral support. Owner only.
    /// These are separate from the base remote_routers — they enable
    /// multi-router-per-domain support.
    EnrollRouters(Vec<EnrolledRouterConfig>),
    /// Unenroll routers. Owner only.
    UnenrollRouters(Vec<EnrolledRouterConfig>),
    /// Transfer tokens to a specific target router (may be same-chain or cross-chain).
    TransferRemoteTo(TransferRemoteTo),
    /// Handle a local (same-chain) transfer via CPI from an enrolled local router.
    HandleLocal(HandleLocal),
    /// Set the local domain for same-chain transfer detection. Owner only.
    SetLocalDomain(u32),
}

impl DiscriminatorData for MultiCollateralInstruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] =
        MULTICOLLATERAL_INSTRUCTION_DISCRIMINATOR;
}

/// Gets an instruction to initialize the multicollateral program.
/// Same as collateral init but with the multicollateral program ID.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    init: Init,
    spl_program: Pubkey,
    mint: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let mut instruction = lib_init_instruction(program_id, payer, init)?;

    // Add collateral-specific account metas:
    // 0. `[executable]` The SPL token program for the mint.
    // 1. `[]` The mint.
    // 2. `[executable]` The Rent sysvar program.
    // 3. `[writable]` The escrow PDA account.
    // 4. `[writable]` The ATA payer PDA account.
    let (escrow_key, _escrow_bump) =
        Pubkey::find_program_address(hyperlane_token_escrow_pda_seeds!(), &program_id);

    let (ata_payer_key, _ata_payer_bump) =
        Pubkey::find_program_address(hyperlane_token_ata_payer_pda_seeds!(), &program_id);

    let (mc_state_key, _mc_state_bump) =
        Pubkey::find_program_address(&[b"hyperlane_token", b"-", b"multicollateral"], &program_id);

    instruction.accounts.append(&mut vec![
        AccountMeta::new_readonly(spl_program, false),
        AccountMeta::new_readonly(mint, false),
        AccountMeta::new_readonly(Rent::id(), false),
        AccountMeta::new(escrow_key, false),
        AccountMeta::new(ata_payer_key, false),
        AccountMeta::new(mc_state_key, false),
    ]);

    Ok(instruction)
}

/// Enrolls additional multicollateral routers.
pub fn enroll_multi_routers_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    configs: Vec<EnrolledRouterConfig>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let (mc_state_key, _mc_state_bump) =
        Pubkey::find_program_address(&[b"hyperlane_token", b"-", b"multicollateral"], &program_id);

    let ixn = MultiCollateralInstruction::EnrollRouters(configs);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The token PDA account.
    // 2. `[signer]` The owner.
    // 3. `[writeable]` The multicollateral state PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(token_key, false),
        AccountMeta::new(owner_payer, true),
        AccountMeta::new(mc_state_key, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

/// Unenrolls multicollateral routers.
pub fn unenroll_multi_routers_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    configs: Vec<EnrolledRouterConfig>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let (mc_state_key, _mc_state_bump) =
        Pubkey::find_program_address(&[b"hyperlane_token", b"-", b"multicollateral"], &program_id);

    let ixn = MultiCollateralInstruction::UnenrollRouters(configs);

    // Accounts:
    // 0. `[executable]` The system program.
    // 1. `[writeable]` The token PDA account.
    // 2. `[signer]` The owner.
    // 3. `[writeable]` The multicollateral state PDA.
    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(token_key, false),
        AccountMeta::new(owner_payer, true),
        AccountMeta::new(mc_state_key, false),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}
