//! Program processor.

use borsh::BorshDeserialize;

use access_control::AccessControl;
use account_utils::{
    create_pda_account, DiscriminatorDecode, DiscriminatorEncode, SizedData, SPL_NOOP_PROGRAM_ID,
};
use hyperlane_core::{Decode, Encode, H256};
use hyperlane_sealevel_connection_client::gas_router::HyperlaneGasRouter;
use hyperlane_sealevel_connection_client::{
    HyperlaneConnectionClient, HyperlaneConnectionClientRecipient,
};
use hyperlane_sealevel_igp::{
    accounts::InterchainGasPaymasterType,
    instruction::{Instruction as IgpInstruction, PayForGas as IgpPayForGas},
};
use hyperlane_sealevel_mailbox::{
    accounts::Outbox,
    instruction::{Instruction as MailboxInstruction, OutboxDispatch as MailboxOutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    instruction::{Init, Instruction as TokenIxn},
    processor::{HyperlaneSealevelToken, HyperlaneSealevelTokenPlugin},
};
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{get_return_data, invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;
use std::collections::{BTreeMap, HashMap};

use crate::{
    accounts::{CrossCollateralState, CrossCollateralStateAccount},
    cross_collateral_dispatch_authority_pda_seeds, cross_collateral_pda_seeds,
    error::Error as CcError,
    instruction::{
        CrossCollateralInstruction, CrossCollateralRouterUpdate, HandleLocal, TransferRemoteTo,
    },
    plugin::CollateralPlugin,
};
use hyperlane_sealevel_token_lib::error::Error as TokenError;

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
            CrossCollateralInstruction::SetCrossCollateralRouters(configs) => {
                set_cross_collateral_routers(program_id, accounts, configs)
            }
            CrossCollateralInstruction::TransferRemoteTo(transfer) => {
                transfer_remote_to(program_id, accounts, transfer)
            }
            CrossCollateralInstruction::HandleLocal(handle) => {
                handle_local(program_id, accounts, handle)
            }
            CrossCollateralInstruction::HandleLocalAccountMetas(handle) => {
                handle_local_account_metas(program_id, accounts, handle)
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
    match TokenIxn::decode(instruction_data)? {
        TokenIxn::Init(init) => initialize(program_id, accounts, init),
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
/// 11. `[]` The mailbox outbox PDA account (to read local_domain).
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
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
        return Err(ProgramError::InvalidArgument);
    }
    if !token_account.data_is_empty() || token_account.owner != &system_program::ID {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Account 2: Dispatch authority PDA
    let dispatch_authority_account = next_account_info(accounts_iter)?;
    let (dispatch_authority_key, dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if *dispatch_authority_account.key != dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
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
        return Err(ProgramError::InvalidArgument);
    }
    if !cc_state_account.data_is_empty() || cc_state_account.owner != &system_program::ID {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Account 10: CC dispatch authority PDA
    let cc_dispatch_authority_account = next_account_info(accounts_iter)?;
    let (cc_dispatch_authority_key, cc_dispatch_authority_bump) =
        Pubkey::find_program_address(cross_collateral_dispatch_authority_pda_seeds!(), program_id);
    if cc_dispatch_authority_account.key != &cc_dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
    }
    if !cc_dispatch_authority_account.data_is_empty()
        || cc_dispatch_authority_account.owner != &system_program::ID
    {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Account 11: Mailbox outbox PDA — read local_domain from mailbox
    let mailbox_outbox_account = next_account_info(accounts_iter)?;
    let outbox = Outbox::verify_account_and_fetch_inner(&init.mailbox, mailbox_outbox_account)?;
    let local_domain = outbox.local_domain;

    // Extraneous account check
    if accounts_iter.next().is_some() {
        return Err(TokenError::ExtraneousAccount.into());
    }

    let rent = Rent::get()?;

    // Build and store HyperlaneToken<CollateralPlugin>
    let hyperlane_token: HyperlaneToken<CollateralPlugin> = HyperlaneToken {
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
    let hyperlane_token_account_data =
        HyperlaneTokenAccount::<CollateralPlugin>::from(hyperlane_token);

    // Create token account PDA
    create_pda_account(
        payer_account,
        &rent,
        hyperlane_token_account_data.size(),
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

    hyperlane_token_account_data.store(token_account, false)?;

    // Build and store CrossCollateralState
    let cc_state = CrossCollateralState {
        bump: cc_state_bump,
        dispatch_authority_bump: cc_dispatch_authority_bump,
        local_domain,
        enrolled_routers: BTreeMap::new(),
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
    updates: Vec<CrossCollateralRouterUpdate>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: CC state PDA
    let cc_state_account = next_account_info(accounts_iter)?;
    let mut cc_state =
        CrossCollateralState::verify_account_and_fetch_inner(program_id, cc_state_account)?;

    // Account 2: Token PDA (for owner verification)
    let hyperlane_token_account = next_account_info(accounts_iter)?;
    let hyperlane_token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        hyperlane_token_account,
    )?;

    // Account 3: Owner (signer)
    let owner_account = next_account_info(accounts_iter)?;
    hyperlane_token.ensure_owner_signer(owner_account)?;

    // Extraneous account check
    if accounts_iter.next().is_some() {
        return Err(TokenError::ExtraneousAccount.into());
    }

    // Apply updates
    for update in updates {
        match update {
            CrossCollateralRouterUpdate::Add { domain, router } => {
                cc_state
                    .enrolled_routers
                    .entry(domain)
                    .or_default()
                    .insert(router);

                msg!("Enrolled CC router {:?} for domain {}", router, domain);
            }
            CrossCollateralRouterUpdate::Remove(config) => match config.router {
                Some(router) => {
                    if let Some(routers) = cc_state.enrolled_routers.get_mut(&config.domain) {
                        routers.remove(&router);
                        if routers.is_empty() {
                            cc_state.enrolled_routers.remove(&config.domain);
                        }
                    }
                    msg!(
                        "Removed CC router {:?} from domain {}",
                        router,
                        config.domain
                    );
                }
                None => {
                    cc_state.enrolled_routers.remove(&config.domain);
                    msg!("Removed all CC routers for domain {}", config.domain);
                }
            },
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

/// Transfers tokens to a specific enrolled router. Branches based on destination:
/// - If `destination_domain == local_domain`: same-chain CPI into target's HandleLocal
/// - Otherwise: cross-chain dispatch via the mailbox
///
/// Shared accounts (always present):
/// 0.    `[executable]` system program
/// 1.    `[]` token PDA
/// 2.    `[]` CC state PDA
///
/// Remote path (destination_domain != local_domain):
/// 3.    `[executable]` SPL Noop
/// 4.    `[executable]` mailbox program
/// 5.    `[]` mailbox outbox
/// 6.    `[]` dispatch authority PDA
/// 7.    `[signer]` sender wallet / mailbox payer
/// 8.    `[signer]` unique message account
/// 9.    `[writable]` dispatched message PDA
///       10..N IGP accounts (optional), then plugin transfer_in accounts.
///
/// Local path (destination_domain == local_domain):
/// 3.    `[signer]` sender wallet / payer
/// 4.    `[]` CC dispatch authority PDA (this program's, for CPI signing)
/// 5.    `[executable]` target program
///       6..N plugin transfer_in accounts.
///       N+1..M target HandleLocal accounts (passthrough for CPI).
#[allow(clippy::too_many_lines)]
fn transfer_remote_to(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: TransferRemoteTo,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // === Shared prefix ===

    // Account 0: System program
    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 1: Token storage account
    let hyperlane_token_account = next_account_info(accounts_iter)?;
    let hyperlane_token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        hyperlane_token_account,
    )?;

    // Account 2: CC state PDA
    let cc_state_account = next_account_info(accounts_iter)?;
    let cc_state =
        CrossCollateralState::verify_account_and_fetch_inner(program_id, cc_state_account)?;

    // Validate target_router is authorized (checks both CC enrolled and base routers)
    if !cc_state.is_authorized_router(
        xfer.destination_domain,
        &xfer.target_router,
        &hyperlane_token.remote_routers,
    ) {
        return Err(CcError::UnauthorizedRouter.into());
    }

    // Branch: local (same-chain CPI) vs remote (mailbox dispatch).
    // Account layouts diverge after the shared prefix. Each branch validates
    // its own accounts independently, so cross-branch confusion is not possible.
    if cc_state.local_domain == xfer.destination_domain {
        transfer_remote_to_local(program_id, &hyperlane_token, &cc_state, accounts_iter, xfer)
    } else {
        transfer_remote_to_remote(
            program_id,
            &hyperlane_token,
            system_program_account,
            accounts_iter,
            xfer,
        )
    }
}

/// Remote path of transfer_remote_to: escrows tokens and dispatches cross-chain via the mailbox.
/// Called when `destination_domain != local_domain`. Continues consuming from the shared
/// accounts iterator after the prefix (system_program, token PDA, CC state) parsed by
/// transfer_remote_to.
///
/// Accounts consumed from iterator:
/// 3.    `[executable]` SPL Noop
/// 4.    `[executable]` mailbox program
/// 5.    `[]` mailbox outbox
/// 6.    `[]` dispatch authority PDA
/// 7.    `[signer]` sender wallet / mailbox payer
/// 8.    `[signer]` unique message account
/// 9.    `[writable]` dispatched message PDA
///       10..N IGP accounts (optional), then plugin transfer_in accounts.
#[allow(clippy::too_many_lines)]
fn transfer_remote_to_remote<'account_info_slice, 'account_info>(
    program_id: &Pubkey,
    hyperlane_token: &HyperlaneToken<CollateralPlugin>,
    system_program_account: &'account_info_slice AccountInfo<'account_info>,
    accounts_iter: &mut std::slice::Iter<'account_info_slice, AccountInfo<'account_info>>,
    xfer: TransferRemoteTo,
) -> ProgramResult {
    // Account 3: SPL Noop
    let spl_noop = next_account_info(accounts_iter)?;
    if spl_noop.key != &SPL_NOOP_PROGRAM_ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 4: Mailbox program
    let mailbox_info = next_account_info(accounts_iter)?;
    if mailbox_info.key != &hyperlane_token.mailbox {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 5: Mailbox outbox (verified by mailbox)
    let mailbox_outbox_account = next_account_info(accounts_iter)?;

    // Account 6: Dispatch authority PDA
    let dispatch_authority_account = next_account_info(accounts_iter)?;
    let dispatch_authority_seeds: &[&[u8]] =
        mailbox_message_dispatch_authority_pda_seeds!(hyperlane_token.dispatch_authority_bump);
    let dispatch_authority_key =
        Pubkey::create_program_address(dispatch_authority_seeds, program_id)?;
    if *dispatch_authority_account.key != dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 7: Sender wallet (signer + payer)
    let sender_wallet = next_account_info(accounts_iter)?;
    if !sender_wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 8: Unique message / gas payment account
    let unique_message_account = next_account_info(accounts_iter)?;

    // Account 9: Dispatched message PDA
    let dispatched_message_pda = next_account_info(accounts_iter)?;

    // Accounts 10..N: IGP accounts (optional)
    let igp_payment_accounts = if let Some((igp_program_id, igp_account_type)) =
        hyperlane_token.interchain_gas_paymaster()
    {
        let igp_program_account = next_account_info(accounts_iter)?;
        if igp_program_account.key != igp_program_id {
            return Err(ProgramError::InvalidArgument);
        }

        let igp_program_data_account = next_account_info(accounts_iter)?;
        let igp_payment_pda_account = next_account_info(accounts_iter)?;

        let configured_igp_account = next_account_info(accounts_iter)?;
        if configured_igp_account.key != igp_account_type.key() {
            return Err(ProgramError::InvalidArgument);
        }

        let mut igp_payment_account_metas = vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(*sender_wallet.key, true),
            AccountMeta::new(*igp_program_data_account.key, false),
            AccountMeta::new_readonly(*unique_message_account.key, true),
            AccountMeta::new(*igp_payment_pda_account.key, false),
        ];
        let mut igp_payment_account_infos = vec![
            system_program_account.clone(),
            sender_wallet.clone(),
            igp_program_data_account.clone(),
            unique_message_account.clone(),
            igp_payment_pda_account.clone(),
        ];

        match igp_account_type {
            InterchainGasPaymasterType::Igp(_) => {
                igp_payment_account_metas
                    .push(AccountMeta::new(*configured_igp_account.key, false));
                igp_payment_account_infos.push(configured_igp_account.clone());
            }
            InterchainGasPaymasterType::OverheadIgp(_) => {
                let inner_igp_account = next_account_info(accounts_iter)?;
                igp_payment_account_metas.extend([
                    AccountMeta::new(*inner_igp_account.key, false),
                    AccountMeta::new_readonly(*configured_igp_account.key, false),
                ]);
                igp_payment_account_infos
                    .extend([inner_igp_account.clone(), configured_igp_account.clone()]);
            }
        };

        Some((igp_payment_account_metas, igp_payment_account_infos))
    } else {
        None
    };

    // Convert amount to local and remote decimals
    let local_amount: u64 = xfer
        .amount_or_id
        .try_into()
        .map_err(|_| ProgramError::InvalidArgument)?;
    let remote_amount = hyperlane_token.local_amount_to_remote_amount(local_amount)?;

    // Transfer tokens into escrow via plugin
    CollateralPlugin::transfer_in(
        program_id,
        hyperlane_token,
        sender_wallet,
        accounts_iter,
        local_amount,
    )?;

    // Extraneous account check
    if accounts_iter.next().is_some() {
        return Err(TokenError::ExtraneousAccount.into());
    }

    // Build token message body
    let token_transfer_message = TokenMessage::new(xfer.recipient, remote_amount, vec![]).to_vec();

    // Build mailbox dispatch CPI with target_router as recipient (not self.router(domain))
    let dispatch_instruction = MailboxInstruction::OutboxDispatch(MailboxOutboxDispatch {
        sender: *program_id,
        destination_domain: xfer.destination_domain,
        recipient: xfer.target_router,
        message_body: token_transfer_message,
    });
    let dispatch_account_metas = vec![
        AccountMeta::new(*mailbox_outbox_account.key, false),
        AccountMeta::new_readonly(*dispatch_authority_account.key, true),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(SPL_NOOP_PROGRAM_ID, false),
        AccountMeta::new(*sender_wallet.key, true),
        AccountMeta::new_readonly(*unique_message_account.key, true),
        AccountMeta::new(*dispatched_message_pda.key, false),
    ];
    let dispatch_account_infos = &[
        mailbox_outbox_account.clone(),
        dispatch_authority_account.clone(),
        system_program_account.clone(),
        spl_noop.clone(),
        sender_wallet.clone(),
        unique_message_account.clone(),
        dispatched_message_pda.clone(),
    ];

    let mailbox_ixn = Instruction {
        program_id: hyperlane_token.mailbox,
        data: dispatch_instruction
            .into_instruction_data()
            .map_err(|_| ProgramError::BorshIoError)?,
        accounts: dispatch_account_metas,
    };
    invoke_signed(
        &mailbox_ixn,
        dispatch_account_infos,
        &[dispatch_authority_seeds],
    )?;

    // Parse message ID from mailbox return data
    let (returning_program_id, returned_data) =
        get_return_data().ok_or(ProgramError::InvalidArgument)?;
    if returning_program_id != hyperlane_token.mailbox {
        return Err(ProgramError::InvalidArgument);
    }

    // IGP payment if configured
    if let Some((igp_payment_account_metas, igp_payment_account_infos)) = igp_payment_accounts {
        let (igp_program_id, _) = hyperlane_token
            .interchain_gas_paymaster()
            .ok_or(ProgramError::InvalidArgument)?;

        let message_id = hyperlane_core::H256::try_from_slice(&returned_data)
            .map_err(|_| ProgramError::InvalidArgument)?;

        let destination_gas = hyperlane_token
            .destination_gas(xfer.destination_domain)
            .ok_or(ProgramError::InvalidArgument)?;

        let igp_ixn = Instruction::new_with_borsh(
            *igp_program_id,
            &IgpInstruction::PayForGas(IgpPayForGas {
                message_id,
                destination_domain: xfer.destination_domain,
                gas_amount: destination_gas,
            }),
            igp_payment_account_metas,
        );
        invoke(&igp_ixn, &igp_payment_account_infos)?;
    }

    msg!(
        "CC transfer_remote_to completed to destination: {}, target_router: {:?}, remote_amount: {}",
        xfer.destination_domain,
        xfer.target_router,
        remote_amount
    );

    Ok(())
}

/// Local path of transfer_remote_to: escrows tokens and CPIs into target's HandleLocal.
/// Called when `destination_domain == local_domain`. Continues consuming from the shared
/// accounts iterator after the prefix (system_program, token PDA, CC state) parsed by
/// transfer_remote_to.
///
/// Accounts consumed from iterator:
/// 3.    `[signer]` sender wallet / payer
/// 4.    `[]` CC dispatch authority PDA (this program's, for CPI signing)
/// 5.    `[executable]` target program
///       6..N plugin transfer_in accounts.
///       N+1..M target HandleLocal accounts (passthrough for CPI).
fn transfer_remote_to_local(
    program_id: &Pubkey,
    hyperlane_token: &HyperlaneToken<CollateralPlugin>,
    cc_state: &CrossCollateralState,
    accounts_iter: &mut std::slice::Iter<'_, AccountInfo<'_>>,
    xfer: TransferRemoteTo,
) -> ProgramResult {
    // Account 3: Sender wallet (signer)
    let sender_wallet = next_account_info(accounts_iter)?;
    if !sender_wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 4: CC dispatch authority PDA (this program's, for CPI signing)
    let cc_dispatch_authority = next_account_info(accounts_iter)?;
    let cc_da_seeds: &[&[u8]] =
        cross_collateral_dispatch_authority_pda_seeds!(cc_state.dispatch_authority_bump);
    let expected_cc_da = Pubkey::create_program_address(cc_da_seeds, program_id)?;
    if cc_dispatch_authority.key != &expected_cc_da {
        return Err(CcError::InvalidDispatchAuthority.into());
    }

    // Account 5: Target program (executable, for CPI)
    let target_program_info = next_account_info(accounts_iter)?;
    let target_program_key = Pubkey::new_from_array(xfer.target_router.into());
    if target_program_info.key != &target_program_key {
        return Err(ProgramError::InvalidArgument);
    }
    if !target_program_info.executable {
        return Err(ProgramError::InvalidAccountData);
    }

    // Convert amount
    let local_amount: u64 = xfer
        .amount_or_id
        .try_into()
        .map_err(|_| ProgramError::InvalidArgument)?;
    let remote_amount = hyperlane_token.local_amount_to_remote_amount(local_amount)?;

    // Transfer tokens into escrow via plugin
    CollateralPlugin::transfer_in(
        program_id,
        hyperlane_token,
        sender_wallet,
        accounts_iter,
        local_amount,
    )?;

    // Build HandleLocal instruction data
    let token_message = TokenMessage::new(xfer.recipient, remote_amount, vec![]).to_vec();
    let handle_local_data = HandleLocal {
        sender_program_id: *program_id,
        message: token_message,
    };
    let handle_ixn = CrossCollateralInstruction::HandleLocal(handle_local_data);

    // Remaining accounts: target's HandleLocal accounts (passthrough)
    let remaining_accounts: Vec<&AccountInfo> = accounts_iter.collect();

    // Build CPI: CC dispatch authority (signer) + remaining accounts
    let mut cpi_account_metas = vec![AccountMeta::new_readonly(*cc_dispatch_authority.key, true)];
    for acc in remaining_accounts.iter() {
        cpi_account_metas.push(AccountMeta {
            pubkey: *acc.key,
            is_signer: false,
            is_writable: acc.is_writable,
        });
    }

    let mut cpi_account_infos: Vec<AccountInfo> = vec![cc_dispatch_authority.clone()];
    for acc in &remaining_accounts {
        cpi_account_infos.push((*acc).clone());
    }

    let cpi_instruction = Instruction {
        program_id: target_program_key,
        data: handle_ixn
            .encode()
            .map_err(|_| ProgramError::BorshIoError)?,
        accounts: cpi_account_metas,
    };

    invoke_signed(&cpi_instruction, &cpi_account_infos, &[cc_da_seeds])?;

    msg!(
        "CC same-chain transfer completed to target: {}, recipient: {:?}, remote_amount: {}",
        target_program_key,
        xfer.recipient,
        remote_amount,
    );

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
        .map_err(|_err| ProgramError::from(TokenError::MessageDecodeError))?;

    // Account 0: Mailbox process authority
    let process_authority_account = next_account_info(accounts_iter)?;

    // Account 1: System program
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 2: Token account
    let hyperlane_token_account = next_account_info(accounts_iter)?;
    let hyperlane_token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        hyperlane_token_account,
    )?;

    // Account 3: CC state PDA
    let cc_state_account = next_account_info(accounts_iter)?;
    let cc_state =
        CrossCollateralState::verify_account_and_fetch_inner(program_id, cc_state_account)?;

    // Verify mailbox process authority is a valid signer
    hyperlane_token.ensure_mailbox_process_authority_signer(process_authority_account)?;

    // Dual-router validation: check both CC enrolled routers and base remote routers
    if !cc_state.is_authorized_router(xfer.origin, &xfer.sender, &hyperlane_token.remote_routers) {
        return Err(CcError::UnauthorizedRouter.into());
    }

    // Account 4: Recipient wallet
    let recipient_wallet = next_account_info(accounts_iter)?;
    let expected_recipient = Pubkey::new_from_array(message.recipient().into());
    if recipient_wallet.key != &expected_recipient {
        return Err(ProgramError::InvalidArgument);
    }

    // Convert remote amount to local decimals
    let remote_amount = message.amount();
    let local_amount: u64 = hyperlane_token.remote_amount_to_local_amount(remote_amount)?;

    // Accounts 5..N: Transfer out via plugin
    CollateralPlugin::transfer_out(
        program_id,
        &hyperlane_token,
        system_program_info,
        recipient_wallet,
        accounts_iter,
        local_amount,
    )?;

    // Extraneous account check (must follow transfer_out which consumes dynamic accounts)
    if accounts_iter.next().is_some() {
        return Err(TokenError::ExtraneousAccount.into());
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
        .map_err(|_err| ProgramError::from(TokenError::MessageDecodeError))?;

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

/// Handles a same-chain CPI receive from another CC program.
/// PDA verification: re-derives sender's CC dispatch authority PDA
/// from `sender_program_id` and verifies it matches the signer.
///
/// Accounts:
/// 0.    `[signer]` CC dispatch authority PDA of the sending program.
/// 1.    `[executable]` system_program
/// 2.    `[]` token PDA
/// 3.    `[]` CC state PDA
/// 4.    `[depends on plugin]` recipient wallet address
///       5..N `[??..??]` Plugin-specific accounts (CollateralPlugin::transfer_out).
fn handle_local(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleLocal,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let mut message_reader = std::io::Cursor::new(&handle.message);
    let message = TokenMessage::read_from(&mut message_reader)
        .map_err(|_err| ProgramError::from(TokenError::MessageDecodeError))?;

    // Account 0: CC dispatch authority PDA signer (from the sending program)
    let sender_cc_dispatch_authority_signer = next_account_info(accounts_iter)?;

    // PDA verification: re-derive from claimed sender_program_id
    let (expected_dispatch_authority, _) = Pubkey::find_program_address(
        cross_collateral_dispatch_authority_pda_seeds!(),
        &handle.sender_program_id,
    );
    if sender_cc_dispatch_authority_signer.key != &expected_dispatch_authority {
        return Err(CcError::InvalidDispatchAuthority.into());
    }
    if !sender_cc_dispatch_authority_signer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 1: System program
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
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

    // Derive sender H256 from the verified sender_program_id.
    // The PDA signer check above ties the CPI caller to sender_program_id,
    // so we derive the router address from it rather than accepting a separate
    // unvalidated sender field (which would allow spoofing).
    let sender = H256::from(handle.sender_program_id.to_bytes());

    // Validate sender is an authorized router (CC enrolled or base remote routers)
    if !cc_state.is_authorized_router(cc_state.local_domain, &sender, &token.remote_routers) {
        return Err(CcError::UnauthorizedRouter.into());
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

    // Extraneous account check
    if accounts_iter.next().is_some() {
        return Err(TokenError::ExtraneousAccount.into());
    }

    msg!(
        "CC handle_local completed from sender: {}, origin: {}, recipient: {}, remote_amount: {}",
        handle.sender_program_id,
        cc_state.local_domain,
        recipient_wallet.key,
        remote_amount
    );

    Ok(())
}

/// Gets the account metas required by the HandleLocal instruction.
/// Used by off-chain tools to build same-chain transfer transactions.
///
/// Accounts:
/// 0. `[]` The token PDA account.
fn handle_local_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleLocal,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let mut message_reader = std::io::Cursor::new(&handle.message);
    let message = TokenMessage::read_from(&mut message_reader)
        .map_err(|_err| ProgramError::from(TokenError::MessageDecodeError))?;

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

    // CC dispatch authority from the sender program (will be the signer in CPI)
    let (sender_dispatch_authority, _) = Pubkey::find_program_address(
        cross_collateral_dispatch_authority_pda_seeds!(),
        &handle.sender_program_id,
    );

    let mut account_metas: Vec<SerializableAccountMeta> = vec![
        // CC dispatch authority signer from sender
        AccountMeta::new_readonly(sender_dispatch_authority, true).into(),
        AccountMeta::new_readonly(system_program::ID, false).into(),
        AccountMeta::new_readonly(*token_account_info.key, false).into(),
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
