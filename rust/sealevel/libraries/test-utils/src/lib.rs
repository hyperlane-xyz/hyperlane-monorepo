use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Encode, HyperlaneMessage};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{
    message::Message,
    signature::{Signature, Signer},
    signer::keypair::Keypair,
    signers::Signers,
    transaction::{Transaction, TransactionError},
};

use spl_token_2022::{extension::StateWithExtensions, state::Account};

use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_mailbox::{
    instruction::{InboxProcess, Init as InitMailbox, Instruction as MailboxInstruction},
    mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds, mailbox_process_authority_pda_seeds,
    mailbox_processed_message_pda_seeds,
    protocol_fee::ProtocolFee,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction, HANDLE_ACCOUNT_METAS_PDA_SEEDS,
    INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_test_ism::test_client::TestIsmTestClient;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

pub mod igp;
pub use igp::*;

// ========= Mailbox =========

pub fn mailbox_id() -> Pubkey {
    pubkey!("692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1")
}

pub struct MailboxAccounts {
    pub program: Pubkey,
    pub inbox: Pubkey,
    pub inbox_bump_seed: u8,
    pub outbox: Pubkey,
    pub outbox_bump_seed: u8,
    pub default_ism: Pubkey,
}

pub async fn initialize_mailbox(
    banks_client: &mut BanksClient,
    mailbox_program_id: &Pubkey,
    payer: &Keypair,
    local_domain: u32,
    max_protocol_fee: u64,
    protocol_fee: ProtocolFee,
) -> Result<MailboxAccounts, BanksClientError> {
    println!("Finding PDAs...");
    let (inbox_account, inbox_bump) =
        Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), mailbox_program_id);
    let (outbox_account, outbox_bump) =
        Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), mailbox_program_id);

    println!("Getting default ISM...");
    let default_ism = hyperlane_sealevel_test_ism::id();

    println!("Creating init instruction...");
    let ixn = MailboxInstruction::Init(InitMailbox {
        local_domain,
        default_ism,
        max_protocol_fee,
        protocol_fee,
    });
    let init_instruction = Instruction {
        program_id: *mailbox_program_id,
        data: ixn.into_instruction_data().unwrap(),
        accounts: vec![
            AccountMeta::new(system_program::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(inbox_account, false),
            AccountMeta::new(outbox_account, false),
        ],
    };

    println!("Processing init instruction...");
    process_instruction(banks_client, init_instruction, payer, &[payer]).await?;

    println!("Initializing test ISM...");
    // And initialize the default ISM
    initialize_test_ism(banks_client, payer).await?;

    println!("Mailbox initialization complete!");
    Ok(MailboxAccounts {
        program: *mailbox_program_id,
        inbox: inbox_account,
        inbox_bump_seed: inbox_bump,
        outbox: outbox_account,
        outbox_bump_seed: outbox_bump,
        default_ism,
    })
}

async fn initialize_test_ism(
    banks_client: &mut BanksClient,
    payer: &Keypair,
) -> Result<(), BanksClientError> {
    println!("Creating test ISM client...");
    let mut test_ism = TestIsmTestClient::new(banks_client.clone(), clone_keypair(payer));
    println!("Initializing test ISM...");
    // TODO: figure out why this call is failing??
    test_ism.init().await?;
    println!("Test ISM initialization complete!");
    Ok(())
}

/// Simulates an instruction, and attempts to deserialize it into a T.
/// If no return data at all was returned, returns Ok(None).
/// If some return data was returned but deserialization was unsuccessful,
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
    let instruction = MessageRecipientInstruction::InterchainSecurityModuleAccountMetas;

    get_account_metas_with_instruction_bytes(
        banks_client,
        payer,
        recipient_program_id,
        &instruction.encode().unwrap(),
        INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
    )
    .await
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
    let instruction = InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction {
        metadata,
        message,
    });

    get_account_metas_with_instruction_bytes(
        banks_client,
        payer,
        ism,
        &instruction.encode().unwrap(),
        VERIFY_ACCOUNT_METAS_PDA_SEEDS,
    )
    .await
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

    get_account_metas_with_instruction_bytes(
        banks_client,
        payer,
        recipient_program_id,
        &instruction.encode().unwrap(),
        HANDLE_ACCOUNT_METAS_PDA_SEEDS,
    )
    .await
}

async fn get_account_metas_with_instruction_bytes(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    program_id: Pubkey,
    instruction_data: &[u8],
    account_metas_pda_seeds: &[&[u8]],
) -> Result<Vec<AccountMeta>, BanksClientError> {
    let (account_metas_pda_key, _) =
        Pubkey::find_program_address(account_metas_pda_seeds, &program_id);
    let instruction = Instruction::new_with_bytes(
        program_id,
        instruction_data,
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
    let accounts = get_process_account_metas(
        banks_client,
        payer,
        mailbox_accounts,
        metadata.clone(),
        message,
    )
    .await?;

    process_with_accounts(
        banks_client,
        payer,
        mailbox_accounts,
        metadata,
        message,
        accounts,
    )
    .await
}

pub async fn process_with_accounts(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    metadata: Vec<u8>,
    message: &HyperlaneMessage,
    accounts: Vec<AccountMeta>,
) -> Result<(Signature, Pubkey), BanksClientError> {
    let mut encoded_message = vec![];
    message.write_to(&mut encoded_message).unwrap();

    let ixn = MailboxInstruction::InboxProcess(InboxProcess {
        metadata: metadata.to_vec(),
        message: encoded_message,
    });
    let ixn_data = ixn.into_instruction_data().unwrap();

    let inbox_instruction = Instruction {
        program_id: mailbox_accounts.program,
        data: ixn_data,
        accounts,
    };
    let recent_blockhash = banks_client.get_latest_blockhash().await?;
    let txn = Transaction::new_signed_with_payer(
        &[inbox_instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    let tx_signature = txn.signatures[0];

    banks_client.process_transaction(txn).await?;

    Ok((
        tx_signature,
        Pubkey::find_program_address(
            mailbox_processed_message_pda_seeds!(message.id()),
            &mailbox_accounts.program,
        )
        .0,
    ))
}

pub async fn get_process_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    mailbox_accounts: &MailboxAccounts,
    metadata: Vec<u8>,
    message: &HyperlaneMessage,
) -> Result<Vec<AccountMeta>, BanksClientError> {
    let mut encoded_message = vec![];
    message.write_to(&mut encoded_message).unwrap();

    let recipient: Pubkey = message.recipient.0.into();

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
        get_ism_verify_account_metas(banks_client, payer, ism, metadata, encoded_message).await?;
    accounts.extend(ism_verify_account_metas);

    // The recipient.
    accounts.extend([AccountMeta::new_readonly(recipient, false)]);

    // Get account metas required for the Handle instruction
    let handle_account_metas = get_handle_account_metas(banks_client, payer, message).await?;
    accounts.extend(handle_account_metas);

    Ok(accounts)
}

// ========= Balance utils =========

pub async fn assert_lamports(
    banks_client: &mut BanksClient,
    account: &Pubkey,
    expected_lamports: u64,
) {
    let account = banks_client.get_account(*account).await.unwrap().unwrap();
    assert_eq!(account.lamports, expected_lamports);
}

pub async fn assert_token_balance(
    banks_client: &mut BanksClient,
    account: &Pubkey,
    expected_balance: u64,
) {
    let data = banks_client
        .get_account(*account)
        .await
        .unwrap()
        .unwrap()
        .data;
    let state = StateWithExtensions::<Account>::unpack(&data).unwrap();
    assert_eq!(state.base.amount, expected_balance);
}

// ========= General purpose utils =========

pub async fn new_funded_keypair(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    lamports: u64,
) -> Keypair {
    let keypair = Keypair::new();
    transfer_lamports(banks_client, payer, &keypair.pubkey(), lamports).await;
    keypair
}

pub async fn transfer_lamports(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    to: &Pubkey,
    lamports: u64,
) {
    process_instruction(
        banks_client,
        solana_sdk::system_instruction::transfer(&payer.pubkey(), to, lamports),
        payer,
        &[payer],
    )
    .await
    .unwrap();
}

pub fn assert_transaction_error<T>(
    result: Result<T, BanksClientError>,
    expected_error: TransactionError,
) {
    // BanksClientError doesn't implement Eq, but TransactionError does
    if let BanksClientError::TransactionError(tx_err) = result.err().unwrap() {
        assert_eq!(tx_err, expected_error);
    } else {
        panic!("expected TransactionError");
    }
}

// Hack to get around the absence of a Clone implementation in solana-sdk 1.14.13.
pub fn clone_keypair(keypair: &Keypair) -> Keypair {
    let serialized = keypair.to_bytes();
    Keypair::from_bytes(&serialized).unwrap()
}

pub async fn process_instruction<T: Signers>(
    banks_client: &mut BanksClient,
    instruction: Instruction,
    payer: &Keypair,
    signers: &T,
) -> Result<Signature, BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        signers,
        recent_blockhash,
    );
    let signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await?;

    Ok(signature)
}
