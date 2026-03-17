//! Program processor.

use account_utils::{create_pda_account, DiscriminatorDecode, SizedData};
use hyperlane_sealevel_mailbox::{
    accounts::Outbox, mailbox_message_dispatch_authority_pda_seeds,
    mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    instruction::Instruction as TokenIxn,
    processor::{HyperlaneSealevelToken, HyperlaneSealevelTokenPlugin},
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;
use std::collections::HashMap;

use crate::{
    accounts::{CrossCollateralState, CrossCollateralStateAccount},
    cross_collateral_dispatch_authority_pda_seeds, cross_collateral_pda_seeds,
    error::Error,
    instruction::{CrossCollateralInit, CrossCollateralInstruction},
    plugin::CollateralPlugin,
};

use hyperlane_sealevel_token_lib::hyperlane_token_pda_seeds;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Processes an instruction.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // Stage 1: Try cross-collateral instruction discriminator [2,2,2,2,2,2,2,2]
    if let Ok(cc_instruction) = CrossCollateralInstruction::decode(instruction_data) {
        return match cc_instruction {
            CrossCollateralInstruction::Init(init) => initialize(program_id, accounts, init),
            CrossCollateralInstruction::SetCrossCollateralRouters(_configs) => {
                // TODO: implement in next step
                msg!("SetCrossCollateralRouters not yet implemented");
                Err(ProgramError::InvalidInstructionData)
            }
            CrossCollateralInstruction::TransferRemoteTo(_transfer) => {
                // TODO: implement in commit 6
                msg!("TransferRemoteTo not yet implemented");
                Err(ProgramError::InvalidInstructionData)
            }
            CrossCollateralInstruction::HandleLocal(_handle) => {
                // TODO: implement in commit 7
                msg!("HandleLocal not yet implemented");
                Err(ProgramError::InvalidInstructionData)
            }
            CrossCollateralInstruction::HandleLocalAccountMetas(_handle) => {
                // TODO: implement in commit 7
                msg!("HandleLocalAccountMetas not yet implemented");
                Err(ProgramError::InvalidInstructionData)
            }
        };
    }

    // Stage 2: Try message recipient interface discriminator
    if let Ok(message_recipient_instruction) = MessageRecipientInstruction::decode(instruction_data)
    {
        return match message_recipient_instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                HyperlaneSealevelToken::<CollateralPlugin>::interchain_security_module(
                    program_id, accounts,
                )
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                HyperlaneSealevelToken::<CollateralPlugin>::interchain_security_module_account_metas(
                    program_id,
                )
            }
            MessageRecipientInstruction::Handle(handle) => {
                // TODO: intercept with dual-router validation in commit 5
                HyperlaneSealevelToken::<CollateralPlugin>::transfer_from_remote(
                    program_id,
                    accounts,
                    HandleInstruction {
                        origin: handle.origin,
                        sender: handle.sender,
                        message: handle.message,
                    },
                )
            }
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                // TODO: intercept with CC state PDA in commit 5
                HyperlaneSealevelToken::<CollateralPlugin>::transfer_from_remote_account_metas(
                    program_id,
                    accounts,
                    HandleInstruction {
                        origin: handle.origin,
                        sender: handle.sender,
                        message: handle.message,
                    },
                )
            }
        };
    }

    // Stage 3: Token instruction discriminator [1,1,1,1,1,1,1,1]
    // Block TokenIxn::Init — must use CrossCollateralInstruction::Init
    match TokenIxn::decode(instruction_data)? {
        TokenIxn::Init(_) => Err(Error::BaseInitNotAllowed.into()),
        TokenIxn::TransferRemote(xfer) => {
            HyperlaneSealevelToken::<CollateralPlugin>::transfer_remote(program_id, accounts, xfer)
        }
        TokenIxn::EnrollRemoteRouter(config) => {
            HyperlaneSealevelToken::<CollateralPlugin>::enroll_remote_router(
                program_id, accounts, config,
            )
        }
        TokenIxn::EnrollRemoteRouters(configs) => {
            HyperlaneSealevelToken::<CollateralPlugin>::enroll_remote_routers(
                program_id, accounts, configs,
            )
        }
        TokenIxn::SetDestinationGasConfigs(configs) => {
            HyperlaneSealevelToken::<CollateralPlugin>::set_destination_gas_configs(
                program_id, accounts, configs,
            )
        }
        TokenIxn::TransferOwnership(new_owner) => {
            HyperlaneSealevelToken::<CollateralPlugin>::transfer_ownership(
                program_id, accounts, new_owner,
            )
        }
        TokenIxn::SetInterchainSecurityModule(new_ism) => {
            HyperlaneSealevelToken::<CollateralPlugin>::set_interchain_security_module(
                program_id, accounts, new_ism,
            )
        }
        TokenIxn::SetInterchainGasPaymaster(new_igp) => {
            HyperlaneSealevelToken::<CollateralPlugin>::set_interchain_gas_paymaster(
                program_id, accounts, new_igp,
            )
        }
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

/// Initializes the cross-collateral program.
/// Replicates base init logic + CollateralPlugin::initialize + CC-specific PDAs.
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
/// 11. `[]` The mailbox outbox PDA account (for local_domain validation).
fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    init: CrossCollateralInit,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: Token storage account
    let token_account = next_account_info(accounts_iter)?;
    let (token_key, token_bump) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);
    if &token_key != token_account.key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !token_account.data_is_empty() || token_account.owner != &system_program::ID {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Account 2: Dispatch authority PDA
    let dispatch_authority_account = next_account_info(accounts_iter)?;
    let (dispatch_authority_key, dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if *dispatch_authority_account.key != dispatch_authority_key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !dispatch_authority_account.data_is_empty()
        || dispatch_authority_account.owner != &system_program::ID
    {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Account 3: Payer
    let payer_account = next_account_info(accounts_iter)?;
    if !payer_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Mailbox process authority for this program as a recipient
    let (mailbox_process_authority, _mailbox_process_authority_bump) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(program_id),
        &init.mailbox,
    );

    // Accounts 4-8: CollateralPlugin::initialize
    let plugin_data = CollateralPlugin::initialize(
        program_id,
        system_program_info,
        token_account,
        payer_account,
        accounts_iter,
    )?;

    // Account 9: CC state PDA
    let cc_state_account = next_account_info(accounts_iter)?;
    let (cc_state_key, cc_state_bump) =
        Pubkey::find_program_address(cross_collateral_pda_seeds!(), program_id);
    if cc_state_account.key != &cc_state_key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !cc_state_account.data_is_empty() || cc_state_account.owner != &system_program::ID {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Account 10: CC dispatch authority PDA
    let cc_dispatch_authority_account = next_account_info(accounts_iter)?;
    let (cc_dispatch_authority_key, cc_dispatch_authority_bump) =
        Pubkey::find_program_address(cross_collateral_dispatch_authority_pda_seeds!(), program_id);
    if cc_dispatch_authority_account.key != &cc_dispatch_authority_key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !cc_dispatch_authority_account.data_is_empty()
        || cc_dispatch_authority_account.owner != &system_program::ID
    {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Account 11: Mailbox outbox PDA — validate local_domain matches mailbox
    let mailbox_outbox_account = next_account_info(accounts_iter)?;
    let outbox = Outbox::verify_account_and_fetch_inner(&init.mailbox, mailbox_outbox_account)?;
    if outbox.local_domain != init.local_domain {
        msg!(
            "local_domain mismatch: init={} mailbox={}",
            init.local_domain,
            outbox.local_domain
        );
        return Err(ProgramError::InvalidArgument);
    }

    // Extraneous account check
    if accounts_iter.next().is_some() {
        return Err(Error::ExtraneousAccount.into());
    }

    let rent = Rent::get()?;

    // Build and store HyperlaneToken<CollateralPlugin>
    let token: HyperlaneToken<CollateralPlugin> = HyperlaneToken {
        bump: token_bump,
        mailbox: init.mailbox,
        mailbox_process_authority,
        dispatch_authority_bump,
        owner: Some(*payer_account.key),
        interchain_security_module: init.interchain_security_module,
        interchain_gas_paymaster: init.interchain_gas_paymaster,
        destination_gas: HashMap::new(),
        decimals: init.decimals,
        remote_decimals: init.remote_decimals,
        remote_routers: HashMap::new(),
        plugin_data,
    };
    let token_account_data = HyperlaneTokenAccount::<CollateralPlugin>::from(token);

    // Create token account PDA
    create_pda_account(
        payer_account,
        &rent,
        token_account_data.size(),
        program_id,
        system_program_info,
        token_account,
        hyperlane_token_pda_seeds!(token_bump),
    )?;

    // Create dispatch authority PDA (0 bytes)
    create_pda_account(
        payer_account,
        &rent,
        0,
        program_id,
        system_program_info,
        dispatch_authority_account,
        mailbox_message_dispatch_authority_pda_seeds!(dispatch_authority_bump),
    )?;

    token_account_data.store(token_account, false)?;

    // Build and store CrossCollateralState
    let cc_state = CrossCollateralState {
        bump: cc_state_bump,
        dispatch_authority_bump: cc_dispatch_authority_bump,
        local_domain: init.local_domain,
        enrolled_routers: HashMap::new(),
    };
    let cc_state_account_data = CrossCollateralStateAccount::from(cc_state);

    // Create CC state PDA
    create_pda_account(
        payer_account,
        &rent,
        cc_state_account_data.size(),
        program_id,
        system_program_info,
        cc_state_account,
        cross_collateral_pda_seeds!(cc_state_bump),
    )?;

    cc_state_account_data.store(cc_state_account, false)?;

    // Create CC dispatch authority PDA (0 bytes)
    create_pda_account(
        payer_account,
        &rent,
        0,
        program_id,
        system_program_info,
        cc_dispatch_authority_account,
        cross_collateral_dispatch_authority_pda_seeds!(cc_dispatch_authority_bump),
    )?;

    Ok(())
}
