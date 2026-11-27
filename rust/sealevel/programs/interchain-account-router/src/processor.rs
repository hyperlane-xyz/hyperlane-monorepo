//! Mailbox-authenticated execution and outbound dispatch.

use access_control::AccessControl;
use account_utils::{create_pda_account, verify_account_uninitialized, SizedData};
use borsh::BorshDeserialize;
use hyperlane_core::H256;
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use hyperlane_sealevel_mailbox::{
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_loader_v3_interface::{get_program_data_address, state::UpgradeableLoaderState};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{
        config_address, interchain_account_address, RouterConfig, RouterConfigAccount, CONFIG_SEEDS,
    },
    instruction::{
        CallRemote, CallRemoteWithOverrides, Instruction as RouterInstruction, RemoteRouterAndIsm,
    },
    interchain_account_seeds,
    message::{Call, InterchainAccountMessage, SealevelCallData},
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Version-query marker.
pub struct InterchainAccountRouterProgram;
impl package_versioned::PackageVersioned for InterchainAccountRouterProgram {}

/// Router program entrypoint.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if package_versioned::is_get_program_version(data) {
        return package_versioned::process_get_program_version::<InterchainAccountRouterProgram>();
    }
    if let Ok(instruction) = MessageRecipientInstruction::decode(data) {
        return match instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                set_return_data(&borsh::to_vec(&Some(*program_id))?);
                Ok(())
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                return_metas(vec![])
            }
            MessageRecipientInstruction::Handle(handle) => {
                handle_message(program_id, accounts, handle)
            }
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                return_metas(handle_account_metas(program_id, &handle)?)
            }
        };
    }
    if let Ok(instruction) = InterchainSecurityModuleInstruction::decode(data) {
        return crate::ism::process_instruction(program_id, accounts, instruction);
    }
    match RouterInstruction::try_from_slice(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?
    {
        RouterInstruction::Init => initialize(program_id, accounts),
        RouterInstruction::CallRemote(call) => call_remote(program_id, accounts, call),
        RouterInstruction::CallRemoteWithOverrides(call) => {
            call_remote_with_overrides(program_id, accounts, call)
        }
        RouterInstruction::EnrollRemoteRouter(domain, router) => {
            enroll_remote_router(program_id, accounts, domain, router)
        }
        RouterInstruction::EnrollRemoteRouters(routers) => {
            enroll_remote_routers(program_id, accounts, routers)
        }
        RouterInstruction::EnrollRemoteRouterAndIsm(remote) => {
            enroll_remote_router_and_ism(program_id, accounts, remote)
        }
        RouterInstruction::EnrollRemoteRouterAndIsms(remotes) => {
            enroll_remote_router_and_isms(program_id, accounts, remotes)
        }
        RouterInstruction::UnenrollRemoteRouter(domain) => {
            unenroll_remote_router(program_id, accounts, domain)
        }
        RouterInstruction::UnenrollRemoteRouters(domains) => {
            unenroll_remote_routers(program_id, accounts, domains)
        }
        RouterInstruction::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
        instruction @ (RouterInstruction::GetOwner
        | RouterInstruction::Routers(_)
        | RouterInstruction::Isms(_)
        | RouterInstruction::Domains) => query_router(program_id, accounts, instruction),
    }
}

/// Accounts: system, payer, config, canonical loader ProgramData, upgrade authority, mailbox.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [system, payer, config, program_data, authority, mailbox] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (key, bump) = config_address(program_id);
    if system.key != &system_program::ID || config.key != &key || !mailbox.executable {
        return Err(ProgramError::InvalidArgument);
    }
    if !payer.is_signer || !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if program_data.key != &get_program_data_address(program_id)
        || program_data.owner != &solana_sdk_ids::bpf_loader_upgradeable::ID
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let state = bincode::deserialize(&program_data.try_borrow_data()?)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    match state {
        UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: Some(expected),
            ..
        } if expected == *authority.key => {}
        _ => return Err(ProgramError::MissingRequiredSignature),
    }
    verify_account_uninitialized(config)?;
    let state = RouterConfigAccount::from(RouterConfig {
        mailbox: *mailbox.key,
        owner: Some(*authority.key),
        ..RouterConfig::default()
    });
    let bump_seed = [bump];
    let mut seeds = CONFIG_SEEDS.to_vec();
    seeds.push(&bump_seed);
    create_pda_account(
        payer,
        &Rent::get()?,
        state.size(),
        program_id,
        system,
        config,
        &seeds,
    )?;
    state.store(config, false)?;
    msg!("Initialized ICA router with mailbox {}", mailbox.key);
    Ok(())
}

/// Enrolls a remote router with a zero ISM, matching EVM.
/// Accounts: system, writable config, signer/writable owner.
fn enroll_remote_router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
    router: H256,
) -> ProgramResult {
    enroll_remote_router_and_ism(
        program_id,
        accounts,
        RemoteRouterAndIsm {
            domain,
            router,
            ism: H256::zero(),
        },
    )
}

/// Enrolls remote routers with zero ISMs. Same accounts as `enroll_remote_router`.
fn enroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    routers: Vec<(u32, H256)>,
) -> ProgramResult {
    let remotes = routers
        .into_iter()
        .map(|(domain, router)| RemoteRouterAndIsm {
            domain,
            router,
            ism: H256::zero(),
        })
        .collect();
    enroll_remote_router_and_isms(program_id, accounts, remotes)
}

/// Enrolls a router/ISM pair. Same accounts as `enroll_remote_router`.
fn enroll_remote_router_and_ism(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    remote: RemoteRouterAndIsm,
) -> ProgramResult {
    enroll_remote_router_and_isms(program_id, accounts, vec![remote])
}

/// Enrolls router/ISM pairs atomically, following the Hyp token enrollment pattern.
/// Accounts: system, writable config, signer/writable owner (funds additional rent).
fn enroll_remote_router_and_isms(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    remotes: Vec<RemoteRouterAndIsm>,
) -> ProgramResult {
    let [system, config_info, owner] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if system.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut config = RouterConfig::load(program_id, config_info)?;
    config.ensure_owner_signer(owner)?;
    for remote in remotes {
        config.enroll(remote.domain, remote.router, remote.ism)?;
    }
    RouterConfigAccount::from(config).store_with_rent_exempt_realloc(
        config_info,
        &Rent::get()?,
        owner,
        system,
    )
}

/// Removes one router while retaining its ISM. Same accounts as `enroll_remote_router`.
fn unenroll_remote_router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
) -> ProgramResult {
    unenroll_remote_routers(program_id, accounts, vec![domain])
}

/// Removes routers atomically. Accounts: system, writable config, signer/writable owner.
fn unenroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domains: Vec<u32>,
) -> ProgramResult {
    let [system, config_info, owner] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if system.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut config = RouterConfig::load(program_id, config_info)?;
    config.ensure_owner_signer(owner)?;
    for domain in domains {
        config.unenroll(domain)?;
    }
    RouterConfigAccount::from(config).store_with_rent_exempt_realloc(
        config_info,
        &Rent::get()?,
        owner,
        system,
    )
}

/// Transfers or renounces router ownership using shared access control.
/// Accounts: system, writable config, signer/writable current owner.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let [system, config_info, owner] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if system.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut config = RouterConfig::load(program_id, config_info)?;
    config.transfer_ownership(owner, new_owner)?;
    RouterConfigAccount::from(config).store_with_rent_exempt_realloc(
        config_info,
        &Rent::get()?,
        owner,
        system,
    )
}

/// Getters take only the canonical config account, read-only.
fn query_router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: RouterInstruction,
) -> ProgramResult {
    let [config_info] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let config = RouterConfig::load(program_id, config_info)?;
    let data = match instruction {
        RouterInstruction::GetOwner => borsh::to_vec(&SimulationReturnData::new(config.owner))?,
        RouterInstruction::Routers(domain) => {
            borsh::to_vec(&SimulationReturnData::new(config.router(domain)))?
        }
        RouterInstruction::Isms(domain) => {
            borsh::to_vec(&SimulationReturnData::new(config.ism(domain)))?
        }
        RouterInstruction::Domains => {
            let mut domains: Vec<_> = config.routers.keys().copied().collect();
            domains.sort_unstable();
            borsh::to_vec(&SimulationReturnData::new(domains))?
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    set_return_data(&data);
    Ok(())
}

fn native_instruction(call: Call, ica: &Pubkey) -> Result<Instruction, ProgramError> {
    if !call.value.is_zero() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let data = SealevelCallData::try_from_slice(&call.data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    // Never lend the relayer's or mailbox's signature to remote code. Even an
    // account signed elsewhere in the transaction must not become an ICA signer.
    if data
        .accounts
        .iter()
        .any(|meta| meta.is_signer && &meta.pubkey != ica)
    {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(Instruction {
        program_id: Pubkey::new_from_array(call.to.0),
        accounts: data.accounts.into_iter().map(Into::into).collect(),
        data: data.data,
    })
}

/// Returns the config, ICA authority, and deduplicated target accounts for Handle.
/// The mailbox prepends its process authority, as for Hyp token handlers.
/// Each CPI restores its own authenticated account order and privileges.
pub fn handle_account_metas(
    program_id: &Pubkey,
    handle: &HandleInstruction,
) -> Result<Vec<AccountMeta>, ProgramError> {
    let body = InterchainAccountMessage::decode(&handle.message)?;
    let (ica, _) = interchain_account_address(
        program_id,
        handle.origin,
        &body.owner,
        &handle.sender,
        &body.ism,
        &body.salt,
    );
    let mut metas = vec![
        AccountMeta::new_readonly(config_address(program_id).0, false),
        AccountMeta::new_readonly(ica, false),
    ];
    for call in body.calls {
        let instruction = native_instruction(call, &ica)?;
        for mut meta in std::iter::once(AccountMeta::new_readonly(instruction.program_id, false))
            .chain(instruction.accounts)
        {
            meta.is_signer = false;
            if let Some(existing) = metas
                .iter_mut()
                .find(|existing| existing.pubkey == meta.pubkey)
            {
                existing.is_writable |= meta.is_writable;
            } else {
                metas.push(meta);
            }
        }
    }
    Ok(metas)
}

fn return_metas(metas: Vec<AccountMeta>) -> ProgramResult {
    let metas: Vec<SerializableAccountMeta> = metas.into_iter().map(Into::into).collect();
    set_return_data(&borsh::to_vec(&SimulationReturnData::new(metas))?);
    Ok(())
}

/// Authenticates the mailbox and executes the batch atomically during delivery.
/// Calls back into the active mailbox are unsupported: Solana rejects indirect
/// reentrancy, including outbound dispatch through this router or a warp route.
fn handle_message(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleInstruction,
) -> ProgramResult {
    let [process_authority, config, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let mailbox = RouterConfig::load_mailbox(program_id, config)?;
    let (expected, _) =
        Pubkey::find_program_address(mailbox_process_authority_pda_seeds!(program_id), &mailbox);
    if process_authority.key != &expected {
        return Err(ProgramError::InvalidArgument);
    }
    if !process_authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let body = InterchainAccountMessage::decode(&handle.message)?;
    let (ica, bump) = interchain_account_address(
        program_id,
        handle.origin,
        &body.owner,
        &handle.sender,
        &body.ism,
        &body.salt,
    );
    if authority.key != &ica {
        return Err(ProgramError::InvalidArgument);
    }
    let seeds = interchain_account_seeds!(
        handle.origin,
        body.owner,
        handle.sender,
        body.ism,
        body.salt,
        bump
    );
    for call in body.calls {
        let instruction = native_instruction(call, &ica)?;
        // The runtime resolves accounts by pubkey and applies the instruction's
        // authenticated order and privileges, regardless of this slice's order.
        invoke_signed(&instruction, accounts, &[seeds])?;
    }
    msg!("Executed ICA calls for {}", ica);
    Ok(())
}

/// Resolves enrolled defaults and delegates to the explicit-override path, as on EVM.
fn call_remote(program_id: &Pubkey, accounts: &[AccountInfo], call: CallRemote) -> ProgramResult {
    let config_info = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let config = RouterConfig::load(program_id, config_info)?;
    call_remote_with_overrides(
        program_id,
        accounts,
        CallRemoteWithOverrides {
            destination: call.destination,
            router: config.router(call.destination),
            ism: config.ism(call.destination),
            calls: call.calls,
            salt: H256::zero(),
        },
    )
}

/// Accounts: config, owner (signer), mailbox, followed by the seven mailbox
/// dispatch accounts. Explicit overrides bypass enrollment, matching EVM.
fn call_remote_with_overrides(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    call: CallRemoteWithOverrides,
) -> ProgramResult {
    let [config, owner, mailbox, outbox, dispatch_authority, system, noop, payer, unique, dispatched] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let configured_mailbox = RouterConfig::load_mailbox(program_id, config)?;
    if call.router == H256::zero() {
        return Err(ProgramError::InvalidArgument);
    }
    if !owner.is_signer || !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if mailbox.key != &configured_mailbox || !mailbox.executable {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (authority, bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if dispatch_authority.key != &authority {
        return Err(ProgramError::InvalidArgument);
    }
    let message = InterchainAccountMessage {
        owner: owner.key.to_bytes().into(),
        ism: call.ism,
        salt: call.salt,
        calls: call.calls,
    };
    let data = MailboxInstruction::OutboxDispatch(OutboxDispatch {
        sender: *program_id,
        destination_domain: call.destination,
        recipient: call.router,
        message_body: message.encode(),
    })
    .into_instruction_data()?;
    let metas = vec![
        AccountMeta::new(*outbox.key, false),
        AccountMeta::new_readonly(*dispatch_authority.key, true),
        AccountMeta::new_readonly(*system.key, false),
        AccountMeta::new_readonly(*noop.key, false),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*unique.key, true),
        AccountMeta::new(*dispatched.key, false),
    ];
    // Forward the caller's unique signer. The mailbox verifies its signature
    // and message-storage PDA, matching Hyp token dispatch.
    invoke_signed(
        &Instruction {
            program_id: configured_mailbox,
            accounts: metas,
            data,
        },
        &accounts[3..],
        &[mailbox_message_dispatch_authority_pda_seeds!(bump)],
    )?;
    // Preserve the mailbox's message-ID return data.
    msg!(
        "Dispatched ICA calls to {} for {}",
        call.destination,
        owner.key
    );
    Ok(())
}
