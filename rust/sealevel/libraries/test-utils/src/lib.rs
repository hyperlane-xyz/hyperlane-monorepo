use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::*;
use solana_sdk::{
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

use spl_token_2022::{extension::StateWithExtensions, state::Account};

use hyperlane_sealevel_mailbox::{
    instruction::{Init as InitMailbox, Instruction as MailboxInstruction},
    mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds,
};

// ========= Mailbox =========

pub struct MailboxAccounts {
    pub program: Pubkey,
    pub inbox: Pubkey,
    pub inbox_bump_seed: u8,
    pub outbox: Pubkey,
    pub outbox_bump_seed: u8,
}

pub async fn initialize_mailbox(
    banks_client: &mut BanksClient,
    mailbox_program_id: &Pubkey,
    payer: &Keypair,
    local_domain: u32,
) -> Result<MailboxAccounts, BanksClientError> {
    let (inbox_account, inbox_bump) =
        Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), mailbox_program_id);
    let (outbox_account, outbox_bump) =
        Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), mailbox_program_id);

    let ixn = MailboxInstruction::Init(InitMailbox {
        local_domain,
        default_ism: hyperlane_sealevel_ism_rubber_stamp::id(),
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

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[init_instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await?;

    Ok(MailboxAccounts {
        program: *mailbox_program_id,
        inbox: inbox_account,
        inbox_bump_seed: inbox_bump,
        outbox: outbox_account,
        outbox_bump_seed: outbox_bump,
    })
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
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[solana_sdk::system_instruction::transfer(
            &payer.pubkey(),
            to,
            lamports,
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await.unwrap();
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
