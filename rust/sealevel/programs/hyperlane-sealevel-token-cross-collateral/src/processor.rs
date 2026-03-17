//! Program processor.

use access_control::AccessControl;
use account_utils::{create_pda_account, DiscriminatorDecode, SizedData};
use hyperlane_core::Decode;
use hyperlane_sealevel_connection_client::{
    router::RemoteRouterConfig, HyperlaneConnectionClientRecipient,
};
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
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::AccountMeta,
    msg,
    program::set_return_data,
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
            CrossCollateralInstruction::SetCrossCollateralRouters(configs) => {
                set_cross_collateral_routers(program_id, accounts, configs)
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
            MessageRecipientInstruction::Handle(handle) => transfer_from_remote_cc(
                program_id,
                accounts,
                HandleInstruction {
                    origin: handle.origin,
                    sender: handle.sender,
                    message: handle.message,
                },
            ),
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                transfer_from_remote_account_metas_cc(
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

/// Sets cross-collateral routers. Owner-only.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writable]` The CC state PDA account.
/// 2. `[]` The token PDA account.
/// 3. `[signer]` The owner.
fn set_cross_collateral_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<RemoteRouterConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: CC state PDA
    let cc_state_account = next_account_info(accounts_iter)?;
    let mut cc_state =
        CrossCollateralState::verify_account_and_fetch_inner(program_id, cc_state_account)?;

    // Account 2: Token PDA (for owner verification)
    let token_account = next_account_info(accounts_iter)?;
    let token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        token_account,
    )?;

    // Account 3: Owner (signer)
    let owner_account = next_account_info(accounts_iter)?;
    token.ensure_owner_signer(owner_account)?;

    // Apply configs
    for config in configs {
        match config.router {
            Some(router) => {
                cc_state
                    .enrolled_routers
                    .entry(config.domain)
                    .or_default()
                    .insert(router);

                msg!(
                    "Enrolled CC router {:?} for domain {}",
                    router,
                    config.domain
                );
            }
            None => {
                cc_state.enrolled_routers.remove(&config.domain);
                msg!("Unenrolled all CC routers for domain {}", config.domain);
            }
        }
    }

    // Store updated CC state with realloc if needed
    CrossCollateralStateAccount::from(cc_state).store_with_rent_exempt_realloc(
        cc_state_account,
        &Rent::get()?,
        owner_account,
        system_program_info,
    )?;

    Ok(())
}

/// Handles an inbound message from the mailbox with dual-router validation.
/// Mirrors base `transfer_from_remote` but checks both CC enrolled routers
/// and standard remote routers.
///
/// Accounts:
/// 0.    `[signer]` Mailbox process authority specific to this program.
/// 1.    `[executable]` system_program
/// 2.    `[]` hyperlane_token storage
/// 3.    `[]` CC state PDA account.
/// 4.    `[depends on plugin]` recipient wallet address
///       5..N `[??..??]` Plugin-specific accounts (CollateralPlugin::transfer_out).
fn transfer_from_remote_cc(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let mut message_reader = std::io::Cursor::new(xfer.message);
    let message = TokenMessage::read_from(&mut message_reader)
        .map_err(|_err| ProgramError::from(Error::ExtraneousAccount))?;

    // Account 0: Mailbox process authority
    let process_authority_account = next_account_info(accounts_iter)?;

    // Account 1: System program
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 2: Token account
    let token_account = next_account_info(accounts_iter)?;
    let token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        token_account,
    )?;

    // Account 3: CC state PDA
    let cc_state_account = next_account_info(accounts_iter)?;
    let cc_state =
        CrossCollateralState::verify_account_and_fetch_inner(program_id, cc_state_account)?;

    // Verify mailbox process authority is a valid signer
    token.ensure_mailbox_process_authority_signer(process_authority_account)?;

    // Dual-router validation: check both CC enrolled routers and base remote routers
    if !cc_state.is_authorized_router(xfer.origin, &xfer.sender, &token.remote_routers) {
        return Err(Error::UnauthorizedRouter.into());
    }

    // Account 4: Recipient wallet
    let recipient_wallet = next_account_info(accounts_iter)?;
    let expected_recipient = Pubkey::new_from_array(message.recipient().into());
    if recipient_wallet.key != &expected_recipient {
        return Err(ProgramError::InvalidArgument);
    }

    // Convert remote amount to local decimals
    let remote_amount = message.amount();
    let local_amount: u64 = token.remote_amount_to_local_amount(remote_amount)?;

    // Accounts 5..N: Transfer out via plugin
    CollateralPlugin::transfer_out(
        program_id,
        &token,
        system_program_info,
        recipient_wallet,
        accounts_iter,
        local_amount,
    )?;

    // Extraneous account check (must follow transfer_out which consumes dynamic accounts)
    if accounts_iter.next().is_some() {
        return Err(Error::ExtraneousAccount.into());
    }

    msg!(
        "CC warp route transfer completed from origin: {}, recipient: {}, remote_amount: {}",
        xfer.origin,
        recipient_wallet.key,
        remote_amount
    );

    Ok(())
}

/// Gets the account metas required by the CC Handle instruction.
/// Same as base but includes CC state PDA after token account.
///
/// Accounts:
/// 0. `[]` The token PDA account.
fn transfer_from_remote_account_metas_cc(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let mut message_reader = std::io::Cursor::new(transfer.message);
    let message = TokenMessage::read_from(&mut message_reader)
        .map_err(|_err| ProgramError::from(Error::ExtraneousAccount))?;

    // Account 0: Token account
    let token_account_info = next_account_info(accounts_iter)?;
    let token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        token_account_info,
    )?;

    let (transfer_out_account_metas, writeable_recipient) =
        CollateralPlugin::transfer_out_account_metas(program_id, &token, &message)?;

    let (cc_state_key, _cc_state_bump) =
        Pubkey::find_program_address(cross_collateral_pda_seeds!(), program_id);

    let mut account_metas: Vec<SerializableAccountMeta> = vec![
        AccountMeta::new_readonly(system_program::ID, false).into(),
        AccountMeta::new_readonly(*token_account_info.key, false).into(),
        // CC state PDA inserted before recipient
        AccountMeta::new_readonly(cc_state_key, false).into(),
        AccountMeta {
            pubkey: Pubkey::new_from_array(message.recipient().into()),
            is_signer: false,
            is_writable: writeable_recipient,
        }
        .into(),
    ];
    account_metas.extend(transfer_out_account_metas);

    let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
        .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes[..]);

    Ok(())
}
