//! Hyperlane recipient contract that just logs the message data byte vector.
//! **NOT INTENDED FOR USE IN PRODUCTION**
//!
//! Note that a real recipient must define the format for its message and that format is specific
//! to that recipient.

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use account_utils::create_pda_account;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_mailbox::{
    accounts::{AccountData, SizedData},
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_program,
    sysvar::Sysvar,
};

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("FZ8hyduJy4GQAfBu9zEiuQtk429Gjc6inwHgEW5MvsEm");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum IsmReturnDataMode {
    EncodeOption,
    ReturnNothing,
    ReturnMalformmatedData,
}

impl Default for IsmReturnDataMode {
    fn default() -> Self {
        Self::EncodeOption
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct TestSendReceiverStorage {
    pub ism: Option<Pubkey>,
    pub ism_return_data_mode: IsmReturnDataMode,
}

pub type TestSendReceiverStorageAccount = AccountData<TestSendReceiverStorage>;

impl SizedData for TestSendReceiverStorage {
    fn size(&self) -> usize {
        // 1 + 32 for ism
        // 1 for ism_return_data_mode
        1 + 32 + 1
    }
}

/// The PDA seeds relating to storage
#[macro_export]
macro_rules! test_send_receiver_storage_pda_seeds {
    () => {{
        &[b"test_send_receiver", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[b"test_send_receiver", b"-", b"storage", &[$bump_seed]]
    }};
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum TestSendReceiverInstruction {
    Init,
    Dispatch(OutboxDispatch),
    SetInterchainSecurityModule(Option<Pubkey>, IsmReturnDataMode),
}

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
                let (storage_pda_key, _storage_pda_bump) = Pubkey::find_program_address(
                    test_send_receiver_storage_pda_seeds!(),
                    program_id,
                );

                let account_metas: Vec<SerializableAccountMeta> =
                    vec![AccountMeta::new_readonly(storage_pda_key, false).into()];

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
            MessageRecipientInstruction::Handle(instruction) => {
                handle(program_id, accounts, instruction)
            }
            MessageRecipientInstruction::HandleAccountMetas(_) => {
                // No additional accounts required!
                Ok(())
            }
        };
    }

    let instruction = TestSendReceiverInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    match instruction {
        TestSendReceiverInstruction::Init => init(program_id, accounts),
        TestSendReceiverInstruction::Dispatch(outbox_dispatch) => {
            dispatch(program_id, accounts, outbox_dispatch)
        }
        TestSendReceiverInstruction::SetInterchainSecurityModule(ism, ism_return_data_mode) => {
            set_interchain_security_module(program_id, accounts, ism, ism_return_data_mode)
        }
    }
}

/// Creates the storage PDA.
///
/// Accounts:
/// 0. [executable] System program.
/// 1. [signer] Payer.
/// 2. [writeable] Storage PDA.
fn init(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
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
        Pubkey::find_program_address(test_send_receiver_storage_pda_seeds!(), program_id);
    if storage_info.key != &storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }

    let storage_account = TestSendReceiverStorageAccount::from(TestSendReceiverStorage {
        ism: None,
        ism_return_data_mode: IsmReturnDataMode::EncodeOption,
    });
    create_pda_account(
        payer_info,
        &Rent::get()?,
        storage_account.size(),
        program_id,
        system_program_info,
        storage_info,
        test_send_receiver_storage_pda_seeds!(storage_pda_bump_seed),
    )
}

/// Dispatches a message using the dispatch authority.
///
/// Accounts:
/// 0. [executable] The Mailbox program.
/// And now the accounts expected by the Mailbox's OutboxDispatch instruction:
/// 2. [writeable] Outbox PDA.
/// 3. [] This program's dispatch authority.
/// 4. [executable] System program.
/// 5. [executable] SPL Noop program.
/// 6. [signer] Payer.
/// 7. [signer] Unique message account.
/// 8. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
///    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
fn dispatch(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    outbox_dispatch: OutboxDispatch,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Mailbox program.
    let mailbox_info = next_account_info(accounts_iter)?;

    // Account 1: Outbox PDA.
    let mailbox_outbox_info = next_account_info(accounts_iter)?;

    // Account 2: Dispatch authority.
    let dispatch_authority_info = next_account_info(accounts_iter)?;
    let (expected_dispatch_authority_key, expected_dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if dispatch_authority_info.key != &expected_dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 3: System program.
    let system_program_info = next_account_info(accounts_iter)?;

    // Account 4: SPL Noop program.
    let spl_noop_info = next_account_info(accounts_iter)?;

    // Account 5: Payer.
    let payer_info = next_account_info(accounts_iter)?;

    // Account 6: Unique message account.
    let unique_message_account_info = next_account_info(accounts_iter)?;

    // Account 7: Dispatched message PDA.
    let dispatched_message_info = next_account_info(accounts_iter)?;

    // Dispatch
    let instruction = Instruction {
        program_id: *mailbox_info.key,
        data: MailboxInstruction::OutboxDispatch(outbox_dispatch).into_instruction_data()?,
        accounts: vec![
            AccountMeta::new(*mailbox_outbox_info.key, false),
            AccountMeta::new_readonly(*dispatch_authority_info.key, true),
            AccountMeta::new_readonly(*system_program_info.key, false),
            AccountMeta::new_readonly(*spl_noop_info.key, false),
            AccountMeta::new(*payer_info.key, true),
            AccountMeta::new_readonly(*unique_message_account_info.key, true),
            AccountMeta::new(*dispatched_message_info.key, false),
        ],
    };
    invoke_signed(
        &instruction,
        &[
            mailbox_outbox_info.clone(),
            dispatch_authority_info.clone(),
            system_program_info.clone(),
            spl_noop_info.clone(),
            payer_info.clone(),
            unique_message_account_info.clone(),
            dispatched_message_info.clone(),
        ],
        &[mailbox_message_dispatch_authority_pda_seeds!(
            expected_dispatch_authority_bump
        )],
    )
}

pub fn handle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let process_authority = next_account_info(accounts_iter)?;
    let (expected_process_authority_key, _expected_process_authority_bump) =
        Pubkey::find_program_address(
            mailbox_process_authority_pda_seeds!(program_id),
            &hyperlane_sealevel_mailbox::id(),
        );
    if process_authority.key != &expected_process_authority_key {
        return Err(ProgramError::InvalidArgument);
    }
    if !process_authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::InvalidArgument);
    }
    msg!("hyperlane-sealevel-recipient-echo: {:?}", handle);
    Ok(())
}

/// Accounts:
/// 0. [writeable] Storage PDA account.
fn set_interchain_security_module(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    ism: Option<Pubkey>,
    ism_return_data_mode: IsmReturnDataMode,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    // Not bothering with validity checks because this is a test program
    let storage_info = next_account_info(accounts_iter)?;
    let mut storage =
        TestSendReceiverStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    storage.ism = ism;
    storage.ism_return_data_mode = ism_return_data_mode;

    // Store it
    TestSendReceiverStorageAccount::from(storage).store(storage_info, false)?;

    Ok(())
}

/// Accounts:
/// 0. [] Storage PDA account.
fn get_interchain_security_module(_program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    // Not bothering with validity checks because this is a test program
    let storage_info = next_account_info(accounts_iter)?;
    let storage = TestSendReceiverStorageAccount::fetch(&mut &storage_info.data.borrow()[..])
        .unwrap()
        .into_inner();

    match storage.ism_return_data_mode {
        IsmReturnDataMode::EncodeOption => {
            set_return_data(
                &storage
                    .ism
                    .try_to_vec()
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
            );
        }
        IsmReturnDataMode::ReturnNothing => {
            // Nothing!
        }
        IsmReturnDataMode::ReturnMalformmatedData => {
            set_return_data(&[0x00, 0x01, 0x02, 0x03]);
        }
    }

    Ok(())
}
