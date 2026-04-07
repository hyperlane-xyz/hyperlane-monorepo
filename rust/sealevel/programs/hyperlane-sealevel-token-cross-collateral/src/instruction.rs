//! Cross-collateral instruction types and builders.

use account_utils::{DiscriminatorData, DiscriminatorEncode};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_mailbox::mailbox_outbox_pda_seeds;
use hyperlane_sealevel_token_collateral::instruction::init_instruction as collateral_init_instruction;
use hyperlane_sealevel_token_lib::{hyperlane_token_pda_seeds, instruction::Init};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{cross_collateral_dispatch_authority_pda_seeds, cross_collateral_pda_seeds};

/// Discriminator for cross-collateral instructions.
pub const CROSS_COLLATERAL_INSTRUCTION_DISCRIMINATOR: [u8; 8] = [2, 2, 2, 2, 2, 2, 2, 2];

/// Update operation for cross-collateral router management.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum CrossCollateralRouterUpdate {
    /// Enroll a router for a domain.
    Add {
        /// The domain to enroll the router for.
        domain: u32,
        /// The router address to enroll.
        router: H256,
    },
    /// Remove routers for a domain.
    /// `Some(router)` removes a specific router from the domain.
    /// `None` removes all routers for the domain.
    Remove(RemoteRouterConfig),
}

/// Cross-collateral instruction set.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum CrossCollateralInstruction {
    /// Set CC routers. Owner-only.
    SetCrossCollateralRouters(Vec<CrossCollateralRouterUpdate>),
    /// Transfer to a specific enrolled router. If `destination_domain == local_domain`,
    /// performs a same-chain CPI into the target's HandleLocal. Otherwise, dispatches
    /// cross-chain via the mailbox. Account layout diverges after the shared prefix
    /// (system_program, token PDA, CC state PDA) depending on the path taken.
    TransferRemoteTo(TransferRemoteTo),
    /// Same-chain CPI receive. PDA-verified caller only.
    HandleLocal(HandleLocal),
    /// Returns account metas needed for HandleLocal (off-chain simulation).
    HandleLocalAccountMetas(HandleLocal),
}

impl DiscriminatorData for CrossCollateralInstruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] =
        CROSS_COLLATERAL_INSTRUCTION_DISCRIMINATOR;
}

/// Instruction data for transferring to a specific enrolled router.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemoteTo {
    /// The destination domain.
    pub destination_domain: u32,
    /// The remote recipient.
    pub recipient: H256,
    /// The amount or ID of the token to transfer.
    pub amount_or_id: hyperlane_core::U256,
    /// The target router to dispatch to (must be enrolled).
    pub target_router: H256,
}

/// Instruction data for same-chain CPI receive.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct HandleLocal {
    /// The program ID of the sending CC program (used for PDA verification).
    /// The sender H256 for router authorization is derived from this field
    /// to prevent spoofing (a caller cannot claim to be a different program
    /// because the PDA signer check ties identity to this program ID).
    pub sender_program_id: Pubkey,
    /// The message body (TokenMessage encoded).
    pub message: Vec<u8>,
}

/// Gets an instruction to initialize the cross-collateral program.
///
/// Accounts:
/// 0.  `[executable]` The system program.
/// 1.  `[writable]` The token PDA account.
/// 2.  `[writable]` The dispatch authority PDA account.
/// 3.  `[signer]` The payer and access control owner.
/// 4.  `[executable]` The SPL token program for the mint.
/// 5.  `[]` The mint.
/// 6.  `[executable]` The Rent sysvar program.
/// 7.  `[writable]` The escrow PDA account.
/// 8.  `[writable]` The ATA payer PDA account.
/// 9.  `[writable]` The CC state PDA account.
/// 10. `[writable]` The CC dispatch authority PDA account.
/// 11. `[]` The mailbox outbox PDA account (to read local_domain).
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    init: Init,
    spl_program: Pubkey,
    mint: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let mailbox = init.mailbox;
    let mut instruction = collateral_init_instruction(program_id, payer, init, spl_program, mint)?;

    let (cc_state_key, _cc_state_bump) =
        Pubkey::try_find_program_address(cross_collateral_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let (cc_dispatch_authority_key, _cc_dispatch_authority_bump) =
        Pubkey::try_find_program_address(
            cross_collateral_dispatch_authority_pda_seeds!(),
            &program_id,
        )
        .ok_or(ProgramError::InvalidSeeds)?;

    let (mailbox_outbox_key, _mailbox_outbox_bump) =
        Pubkey::try_find_program_address(mailbox_outbox_pda_seeds!(), &mailbox)
            .ok_or(ProgramError::InvalidSeeds)?;

    // CC-specific accounts
    instruction.accounts.append(&mut vec![
        AccountMeta::new(cc_state_key, false),
        AccountMeta::new(cc_dispatch_authority_key, false),
        // Mailbox outbox to read local_domain
        AccountMeta::new_readonly(mailbox_outbox_key, false),
    ]);

    Ok(instruction)
}

/// Gets an instruction to set cross-collateral routers.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writable]` The CC state PDA account.
/// 2. `[]` The token PDA account.
/// 3. `[signer]` The owner.
pub fn set_cross_collateral_routers_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    configs: Vec<CrossCollateralRouterUpdate>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let (cc_state_key, _cc_state_bump) =
        Pubkey::try_find_program_address(cross_collateral_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = CrossCollateralInstruction::SetCrossCollateralRouters(configs);

    let accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new(cc_state_key, false),
        AccountMeta::new_readonly(token_key, false),
        AccountMeta::new(owner_payer, true),
    ];

    Ok(SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    })
}
