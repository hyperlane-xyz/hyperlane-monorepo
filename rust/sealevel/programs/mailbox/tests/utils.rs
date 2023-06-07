use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{
 Encode, HyperlaneMessage, H256,
};

use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{
    message::Message,
    signature::{Signature, Signer},
    signer::keypair::Keypair,
    transaction::{Transaction},
};

use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_mailbox::{
    accounts::{
        DispatchedMessage, DispatchedMessageAccount, Outbox, OutboxAccount,
        ProcessedMessage, ProcessedMessageAccount,
    },
    instruction::{InboxProcess, Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_dispatched_message_pda_seeds, mailbox_process_authority_pda_seeds,
    mailbox_processed_message_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction, HANDLE_ACCOUNT_METAS_PDA_SEEDS,
    INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

use hyperlane_test_utils::{ MailboxAccounts};

pub async fn dispatch_from_payer(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    outbox_dispatch: OutboxDispatch,
) -> Result<(Signature, Keypair, Pubkey), BanksClientError> {
    let unique_message_account_keypair = Keypair::new();

    let (dispatched_message_account_key, _dispatched_message_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
        &mailbox_accounts.program,
    );

    let instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: MailboxInstruction::OutboxDispatch(outbox_dispatch)
            .into_instruction_data()
            .unwrap(),
        accounts: vec![
            // 0. [writeable] Outbox PDA.
            // 1. [signer] Message sender signer.
            // 2. [executable] System program.
            // 3. [executable] SPL Noop program.
            // 4. [signer] Payer.
            // 5. [signer] Unique message account.
            // 6. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
            //    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
            AccountMeta::new(mailbox_accounts.outbox, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(spl_noop::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(unique_message_account_keypair.pubkey(), true),
            AccountMeta::new(dispatched_message_account_key, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer, &unique_message_account_keypair],
        recent_blockhash,
    );
    let tx_signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await?;

    Ok((
        tx_signature,
        unique_message_account_keypair,
        dispatched_message_account_key,
    ))
}

pub async fn assert_dispatched_message(
    banks_client: &mut BanksClient,
    dispatch_tx_signature: Signature,
    dispatch_unique_account_pubkey: Pubkey,
    dispatched_message_account_key: Pubkey,
    expected_message: &HyperlaneMessage,
) {
    // Get the slot of the tx
    let dispatch_tx_status = banks_client
        .get_transaction_status(dispatch_tx_signature)
        .await
        .unwrap()
        .unwrap();
    let dispatch_slot = dispatch_tx_status.slot;

    // Get the dispatched message account
    let dispatched_message_account = banks_client
        .get_account(dispatched_message_account_key)
        .await
        .unwrap()
        .unwrap();
    let dispatched_message =
        DispatchedMessageAccount::fetch(&mut &dispatched_message_account.data[..])
            .unwrap()
            .into_inner();
    assert_eq!(
        *dispatched_message,
        DispatchedMessage::new(
            expected_message.nonce,
            dispatch_slot,
            dispatch_unique_account_pubkey,
            expected_message.to_vec(),
        ),
    );
}

pub async fn assert_outbox(
    banks_client: &mut BanksClient,
    outbox_pubkey: Pubkey,
    expected_outbox: Outbox,
) {
    // Check that the outbox account was updated.
    let outbox_account = banks_client
        .get_account(outbox_pubkey)
        .await
        .unwrap()
        .unwrap();

    let outbox = OutboxAccount::fetch(&mut &outbox_account.data[..])
        .unwrap()
        .into_inner();

    assert_eq!(*outbox, expected_outbox,);
}


/// Simulates an instruction, and attempts to deserialize it into a T.
/// If no return data at all was returned, returns Ok(None).
/// If some return data was returned but deserialization was unsuccesful,
/// an Err is returned.
pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    instruction: Instruction,
) -> Result<Option<T>, BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await?;
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[instruction],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await?;
    // If the result is an err, return an err
    if let Some(Err(err)) = simulation.result {
        return Err(BanksClientError::TransactionError(err));
    }
    let decoded_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .map(|return_data| T::try_from_slice(return_data.data.as_slice()).unwrap());

    Ok(decoded_data)
}

/// Simulates an Instruction that will return a list of AccountMetas.
pub async fn get_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    instruction: Instruction,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    // If there's no data at all, default to an empty vec.
    let account_metas = simulate_instruction::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
        banks_client,
        payer,
        instruction,
    )
    .await?
    .map(|serializable_account_metas| {
        serializable_account_metas
            .return_data
            .into_iter()
            .map(|serializable_account_meta| serializable_account_meta.into())
            .collect()
    })
    .unwrap_or_else(std::vec::Vec::new);

    Ok(account_metas)
}

/// Gets the recipient ISM given a recipient program id and the ISM getter account metas.
pub async fn get_recipient_ism_with_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    recipient_program_id: Pubkey,
    ism_getter_account_metas: Vec<AccountMeta>,
) -> Result<Pubkey, BanksClientError> {
    let mut accounts = vec![
        // Inbox PDA
        AccountMeta::new_readonly(mailbox_accounts.inbox, false),
        // The recipient program.
        AccountMeta::new_readonly(recipient_program_id, false),
    ];
    accounts.extend(ism_getter_account_metas);

    let instruction = Instruction::new_with_borsh(
        mailbox_accounts.program,
        &MailboxInstruction::InboxGetRecipientIsm(recipient_program_id),
        accounts,
    );
    let ism =
        simulate_instruction::<SimulationReturnData<Pubkey>>(banks_client, payer, instruction)
            .await?
            .unwrap()
            .return_data;
    Ok(ism)
}

/// Gets the account metas required for the recipient's
/// `MessageRecipientInstruction::InterchainSecurityModule` instruction.
pub async fn get_ism_getter_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recipient_program_id: Pubkey,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    let (account_metas_pda_key, _) = Pubkey::find_program_address(
        INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
        &recipient_program_id,
    );
    let instruction = MessageRecipientInstruction::InterchainSecurityModuleAccountMetas;
    let instruction = Instruction::new_with_bytes(
        recipient_program_id,
        &instruction.encode().unwrap(),
        vec![AccountMeta::new(account_metas_pda_key, false)],
    );

    get_account_metas(banks_client, payer, instruction).await
}

pub async fn get_recipient_ism(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    recipient: Pubkey,
) -> Result<Pubkey, BanksClientError> {
    let account_metas = get_ism_getter_account_metas(banks_client, payer, recipient).await?;

    get_recipient_ism_with_account_metas(
        banks_client,
        payer,
        mailbox_accounts,
        recipient,
        account_metas,
    )
    .await
}

/// Gets the account metas required for the ISM's `Verify` instruction.
pub async fn get_ism_verify_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    ism: Pubkey,
    metadata: Vec<u8>,
    message: Vec<u8>,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    let (account_metas_pda_key, _) =
        Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &ism);
    let instruction = InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction {
        metadata,
        message,
    });
    let instruction = Instruction::new_with_bytes(
        ism,
        &instruction.encode().unwrap(),
        vec![AccountMeta::new(account_metas_pda_key, false)],
    );

    get_account_metas(banks_client, payer, instruction).await
}

/// Gets the account metas required for the recipient's `MessageRecipientInstruction::Handle` instruction.
pub async fn get_handle_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    message: &HyperlaneMessage,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    let recipient_program_id = Pubkey::new_from_array(message.recipient.into());
    let instruction = MessageRecipientInstruction::HandleAccountMetas(HandleInstruction {
        sender: message.sender,
        origin: message.origin,
        message: message.body.clone(),
    });
    let (account_metas_pda_key, _) =
        Pubkey::find_program_address(HANDLE_ACCOUNT_METAS_PDA_SEEDS, &recipient_program_id);
    let instruction = Instruction::new_with_bytes(
        recipient_program_id,
        &instruction.encode().unwrap(),
        vec![AccountMeta::new(account_metas_pda_key, false)],
    );

    get_account_metas(banks_client, payer, instruction).await
}

pub async fn process(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    metadata: Vec<u8>,
    message: &HyperlaneMessage,
) -> Result<(Signature, Pubkey), BanksClientError> {
    let recipient: Pubkey = message.recipient.0.into();
    let mut encoded_message = vec![];
    message.write_to(&mut encoded_message).unwrap();

    let mut instructions = Vec::with_capacity(1);

    let (process_authority_key, _process_authority_bump) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(&recipient),
        &mailbox_accounts.program,
    );
    let (processed_message_account_key, _processed_message_account_bump) =
        Pubkey::find_program_address(
            mailbox_processed_message_pda_seeds!(message.id()),
            &mailbox_accounts.program,
        );

    // Get the account metas required for the recipient.InterchainSecurityModule instruction.
    let ism_getter_account_metas =
        get_ism_getter_account_metas(banks_client, payer, recipient).await?;

    // Get the recipient ISM.
    let ism = get_recipient_ism_with_account_metas(
        banks_client,
        payer,
        mailbox_accounts,
        recipient,
        ism_getter_account_metas.clone(),
    )
    .await?;

    let ixn = MailboxInstruction::InboxProcess(InboxProcess {
        metadata: metadata.to_vec(),
        message: encoded_message.clone(),
    });
    let ixn_data = ixn.into_instruction_data().unwrap();

    // Craft the accounts for the transaction.
    let mut accounts: Vec<AccountMeta> = vec![
        AccountMeta::new_readonly(payer.pubkey(), true),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new(mailbox_accounts.inbox, false),
        AccountMeta::new_readonly(process_authority_key, false),
        AccountMeta::new(processed_message_account_key, false),
    ];
    accounts.extend(ism_getter_account_metas);
    accounts.extend([
        AccountMeta::new_readonly(spl_noop::id(), false),
        AccountMeta::new_readonly(ism, false),
    ]);

    // Get the account metas required for the ISM.Verify instruction.
    let ism_verify_account_metas =
        get_ism_verify_account_metas(banks_client, payer, ism, metadata, encoded_message)
            .await?;
    accounts.extend(ism_verify_account_metas);

    // The recipient.
    accounts.extend([AccountMeta::new_readonly(recipient, false)]);

    // Get account metas required for the Handle instruction
    let handle_account_metas = get_handle_account_metas(banks_client, payer, message).await?;
    accounts.extend(handle_account_metas);

    let inbox_instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: ixn_data,
        accounts,
    };
    instructions.push(inbox_instruction);
    let recent_blockhash = banks_client.get_latest_blockhash().await?;
    let txn = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    let tx_signature = txn.signatures[0];

    banks_client.process_transaction(txn).await?;

    Ok((tx_signature, processed_message_account_key))
}


pub async fn assert_processed_message(
    banks_client: &mut BanksClient,
    process_tx_signature: Signature,
    processed_message_account_key: Pubkey,
    expected_message: &HyperlaneMessage,
    expected_sequence: u64,
) {
    println!("process_tx_signature {}", process_tx_signature);
    // Get the slot of the tx
    let process_tx_status = banks_client
        .get_transaction_status(process_tx_signature)
        .await
        .unwrap()
        .unwrap();
    let process_slot = process_tx_status.slot;

    // Get the processed message account
    let processed_message_account = banks_client
        .get_account(processed_message_account_key)
        .await
        .unwrap()
        .unwrap();
    let processed_message =
        ProcessedMessageAccount::fetch(&mut &processed_message_account.data[..])
            .unwrap()
            .into_inner();
    assert_eq!(
        *processed_message,
        ProcessedMessage::new(expected_sequence, expected_message.id(), process_slot,),
    );
}

pub async fn assert_message_not_processed(
    banks_client: &mut BanksClient,
    mailbox_accounts: &MailboxAccounts,
    message_id: H256,
) {
    let (processed_message_account_key, _processed_message_account_bump) =
        Pubkey::find_program_address(
            mailbox_processed_message_pda_seeds!(&message_id),
            &mailbox_accounts.program,
        );

    // Get the processed message account
    let processed_message_account = banks_client
        .get_account(processed_message_account_key)
        .await
        .unwrap();
    assert!(processed_message_account.is_none());
}