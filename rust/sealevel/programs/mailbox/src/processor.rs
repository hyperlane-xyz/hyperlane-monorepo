//! Entrypoint, dispatch, and execution for the Hyperlane Sealevel mailbox instruction.

use access_control::AccessControl;
use account_utils::SizedData;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle as MerkleTree, Decode, Encode, HyperlaneMessage,
    H256,
};
#[cfg(not(feature = "no-entrypoint"))]
use solana_program::entrypoint;
use solana_program::{
    account_info::next_account_info,
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{get_return_data, invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{clock::Clock, rent::Rent, Sysvar},
};

use account_utils::{create_pda_account, verify_account_uninitialized};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::SimulationReturnData;

use crate::{
    accounts::{
        DispatchedMessage, DispatchedMessageAccount, Inbox, InboxAccount, Outbox, OutboxAccount,
        ProcessedMessage, ProcessedMessageAccount,
    },
    error::Error,
    instruction::{
        InboxProcess, Init, Instruction as MailboxIxn, OutboxDispatch, MAX_MESSAGE_BODY_BYTES,
        VERSION,
    },
    mailbox_dispatched_message_pda_seeds, mailbox_inbox_pda_seeds,
    mailbox_message_dispatch_authority_pda_seeds, mailbox_outbox_pda_seeds,
    mailbox_process_authority_pda_seeds, mailbox_processed_message_pda_seeds,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

/// Entrypoint for the Mailbox program.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match MailboxIxn::from_instruction_data(instruction_data)? {
        MailboxIxn::Init(init) => initialize(program_id, accounts, init),
        MailboxIxn::InboxProcess(process) => inbox_process(program_id, accounts, process),
        MailboxIxn::InboxSetDefaultIsm(ism) => inbox_set_default_ism(program_id, accounts, ism),
        MailboxIxn::InboxGetRecipientIsm(recipient) => {
            inbox_get_recipient_ism(program_id, accounts, recipient)
        }
        MailboxIxn::OutboxDispatch(dispatch) => outbox_dispatch(program_id, accounts, dispatch),
        MailboxIxn::OutboxGetCount => outbox_get_count(program_id, accounts),
        MailboxIxn::OutboxGetLatestCheckpoint => outbox_get_latest_checkpoint(program_id, accounts),
        MailboxIxn::OutboxGetRoot => outbox_get_root(program_id, accounts),
        MailboxIxn::GetOwner => get_owner(program_id, accounts),
        MailboxIxn::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

/// Initializes the Mailbox.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [signer, writable] The payer account and owner of the Mailbox.
/// 2. [writable] The inbox PDA account.
/// 3. [writable] The outbox PDA account.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let rent = Rent::get()?;

    // Account 0: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &solana_program::system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: The payer account and owner of the Mailbox.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: The inbox PDA account.
    let inbox_info = next_account_info(accounts_iter)?;
    let (inbox_key, inbox_bump) =
        Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), program_id);
    if &inbox_key != inbox_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    verify_account_uninitialized(inbox_info)?;

    let inbox_account = InboxAccount::from(Inbox {
        local_domain: init.local_domain,
        inbox_bump_seed: inbox_bump,
        default_ism: init.default_ism,
        processed_count: 0,
    });

    // Create the inbox PDA account.
    create_pda_account(
        payer_info,
        &rent,
        inbox_account.size(),
        program_id,
        system_program_info,
        inbox_info,
        mailbox_inbox_pda_seeds!(inbox_bump),
    )?;
    // Store the inbox account.
    inbox_account.store(inbox_info, false)?;

    // Account 3: The outbox PDA account.
    let outbox_info = next_account_info(accounts_iter)?;
    let (outbox_key, outbox_bump) =
        Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), program_id);
    if &outbox_key != outbox_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    verify_account_uninitialized(outbox_info)?;

    let outbox_account = OutboxAccount::from(Outbox {
        local_domain: init.local_domain,
        outbox_bump_seed: outbox_bump,
        owner: Some(*payer_info.key),
        tree: MerkleTree::default(),
    });

    // Create the outbox PDA account.
    create_pda_account(
        payer_info,
        &rent,
        outbox_account.size(),
        program_id,
        system_program_info,
        outbox_info,
        mailbox_outbox_pda_seeds!(outbox_bump),
    )?;
    // Store the outbox account.
    outbox_account.store(outbox_info, false)?;

    Ok(())
}

/// Process a message. Non-reentrant through the use of a RefMut.
///
// Accounts:
// 0.      [signer] Payer account. This pays for the creation of the processed message PDA.
// 1.      [executable] The system program.
// 2.      [writable] Inbox PDA account.
// 3.      [] Mailbox process authority specific to the message recipient.
// 4.      [writable] Processed message PDA.
// 5..N    [??] Accounts required to invoke the recipient's InterchainSecurityModule instruction.
// N+1.    [executable] SPL noop
// N+2.    [executable] ISM
// N+2..M. [??] Accounts required to invoke the ISM's Verify instruction.
// M+1.    [executable] Recipient program.
// M+2..K. [??] Accounts required to invoke the recipient's Handle instruction.
fn inbox_process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    process: InboxProcess,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter().peekable();

    // Decode the message bytes.
    let message = HyperlaneMessage::read_from(&mut std::io::Cursor::new(&process.message))
        .map_err(|_| ProgramError::from(Error::DecodeError))?;
    let message_id = message.id();

    // Require the message version to match what we expect.
    if message.version != VERSION {
        return Err(ProgramError::from(Error::UnsupportedMessageVersion));
    }
    let recipient_program_id = Pubkey::new_from_array(message.recipient.0);

    // Account 0: Payer account.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 1: The system program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &solana_program::system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 2: Inbox PDA.
    let inbox_info = next_account_info(accounts_iter)?;
    // By holding a refmut of the Inbox data, we effectively have a reentrancy guard
    // that prevents any of the CPIs performed by this function to call back into
    // this function.
    let (mut inbox, mut inbox_data_refmut) =
        Inbox::verify_account_and_fetch_inner_with_data_refmut(program_id, inbox_info)?;

    // Verify the message's destination matches the inbox's local domain.
    if inbox.local_domain != message.destination {
        return Err(Error::DestinationDomainNotLocalDomain.into());
    }

    // Account 3: Process authority account that is specific to the
    // message recipient.
    let process_authority_info = next_account_info(accounts_iter)?;
    // Future versions / changes should consider requiring the process authority to
    // store its bump seed as account data.
    let (expected_process_authority_key, expected_process_authority_bump) =
        Pubkey::find_program_address(
            mailbox_process_authority_pda_seeds!(&recipient_program_id),
            program_id,
        );
    if process_authority_info.key != &expected_process_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 4: Processed message PDA.
    let processed_message_account_info = next_account_info(accounts_iter)?;
    let (expected_processed_message_key, expected_processed_message_bump) =
        Pubkey::find_program_address(mailbox_processed_message_pda_seeds!(message_id), program_id);
    if processed_message_account_info.key != &expected_processed_message_key {
        return Err(ProgramError::InvalidArgument);
    }
    // If the processed message account already exists, then the message
    // has been processed already.
    if verify_account_uninitialized(processed_message_account_info).is_err() {
        return Err(Error::MessageAlreadyProcessed.into());
    }

    let spl_noop_id = spl_noop::id();

    // Accounts 5..N: the accounts required for getting the ISM the recipient wants to use.
    let mut get_ism_infos = vec![];
    let mut get_ism_account_metas = vec![];
    loop {
        // We expect there to always be a new account as we loop through
        // and use the SPL noop account ID as a marker for the end of the
        // accounts required for getting the ISM.
        let next_info = accounts_iter.peek().ok_or(ProgramError::InvalidArgument)?;
        if next_info.key == &spl_noop_id {
            break;
        }

        let account_info = next_account_info(accounts_iter)?;
        let meta = AccountMeta {
            pubkey: *account_info.key,
            is_signer: account_info.is_signer,
            is_writable: account_info.is_writable,
        };

        get_ism_infos.push(account_info.clone());
        get_ism_account_metas.push(meta);
    }

    // Call into the recipient program to get the ISM to use.
    let ism = get_recipient_ism(
        &recipient_program_id,
        get_ism_infos,
        get_ism_account_metas,
        inbox.default_ism,
    )?;

    // Account N: SPL Noop program.
    let spl_noop_info = next_account_info(accounts_iter)?;
    if spl_noop_info.key != &spl_noop_id {
        return Err(ProgramError::InvalidArgument);
    }

    #[cfg(not(feature = "no-spl-noop"))]
    if !spl_noop_info.executable {
        return Err(ProgramError::InvalidArgument);
    }

    // Account N+1: The ISM.
    let ism_info = next_account_info(accounts_iter)?;
    if &ism != ism_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account N+2..M: The accounts required for ISM verification.
    let mut ism_verify_infos = vec![];
    let mut ism_verify_account_metas = vec![];
    loop {
        // We expect there to always be a new account as we loop through
        // and use the recipient program ID as a marker for the end of the
        // accounts required for ISM verification.
        let next_info = accounts_iter.peek().ok_or(ProgramError::InvalidArgument)?;
        if next_info.key == &recipient_program_id {
            break;
        }

        let account_info = next_account_info(accounts_iter)?;
        let meta = AccountMeta {
            pubkey: *account_info.key,
            is_signer: account_info.is_signer,
            is_writable: account_info.is_writable,
        };
        ism_verify_infos.push(account_info.clone());
        ism_verify_account_metas.push(meta);
    }

    // Account M+1: The recipient program.
    let recipient_info = next_account_info(accounts_iter)?;
    if &recipient_program_id != recipient_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    if !recipient_info.executable {
        return Err(ProgramError::InvalidAccountData);
    }

    // Account M+2..K: The accounts required for the recipient program handler.
    let mut recipient_infos = vec![process_authority_info.clone()];
    let mut recipient_account_metas = vec![AccountMeta {
        pubkey: *process_authority_info.key,
        is_signer: true,
        is_writable: false,
    }];
    for account_info in accounts_iter {
        recipient_infos.push(account_info.clone());
        recipient_account_metas.push(AccountMeta {
            pubkey: *account_info.key,
            is_signer: account_info.is_signer,
            is_writable: account_info.is_writable,
        });
    }

    // Call into the ISM to verify the message.
    let verify_instruction = InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
        metadata: process.metadata,
        message: process.message,
    });
    let verify =
        Instruction::new_with_bytes(ism, &verify_instruction.encode()?, ism_verify_account_metas);
    invoke(&verify, &ism_verify_infos)?;

    // Mark the message as delivered by creating the processed message account.
    let processed_message_account_data = ProcessedMessageAccount::from(ProcessedMessage::new(
        inbox.processed_count,
        message_id,
        Clock::get()?.slot,
    ));
    let processed_message_account_data_size = processed_message_account_data.size();
    create_pda_account(
        payer_info,
        &Rent::get()?,
        processed_message_account_data_size,
        program_id,
        system_program_info,
        processed_message_account_info,
        mailbox_processed_message_pda_seeds!(message_id, expected_processed_message_bump),
    )?;
    // Write the processed message data to the processed message account.
    processed_message_account_data.store(processed_message_account_info, false)?;

    // Increment the processed count and store the updated Inbox account.
    inbox.processed_count += 1;
    InboxAccount::from(inbox)
        .store_in_slice(&mut inbox_data_refmut)
        .map_err(|e| ProgramError::BorshIoError(e.to_string()))?;

    // Now call into the recipient program with the verified message!
    let handle_intruction = Instruction::new_with_bytes(
        recipient_program_id,
        &MessageRecipientInstruction::Handle(HandleInstruction::new(
            message.origin,
            message.sender,
            message.body,
        ))
        .encode()?,
        recipient_account_metas,
    );
    invoke_signed(
        &handle_intruction,
        &recipient_infos,
        &[mailbox_process_authority_pda_seeds!(
            &recipient_program_id,
            expected_process_authority_bump
        )],
    )?;

    #[cfg(not(feature = "no-spl-noop"))]
    {
        let noop_cpi_log = Instruction {
            program_id: spl_noop::id(),
            accounts: vec![],
            data: format!("Hyperlane inbox: {:?}", message_id).into_bytes(),
        };
        invoke(&noop_cpi_log, &[])?;
    }

    msg!("Hyperlane inbox processed message {:?}", message_id);

    Ok(())
}

/// Gets the ISM to use for a recipient program and sets it as return data.
///
/// Accounts:
/// 0.    [] - The Inbox PDA.
/// 1.    [] - The recipient program.
/// 2..N. [??] - The accounts required to make the CPI into the recipient program.
///             These can be retrieved from the recipient using the
///             `MessageRecipientInstruction::InterchainSecurityModuleAccountMetas` instruction.
fn inbox_get_recipient_ism(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    recipient: Pubkey,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Inbox PDA.
    let inbox_info = next_account_info(accounts_iter)?;
    let inbox = Inbox::verify_account_and_fetch_inner(program_id, inbox_info)?;

    // Account 1: The recipient program.
    let recipient_info = next_account_info(accounts_iter)?;
    if &recipient != recipient_info.key || !recipient_info.executable {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 2..N: The accounts required to make the CPI into the recipient program.
    let mut account_infos = vec![];
    let mut account_metas = vec![];
    for account_info in accounts_iter {
        account_infos.push(account_info.clone());
        account_metas.push(AccountMeta {
            pubkey: *account_info.key,
            is_signer: account_info.is_signer,
            is_writable: account_info.is_writable,
        });
    }

    let ism = get_recipient_ism(&recipient, account_infos, account_metas, inbox.default_ism)?;

    // Return the borsh serialized ISM pubkey.
    set_return_data(
        &SimulationReturnData::new(ism)
            .try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
    );

    Ok(())
}

/// Get the ISM to use for a recipient program.
///
/// Expects `account_infos` and `account_metas` to be those required
/// by the recipient program's InterchainSecurityModule instruction.
fn get_recipient_ism(
    recipient_program_id: &Pubkey,
    account_infos: Vec<AccountInfo>,
    account_metas: Vec<AccountMeta>,
    default_ism: Pubkey,
) -> Result<Pubkey, ProgramError> {
    let get_ism_instruction = Instruction::new_with_bytes(
        *recipient_program_id,
        &MessageRecipientInstruction::InterchainSecurityModule.encode()?,
        account_metas,
    );
    invoke(&get_ism_instruction, &account_infos)?;

    // Default to the default ISM if there is no return data or Option::None was returned.
    let ism = if let Some((returning_program_id, returned_data)) = get_return_data() {
        if &returning_program_id != recipient_program_id {
            return Err(ProgramError::InvalidAccountData);
        }
        // It's possible for the Some above to match but there is no return data.
        // We just want to default to the default ISM in that case.
        if returned_data.is_empty() {
            default_ism
        } else {
            // If the recipient program returned data, use that as the ISM.
            // If they returned an encoded Option::<Pubkey>::None, then use
            // the default ISM.
            Option::<Pubkey>::try_from_slice(&returned_data[..])
                .map_err(|err| ProgramError::BorshIoError(err.to_string()))?
                .unwrap_or(default_ism)
        }
    } else {
        // If no return data, default to the default ISM.
        default_ism
    };

    Ok(ism)
}

/// Sets the default ISM.
///
/// Accounts:
/// 0. [writeable] - The Inbox PDA account.
/// 1. [] - The Outbox PDA account.
/// 2. [signer] - The owner of the Mailbox.
fn inbox_set_default_ism(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    ism: Pubkey,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Inbox PDA account.
    let inbox_info = next_account_info(accounts_iter)?;
    let mut inbox = Inbox::verify_account_and_fetch_inner(program_id, inbox_info)?;

    // Account 1: Outbox PDA account.
    let outbox_info = next_account_info(accounts_iter)?;
    let outbox = Outbox::verify_account_and_fetch_inner(program_id, outbox_info)?;

    // Account 2: The owner of the Mailbox.
    let owner_info = next_account_info(accounts_iter)?;
    // Errors if the owner account isn't correct or isn't a signer.
    outbox.ensure_owner_signer(owner_info)?;

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    // Set the new default ISM.
    inbox.default_ism = ism;
    // Store the updated inbox.
    InboxAccount::from(inbox).store(inbox_info, false)?;

    Ok(())
}

/// Dispatches a message.
/// If the message sender is a program, the message sender signer *must* be
/// the PDA for the sending program with the seeds `mailbox_message_dispatch_authority_pda_seeds!()`.
/// in order for the sender field of the message to be set to the sending program
/// ID. Otherwise, the sender field of the message is set to the message sender signer.
///
/// Sets the ID of the message as return data.
///
/// Accounts:
/// 0. [writeable] Outbox PDA.
/// 1. [signer] Message sender signer.
/// 2. [executable] System program.
/// 3. [executable] SPL Noop program.
/// 4. [signer] Payer.
/// 5. [signer] Unique message account.
/// 6. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
///    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
fn outbox_dispatch(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    dispatch: OutboxDispatch,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Outbox PDA.
    let outbox_info = next_account_info(accounts_iter)?;
    let mut outbox = Outbox::verify_account_and_fetch_inner(program_id, outbox_info)?;

    // Account 1: Message sender signer.
    let sender_signer_info = next_account_info(accounts_iter)?;
    if !sender_signer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // If the sender signer key differs from the specified dispatch.sender,
    // we need to confirm that the sender signer has the authority to sign
    // on behalf of the dispatch.sender!
    if *sender_signer_info.key != dispatch.sender {
        // Future versions / changes should consider requiring the dispatch authority to
        // store its bump seed as account data.
        let (expected_signer_key, _expected_signer_bump) = Pubkey::find_program_address(
            mailbox_message_dispatch_authority_pda_seeds!(),
            &dispatch.sender,
        );
        // If the sender_signer isn't the expected dispatch authority for the
        // specified dispatch.sender, fail.
        if expected_signer_key != *sender_signer_info.key {
            return Err(ProgramError::MissingRequiredSignature);
        }
    }

    // Account 2: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &solana_program::system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 3: SPL Noop program.
    let spl_noop_info = next_account_info(accounts_iter)?;
    if spl_noop_info.key != &spl_noop::id() {
        return Err(ProgramError::InvalidArgument);
    }

    #[cfg(not(feature = "no-spl-noop"))]
    if !spl_noop_info.executable {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 4: Payer.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 5: Unique message account.
    // Uniqueness is enforced by making sure the message storage PDA based on
    // this unique message account is empty, which is done next.
    let unique_message_account_info = next_account_info(accounts_iter)?;
    if !unique_message_account_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 6: Dispatched message PDA.
    let dispatched_message_account_info = next_account_info(accounts_iter)?;
    let (dispatched_message_key, dispatched_message_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(unique_message_account_info.key),
        program_id,
    );
    if dispatched_message_key != *dispatched_message_account_info.key {
        return Err(ProgramError::InvalidArgument);
    }
    // Make sure an account can't be written to that already exists.
    verify_account_uninitialized(dispatched_message_account_info)?;

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    if dispatch.message_body.len() > MAX_MESSAGE_BODY_BYTES {
        return Err(ProgramError::from(Error::MaxMessageSizeExceeded));
    }

    let count = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");
    let message = HyperlaneMessage {
        version: VERSION,
        nonce: count,
        origin: outbox.local_domain,
        sender: H256(dispatch.sender.to_bytes()),
        destination: dispatch.destination_domain,
        recipient: dispatch.recipient,
        body: dispatch.message_body,
    };
    let mut encoded_message = vec![];
    message
        .write_to(&mut encoded_message)
        .map_err(|_| ProgramError::from(Error::EncodeError))?;

    let id = message.id();
    outbox.tree.ingest(id);

    // Create the dispatched message PDA.
    let dispatched_message_account = DispatchedMessageAccount::from(DispatchedMessage::new(
        message.nonce,
        Clock::get()?.slot,
        *unique_message_account_info.key,
        encoded_message,
    ));
    let dispatched_message_account_size: usize = dispatched_message_account.size();
    create_pda_account(
        payer_info,
        &Rent::get()?,
        dispatched_message_account_size,
        program_id,
        system_program_info,
        dispatched_message_account_info,
        mailbox_dispatched_message_pda_seeds!(
            unique_message_account_info.key,
            dispatched_message_bump
        ),
    )?;
    dispatched_message_account.store(dispatched_message_account_info, false)?;

    // Log the message using the SPL Noop program.
    #[cfg(not(feature = "no-spl-noop"))]
    {
        let noop_cpi_log = Instruction {
            program_id: *spl_noop_info.key,
            accounts: vec![],
            data: dispatched_message_account_info.data.borrow().to_vec(),
        };
        invoke(&noop_cpi_log, &[])?;
    }

    msg!(
        "Dispatched message to {}, ID {:?}",
        dispatch.destination_domain,
        id
    );

    // Store the Outbox with the new updates.
    OutboxAccount::from(outbox).store(outbox_info, true)?;

    set_return_data(id.as_ref());
    Ok(())
}

/// Gets the number of dispatched messages as little endian encoded return data.
///
/// Accounts:
/// 0. [] Outbox PDA account.
fn outbox_get_count(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Outbox PDA.
    let outbox_info = next_account_info(accounts_iter)?;
    let outbox = Outbox::verify_account_and_fetch_inner(program_id, outbox_info)?;

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    let count: u32 = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");
    // Wrap it in the SimulationReturnData because serialized `count.to_le_bytes()`
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(count.to_le_bytes())
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Gets the latest checkpoint as return data.
///
/// Accounts:
/// 0. [] Outbox PDA account.
fn outbox_get_latest_checkpoint(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let outbox_info = next_account_info(accounts_iter)?;
    let outbox = Outbox::verify_account_and_fetch_inner(program_id, outbox_info)?;

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    let root = outbox.tree.root();
    let count: u32 = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");

    let mut ret_buf = [0; 36];
    ret_buf[0..31].copy_from_slice(root.as_ref());
    ret_buf[32..].copy_from_slice(&count.to_le_bytes());

    // Wrap it in the SimulationReturnData because serialized ret_buf
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(ret_buf.to_vec())
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Gets the root as return data.
///
/// Accounts:
/// 0. [] Outbox PDA account.
fn outbox_get_root(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Outbox PDA.
    let outbox_info = next_account_info(accounts_iter)?;
    let outbox = Outbox::verify_account_and_fetch_inner(program_id, outbox_info)?;

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    let root = outbox.tree.root();

    // Wrap it in the SimulationReturnData because serialized root
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(root)
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Gets the owner as return data.
///
/// Accounts:
/// 0. `[]` The Outbox PDA account.
fn get_owner(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Outbox PDA.
    let outbox_info = next_account_info(accounts_iter)?;
    let outbox = Outbox::verify_account_and_fetch_inner(program_id, outbox_info)?;

    // Wrap it in the SimulationReturnData because serialized `outbox.owner`
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(outbox.owner)
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Transfers ownership.
///
/// Accounts:
/// 0. `[writeable]` The Outbox PDA account.
/// 1. `[signer]` The current owner.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Outbox PDA.
    let outbox_info = next_account_info(accounts_iter)?;
    let mut outbox = Outbox::verify_account_and_fetch_inner(program_id, outbox_info)?;

    // Account 1: Current owner.
    let owner_info = next_account_info(accounts_iter)?;
    // Errors if the owner_account is not the actual owner or is not a signer.
    outbox.transfer_ownership(owner_info, new_owner)?;

    // Store the updated outbox.
    OutboxAccount::from(outbox).store(outbox_info, false)?;

    Ok(())
}
