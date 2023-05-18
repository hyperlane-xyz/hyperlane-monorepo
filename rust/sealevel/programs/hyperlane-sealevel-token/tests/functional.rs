//! Contains functional tests for things that cannot be done
//! strictly in unit tests. This includes CPIs, like creating
//! new PDA accounts.

use hyperlane_core::{Encode, H256};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};

use hyperlane_sealevel_mailbox::{
    instruction::{
        Init as InitMailbox, Instruction as MailboxInstruction, MailboxRecipientInstruction,
    },
    mailbox_authority_pda_seeds, mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds,
};
use hyperlane_sealevel_token::{
    hyperlane_token_mint_pda_seeds, hyperlane_token_pda_seeds,
    instruction::{Init, Instruction as HyperlaneTokenInstruction, TransferRemote},
    message::TokenMessage,
    processor::process_instruction,
};
use solana_program_test::*;
use solana_sdk::{signature::Signer, signer::keypair::Keypair, transaction::Transaction};
use spl_token_2022::{
    extension::StateWithExtensions, instruction::initialize_mint2, state::Account,
};

async fn new_funded_keypair(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    lamports: u64,
) -> Keypair {
    let keypair = Keypair::new();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_with_payer(
        &[solana_sdk::system_instruction::transfer(
            &payer.pubkey(),
            &keypair.pubkey(),
            lamports,
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();
    keypair
}

struct MailboxAccounts {
    program: Pubkey,
    auth: Pubkey,
    #[allow(dead_code)]
    inbox: Pubkey,
    outbox: Pubkey,
}

async fn initialize_mailbox(
    banks_client: &mut BanksClient,
    mailbox_program_id: &Pubkey,
    payer: &Keypair,
    local_domain: u32,
) -> MailboxAccounts {
    let (auth_account, auth_bump) = Pubkey::find_program_address(
        mailbox_authority_pda_seeds!(local_domain),
        mailbox_program_id,
    );
    let (inbox_account, inbox_bump) =
        Pubkey::find_program_address(mailbox_inbox_pda_seeds!(local_domain), mailbox_program_id);
    let (outbox_account, outbox_bump) =
        Pubkey::find_program_address(mailbox_outbox_pda_seeds!(local_domain), mailbox_program_id);

    let ixn = MailboxInstruction::Init(InitMailbox {
        local_domain,
        auth_bump_seed: auth_bump,
        inbox_bump_seed: inbox_bump,
        outbox_bump_seed: outbox_bump,
    });
    let init_instruction = Instruction {
        program_id: *mailbox_program_id,
        data: ixn.into_instruction_data().unwrap(),
        accounts: vec![
            AccountMeta::new(system_program::id(), false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(auth_account, false),
            AccountMeta::new(inbox_account, false),
            AccountMeta::new(outbox_account, false),
        ],
    };

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let mut transaction = Transaction::new_signed_with_payer(
        &[init_instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    transaction.sign(&[payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    MailboxAccounts {
        program: *mailbox_program_id,
        auth: auth_account,
        inbox: inbox_account,
        outbox: outbox_account,
    }
}

#[tokio::test]
async fn test_initialize() {
    let local_domain: u32 = 1234;
    let remote_domain: u32 = 4321;
    let local_decimals: u8 = 8;

    let program_id = hyperlane_sealevel_token::id();
    let mut program_test = ProgramTest::new(
        "hyperlane_sealevel_token",
        program_id,
        processor!(process_instruction),
    );

    program_test.add_program(
        "spl_token_2022",
        spl_token_2022::id(),
        processor!(spl_token_2022::processor::Processor::process),
    );

    program_test.add_program(
        "spl_associated_token_account",
        spl_associated_token_account::id(),
        processor!(spl_associated_token_account::processor::process_instruction),
    );

    program_test.add_program("spl_noop", spl_noop::id(), processor!(spl_noop::noop));

    let mailbox_program_id = hyperlane_sealevel_mailbox::id();
    program_test.add_program(
        "hyperlane_sealevel_mailbox",
        mailbox_program_id,
        processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
    );

    let (mut banks_client, payer, recent_blockhash) = program_test.start().await;

    let mailbox_accounts =
        initialize_mailbox(&mut banks_client, &mailbox_program_id, &payer, local_domain).await;

    let (token_account_key, _token_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &program_id);

    let (mint_account_key, _mint_account_bump_seed) =
        Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), &program_id);

    let mut transaction = Transaction::new_with_payer(
        &[
            Instruction::new_with_bytes(
                program_id,
                &MailboxRecipientInstruction::Custom(HyperlaneTokenInstruction::Init(Init {
                    mailbox: hyperlane_sealevel_mailbox::id(),
                    mailbox_local_domain: local_domain,
                }))
                .into_instruction_data()
                .unwrap(),
                vec![
                    AccountMeta::new_readonly(solana_program::system_program::id(), false),
                    AccountMeta::new(token_account_key, false),
                    AccountMeta::new(mint_account_key, false),
                    AccountMeta::new_readonly(payer.pubkey(), true),
                ],
            ),
            initialize_mint2(
                &spl_token_2022::id(),
                &mint_account_key,
                &mint_account_key,
                None,
                local_decimals,
            )
            .unwrap(),
        ],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    // Try minting some innit

    let recipient_keypair = new_funded_keypair(&mut banks_client, &payer, 1000000).await;
    let recipient: H256 = recipient_keypair.pubkey().to_bytes().into();

    // 0. [signer] mailbox authority
    // 1. [executable] system_program
    // 2. [executable] spl_noop
    // 3. [] hyperlane_token storage
    // 4. [] recipient wallet address
    // 5. [signer] payer // <- TODO this should NOT be required as a signer
    // 6. [executable] SPL token 2022 program
    // 7. [executable] SPL associated token account
    // 8. [writeable] Mint account
    // 9. [writeable] Recipient associated token account

    let recipient_associated_token_account =
        spl_associated_token_account::get_associated_token_address_with_program_id(
            &recipient_keypair.pubkey(),
            &mint_account_key,
            &spl_token_2022::id(),
        );

    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &MailboxRecipientInstruction::<()>::new_mailbox_recipient_cpi(
                // TODO change
                H256::zero(),
                remote_domain,
                TokenMessage::new_erc20(recipient, 100u64.into(), vec![]).to_vec(),
            )
            .into_instruction_data()
            .unwrap(),
            vec![
                // TODO this will need to be a signer
                AccountMeta::new_readonly(mailbox_accounts.auth, false),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new_readonly(token_account_key, false),
                AccountMeta::new_readonly(recipient_keypair.pubkey(), false),
                // TODO try to make this not a signer
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                AccountMeta::new(mint_account_key, false),
                AccountMeta::new(recipient_associated_token_account, false),
            ],
        )],
        Some(&payer.pubkey()),
    );
    transaction.sign(&[&payer], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    let recipient_associated_token_account_data = banks_client
        .get_account(recipient_associated_token_account)
        .await
        .unwrap()
        .unwrap()
        .data;
    let recipient_ata_state =
        StateWithExtensions::<Account>::unpack(&recipient_associated_token_account_data).unwrap();

    // Check that the recipient got the tokens!
    // TODO add total supply check
    assert_eq!(recipient_ata_state.base.amount, 100u64);

    // Let's try transferring some tokens to the remote domain now

    let mut transaction = Transaction::new_with_payer(
        &[Instruction::new_with_bytes(
            program_id,
            &MailboxRecipientInstruction::Custom(HyperlaneTokenInstruction::TransferRemote(
                TransferRemote {
                    destination_domain: remote_domain,
                    /// TODO imply this from Router
                    destination_program_id: H256::random(),
                    recipient: H256::random(),
                    amount_or_id: 69u64.into(),
                },
            ))
            .into_instruction_data()
            .unwrap(),
            vec![
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new_readonly(token_account_key, false),
                AccountMeta::new_readonly(mailbox_accounts.program, false),
                AccountMeta::new(mailbox_accounts.outbox, false),
                AccountMeta::new_readonly(recipient_keypair.pubkey(), true),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new(mint_account_key, false),
                AccountMeta::new(recipient_associated_token_account, false),
            ],
        )],
        Some(&recipient_keypair.pubkey()),
    );
    transaction.sign(&[&recipient_keypair], recent_blockhash);
    banks_client.process_transaction(transaction).await.unwrap();

    let recipient_associated_token_account_data = banks_client
        .get_account(recipient_associated_token_account)
        .await
        .unwrap()
        .unwrap()
        .data;
    let recipient_ata_state =
        StateWithExtensions::<Account>::unpack(&recipient_associated_token_account_data).unwrap();

    // Check that the sender burned the tokens!
    // TODO add total supply check
    assert_eq!(recipient_ata_state.base.amount, 31u64);
}
