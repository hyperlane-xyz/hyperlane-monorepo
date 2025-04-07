//! HelloWorld program.
#![allow(unexpected_cfgs)]

use access_control::AccessControl;
use account_utils::{create_pda_account, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};

use hyperlane_sealevel_connection_client::{
    router::{HyperlaneRouterAccessControl, HyperlaneRouterDispatch, RemoteRouterConfig},
    HyperlaneConnectionClient,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_mailbox::{
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
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
    system_program,
    sysvar::Sysvar,
};

use crate::{
    accounts::{HelloWorldStorage, HelloWorldStorageAccount},
    instruction::{HelloWorldInstruction, HelloWorldMessage, Init},
};

/// The amount of gas to pay for.
/// TODO: when we actually enforce gas amounts for messages to Solana,
/// we'll need to revisit this and change HelloWorld to use GasRouter.
pub const HANDLE_GAS_AMOUNT: u64 = 50000;

/// Seeds relating to the PDA account with program data.
#[macro_export]
macro_rules! program_storage_pda_seeds {
    () => {{
        &[b"hello_world", b"-", b"handle", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hello_world",
            b"-",
            b"handle",
            b"-",
            b"storage",
            &[$bump_seed],
        ]
    }};
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// The program's entrypoint.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(recipient_instruction) = MessageRecipientInstruction::decode(instruction_data) {
        return match recipient_instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                get_interchain_security_module(program_id, accounts)
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                set_account_meta_return_data(program_id)
            }
            MessageRecipientInstruction::Handle(instruction) => {
                handle(program_id, accounts, instruction)
            }
            MessageRecipientInstruction::HandleAccountMetas(_) => {
                set_account_meta_return_data(program_id)
            }
        };
    }

    let instruction = HelloWorldInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    match instruction {
        HelloWorldInstruction::Init(mailbox) => init(program_id, accounts, mailbox),
        HelloWorldInstruction::SendHelloWorld(hello_world) => {
            send_hello_world(program_id, accounts, hello_world)
        }
        HelloWorldInstruction::SetInterchainSecurityModule(ism) => {
            set_interchain_security_module(program_id, accounts, ism)
        }
        HelloWorldInstruction::EnrollRemoteRouters(configs) => {
            enroll_remote_routers(program_id, accounts, configs)
        }
    }
}

/// Creates the storage PDA.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[signer]` Payer.
/// 2. `[writeable]` Storage PDA.
fn init(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Payer.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_pda_bump_seed) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }

    let storage_account = HelloWorldStorageAccount::from(HelloWorldStorage {
        local_domain: init.local_domain,
        mailbox: init.mailbox,
        ism: init.ism,
        igp: init.igp,
        owner: init.owner,
        ..Default::default()
    });
    create_pda_account(
        payer_info,
        &Rent::get()?,
        storage_account.size(),
        program_id,
        system_program_info,
        storage_info,
        program_storage_pda_seeds!(storage_pda_bump_seed),
    )?;
    // Store it
    storage_account.store(storage_info, false)?;

    Ok(())
}

/// Dispatches a message using the dispatch authority.
///
/// Accounts:
/// 0.  `[writeable]` Program storage.
/// 1.  `[executable]` The Mailbox program.
/// 2.  `[writeable]` Outbox PDA.
/// 3.  `[]` This program's dispatch authority.
/// 4.  `[executable]` System program.
/// 5.  `[executable]` SPL Noop program.
/// 6.  `[signer]` Payer.
/// 7.  `[signer]` Unique message account.
/// 8.  `[writeable]` Dispatched message PDA. An empty message PDA relating to the seeds
///     `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
///     ---- if an IGP is configured ----
/// 9.  `[executable]` The IGP program.
/// 10. `[writeable]` The IGP program data.
/// 11. `[writeable]` The gas payment PDA.
/// 12. `[]` OPTIONAL - The Overhead IGP program, if the configured IGP is an Overhead IGP.
/// 13. `[writeable]` The IGP account.
///     ---- end if an IGP is configured ----
fn send_hello_world(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    hello_world: HelloWorldMessage,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Program storage.
    let storage_info = next_account_info(accounts_iter)?;
    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let mut storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 1: Mailbox program.
    let _mailbox_info = next_account_info(accounts_iter)?;

    // Account 2: Outbox PDA.
    let mailbox_outbox_info = next_account_info(accounts_iter)?;

    // Account 3: Dispatch authority.
    let dispatch_authority_info = next_account_info(accounts_iter)?;
    let (expected_dispatch_authority_key, expected_dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if dispatch_authority_info.key != &expected_dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 4: System program.
    let system_program_info = next_account_info(accounts_iter)?;

    // Account 5: SPL Noop program.
    let spl_noop_info = next_account_info(accounts_iter)?;

    // Account 6: Payer.
    let payer_info = next_account_info(accounts_iter)?;

    // Account 7: Unique message account.
    let unique_message_account_info = next_account_info(accounts_iter)?;

    // Account 8: Dispatched message PDA.
    let dispatched_message_info = next_account_info(accounts_iter)?;

    let dispatch_account_metas = vec![
        AccountMeta::new(*mailbox_outbox_info.key, false),
        AccountMeta::new_readonly(*dispatch_authority_info.key, true),
        AccountMeta::new_readonly(*system_program_info.key, false),
        AccountMeta::new_readonly(*spl_noop_info.key, false),
        AccountMeta::new(*payer_info.key, true),
        AccountMeta::new_readonly(*unique_message_account_info.key, true),
        AccountMeta::new(*dispatched_message_info.key, false),
    ];
    let dispatch_account_infos = &[
        mailbox_outbox_info.clone(),
        dispatch_authority_info.clone(),
        system_program_info.clone(),
        spl_noop_info.clone(),
        payer_info.clone(),
        unique_message_account_info.clone(),
        dispatched_message_info.clone(),
    ];

    let igp_payment_accounts =
        if let Some((igp_program_id, igp_account_type)) = storage.interchain_gas_paymaster() {
            // Account 9: The IGP program
            let igp_program_account_info = next_account_info(accounts_iter)?;
            if igp_program_account_info.key != igp_program_id {
                return Err(ProgramError::InvalidArgument);
            }

            // Account 10: The IGP program data.
            // No verification is performed here, the IGP will do that.
            let igp_program_data_account_info = next_account_info(accounts_iter)?;

            // Account 11: The gas payment PDA.
            // No verification is performed here, the IGP will do that.
            let igp_payment_pda_account_info = next_account_info(accounts_iter)?;

            // Account 12: The configured IGP account.
            let configured_igp_account_info = next_account_info(accounts_iter)?;
            if configured_igp_account_info.key != igp_account_type.key() {
                return Err(ProgramError::InvalidArgument);
            }

            // Accounts expected by the IGP's `PayForGas` instruction:
            //
            // 0. `[executable]` The system program.
            // 1. `[signer]` The payer.
            // 2. `[writeable]` The IGP program data.
            // 3. `[signer]` Unique gas payment account.
            // 4. `[writeable]` Gas payment PDA.
            // 5. `[writeable]` The IGP account.
            // 6. `[]` Overhead IGP account (optional).

            let mut igp_payment_account_metas = vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new(*payer_info.key, true),
                AccountMeta::new(*igp_program_data_account_info.key, false),
                AccountMeta::new_readonly(*unique_message_account_info.key, true),
                AccountMeta::new(*igp_payment_pda_account_info.key, false),
            ];
            let mut igp_payment_account_infos = vec![
                system_program_info.clone(),
                payer_info.clone(),
                igp_program_data_account_info.clone(),
                unique_message_account_info.clone(),
                igp_payment_pda_account_info.clone(),
            ];

            match igp_account_type {
                InterchainGasPaymasterType::Igp(_) => {
                    igp_payment_account_metas
                        .push(AccountMeta::new(*configured_igp_account_info.key, false));
                    igp_payment_account_infos.push(configured_igp_account_info.clone());
                }
                InterchainGasPaymasterType::OverheadIgp(_) => {
                    // Account 13: The inner IGP account.
                    let inner_igp_account_info = next_account_info(accounts_iter)?;

                    // The inner IGP is expected first, then the overhead IGP.
                    igp_payment_account_metas.extend([
                        AccountMeta::new(*inner_igp_account_info.key, false),
                        AccountMeta::new_readonly(*configured_igp_account_info.key, false),
                    ]);
                    igp_payment_account_infos.extend([
                        inner_igp_account_info.clone(),
                        configured_igp_account_info.clone(),
                    ]);
                }
            };

            Some((igp_payment_account_metas, igp_payment_account_infos))
        } else {
            None
        };

    let dispatch_authority_seeds: &[&[u8]] =
        mailbox_message_dispatch_authority_pda_seeds!(expected_dispatch_authority_bump);

    if let Some((igp_payment_account_metas, igp_payment_account_infos)) = igp_payment_accounts {
        // Dispatch the message and pay for gas.
        storage.dispatch_with_gas(
            program_id,
            dispatch_authority_seeds,
            hello_world.destination,
            hello_world.message.into(),
            HANDLE_GAS_AMOUNT,
            dispatch_account_metas,
            dispatch_account_infos,
            igp_payment_account_metas,
            &igp_payment_account_infos,
        )?;
    } else {
        // Dispatch the message.
        storage.dispatch(
            program_id,
            dispatch_authority_seeds,
            hello_world.destination,
            hello_world.message.into(),
            dispatch_account_metas,
            dispatch_account_infos,
        )?;
    }

    storage.sent += 1;
    storage
        .sent_to
        .entry(hello_world.destination)
        .and_modify(|c| *c += 1)
        .or_insert(1);

    // Store it
    HelloWorldStorageAccount::from(storage).store(storage_info, false)?;

    Ok(())
}

/// Handles a message.
///
/// Accounts:
/// 0. `[writeable]` Process authority specific to this program.
/// 1. `[]` Storage PDA account.
pub fn handle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Process authority specific to this program.
    let process_authority = next_account_info(accounts_iter)?;

    // Account 1: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let mut storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Verify the process authority
    let (expected_process_authority_key, _expected_process_authority_bump) =
        Pubkey::find_program_address(
            mailbox_process_authority_pda_seeds!(program_id),
            &storage.mailbox,
        );
    if process_authority.key != &expected_process_authority_key {
        return Err(ProgramError::InvalidArgument);
    }
    if !process_authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Increment counters
    storage.received += 1;
    storage
        .received_from
        .entry(handle.origin)
        .and_modify(|c| *c += 1)
        .or_insert(1);

    let local_domain = storage.local_domain;

    // Store it.
    // We don't expect the size of the storage account to change because this is accounted for
    // when a remote router is enrolled.
    HelloWorldStorageAccount::from(storage).store(storage_info, false)?;

    msg!(
        "Received hello world: origin {}, local domain {}, sender {}, message {}",
        handle.origin,
        local_domain,
        handle.sender,
        std::str::from_utf8(&handle.message).unwrap()
    );

    Ok(())
}

/// Accounts:
/// 0. `[writeable]` Storage PDA account.
/// 1. `[signer]` Owner.
fn set_interchain_security_module(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    ism: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    // Not bothering with validity checks because this is a test program
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let mut storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 1: Owner.
    let owner_info = next_account_info(accounts_iter)?;
    storage.ensure_owner_signer(owner_info)?;

    storage.ism = ism;

    // Store it
    HelloWorldStorageAccount::from(storage).store(storage_info, false)?;

    Ok(())
}

/// Accounts:
/// 0. `[]` Storage PDA account.
fn get_interchain_security_module(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    set_return_data(
        &storage
            .ism
            .try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
    );

    Ok(())
}

fn set_account_meta_return_data(program_id: &Pubkey) -> ProgramResult {
    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);

    let account_metas: Vec<SerializableAccountMeta> =
        vec![AccountMeta::new(storage_pda_key, false).into()];

    // Wrap it in the SimulationReturnData because serialized account_metas
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(account_metas)
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);

    Ok(())
}

/// Enrolls remote routers.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writeable]` Storage PDA account.
/// 2. `[signer]` Owner.
fn enroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<RemoteRouterConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let mut storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 2: Owner.
    let owner_info = next_account_info(accounts_iter)?;
    storage.ensure_owner_signer(owner_info)?;

    for config in &configs {
        // If the sent_to or received_from map doesn't have an entry for this domain yet,
        // init it to 0. This is important so that we realloc here if necessary.
        storage.sent_to.entry(config.domain).or_insert(0);
        storage.received_from.entry(config.domain).or_insert(0);
    }

    storage.enroll_remote_routers_only_owner(owner_info, configs)?;

    // Store it, & realloc if needed
    HelloWorldStorageAccount::from(storage).store_with_rent_exempt_realloc(
        storage_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    Ok(())
}
