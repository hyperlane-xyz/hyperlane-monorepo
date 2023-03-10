//! Test client for Hyperlane Sealevel Mailbox contract.

// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use std::str::FromStr as _;

use clap::{Args, Parser, Subcommand};
use hyperlane_sealevel_ism_rubber_stamp::ID as DEFAULT_ISM_PROG_ID;
use hyperlane_sealevel_mailbox::{
    ID as MAILBOX_PROG_ID,
    SPL_NOOP,
    hyperlane_core::{message::HyperlaneMessage, types::H256, Encode},
    accounts::{InboxAccount, OutboxAccount},
    instruction::{
        InboxProcess, Init as InitMailbox, Instruction as MailboxInstruction, OutboxDispatch,
        VERSION,
    },
    mailbox_authority_pda_seeds, mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds
};
use hyperlane_sealevel_recipient_echo::ID as RECIPIENT_ECHO_PROG_ID;
use solana_clap_utils::input_validators::{is_keypair, is_url, normalize_to_url_if_moniker};
use solana_cli_config::{Config, CONFIG_FILE};
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Signer as _},
    system_program,
    transaction::Transaction,
};
// Note: from solana_program_runtime::compute_budget
const DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT: u32 = 200_000;
const MAX_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;
const MAX_HEAP_FRAME_BYTES: u32 = 256 * 1024;

const ECLIPSE_DOMAIN: u32 = 13375; // TODO import from hyperlane

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: MailboxCmd,
    #[arg(long, short)]
    url: Option<String>,
    #[arg(long, short)]
    keypair: Option<String>,
    #[arg(long, short = 'b', default_value_t = MAX_COMPUTE_UNIT_LIMIT)]
    compute_budget: u32,
    #[arg(long, short = 'a')]
    heap_size: Option<u32>,
}

#[derive(Subcommand)]
enum MailboxCmd {
    Init(Init),
    Query(Query),
    Send(Outbox),
    Receive(Inbox),
}

#[derive(Args)]
struct Init {
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    local_domain: u32,
}

#[derive(Args)]
struct Query {
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    local_domain: u32,
}

#[derive(Args)]
struct Outbox {
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    local_domain: u32,
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    destination: u32,
    #[arg(long, short, default_value_t = RECIPIENT_ECHO_PROG_ID)]
    recipient: Pubkey,
    #[arg(long, short, default_value = "Hello, World!")]
    message: String,
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,

    // #[arg(long, short, default_value_t = MAX_MESSAGE_BODY_BYTES)]
    // message_len: usize,
}

#[derive(Args)]
struct Inbox {
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    local_domain: u32,
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    origin: u32,
    #[arg(long, short, default_value_t = RECIPIENT_ECHO_PROG_ID)]
    recipient: Pubkey,
    #[arg(long, short, default_value = "Hello, World!")]
    message: String,
    #[arg(long, short, default_value_t = 1)]
    nonce: u32,
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, default_value_t = DEFAULT_ISM_PROG_ID)]
    ism: Pubkey,
}

// Actual content depends on which ISM is used.
struct ExampleMetadata {
    pub root: H256,
    pub index: u32,
    pub leaf_index: u32,
    // pub proof: [H256; 32],
    pub signatures: Vec<H256>,
}
impl Encode for ExampleMetadata {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(self.root.as_ref())?;
        writer.write_all(&self.index.to_be_bytes())?;
        writer.write_all(&self.leaf_index.to_be_bytes())?;
        // for hash in self.proof {
        //     writer.write_all(hash.as_ref())?;
        // }
        for signature in &self.signatures {
            writer.write_all(signature.as_ref())?;
        }
        Ok(32 + 4 + 4 + (32 * 32) + (self.signatures.len() * 32))
    }
}

fn main() {
    pretty_env_logger::init();

    let cli = Cli::parse();
    let config = match CONFIG_FILE.as_ref() {
        Some(config_file) => Config::load(config_file).unwrap(),
        None => Config::default(),
    };
    let url = normalize_to_url_if_moniker(cli.url.unwrap_or(config.json_rpc_url));
    is_url(&url).unwrap();
    let keypair_path = cli.keypair.unwrap_or(config.keypair_path);
    is_keypair(&keypair_path).unwrap();

    let client = RpcClient::new(url);
    let payer = read_keypair_file(keypair_path).unwrap();
    let commitment = CommitmentConfig::confirmed();

    let mut instructions = vec![];
    if cli.compute_budget != DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT {
        assert!(cli.compute_budget <= MAX_COMPUTE_UNIT_LIMIT);
        instructions.push(ComputeBudgetInstruction::set_compute_unit_limit(
            cli.compute_budget,
        ));
    }
    if let Some(heap_size) = cli.heap_size {
        assert!(heap_size <= MAX_HEAP_FRAME_BYTES);
        instructions.push(ComputeBudgetInstruction::request_heap_frame(heap_size));
    }

    match cli.cmd {
        MailboxCmd::Init(init) => {
            let (auth_account, auth_bump) = Pubkey::find_program_address(
                mailbox_authority_pda_seeds!(init.local_domain),
                &init.program_id,
            );
            let (inbox_account, inbox_bump) = Pubkey::find_program_address(
                mailbox_inbox_pda_seeds!(init.local_domain),
                &init.program_id,
            );
            let (outbox_account, outbox_bump) = Pubkey::find_program_address(
                mailbox_outbox_pda_seeds!(init.local_domain),
                &init.program_id,
            );

            let ixn = MailboxInstruction::Init(InitMailbox {
                local_domain: init.local_domain,
                auth_bump_seed: auth_bump,
                inbox_bump_seed: inbox_bump,
                outbox_bump_seed: outbox_bump,
            });
            let init_instruction = Instruction {
                program_id: init.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts: vec![
                    AccountMeta::new(system_program::ID, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new(auth_account, false),
                    AccountMeta::new(inbox_account, false),
                    AccountMeta::new(outbox_account, false),
                ],
            };

            let recent_blockhash = client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &[init_instruction],
                Some(&payer.pubkey()),
                &[&payer],
                recent_blockhash,
            );

            let signature = client.send_transaction(&txn).unwrap();
            client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, commitment)
                .unwrap();

            println!("auth=({}, {})", auth_account, auth_bump);
            println!("inbox=({}, {})", inbox_account, inbox_bump);
            println!("outbox=({}, {})", outbox_account, outbox_bump);
        }
        MailboxCmd::Query(query) => {
            let (auth_account, auth_bump) = Pubkey::find_program_address(
                mailbox_authority_pda_seeds!(query.local_domain),
                &query.program_id,
            );
            let (inbox_account, inbox_bump) = Pubkey::find_program_address(
                mailbox_inbox_pda_seeds!(query.local_domain),
                &query.program_id,
            );
            let (outbox_account, outbox_bump) = Pubkey::find_program_address(
                mailbox_outbox_pda_seeds!(query.local_domain),
                &query.program_id,
            );

            let accounts = client
                .get_multiple_accounts(&[auth_account, inbox_account, outbox_account])
                .unwrap();
            println!("domain={}", query.local_domain);
            println!("mailbox={}", query.program_id);
            println!("--------------------------------");
            println!("Authority: {}, bump={}", auth_account, auth_bump);
            if let Some(info) = &accounts[0] {
                println!("{:#?}", info);
            } else {
                println!("Not yet created?");
            }
            println!("--------------------------------");
            println!("Inbox: {}, bump={}", inbox_account, inbox_bump);
            if let Some(info) = &accounts[1] {
                println!("{:#?}", info);
                match InboxAccount::fetch(&mut info.data.as_ref()) {
                    Ok(inbox) => println!("{:#?}", inbox.into_inner()),
                    Err(err) => println!("Failed to deserialize account data: {}", err),
                }
            } else {
                println!("Not yet created?");
            }
            println!("--------------------------------");
            println!("Outbox: {}, bump={}", outbox_account, outbox_bump);
            if let Some(info) = &accounts[2] {
                println!("{:#?}", info);
                match OutboxAccount::fetch(&mut info.data.as_ref()) {
                    Ok(outbox) => println!("{:#?}", outbox.into_inner()),
                    Err(err) => println!("Failed to deserialize account data: {}", err),
                }
            } else {
                println!("Not yet created?");
            }
        }
        MailboxCmd::Send(outbox) => {
            let (outbox_account, _outbox_bump) = Pubkey::find_program_address(
                mailbox_outbox_pda_seeds!(outbox.local_domain),
                &outbox.program_id,
            );
            let ixn = MailboxInstruction::OutboxDispatch(OutboxDispatch {
                sender: payer.pubkey(),
                local_domain: outbox.local_domain,
                destination_domain: outbox.destination,
                recipient: H256(outbox.recipient.to_bytes()),
                message_body: outbox.message.into(),
                // message_body: std::iter::repeat(0x41).take(outbox.message_len).collect(),
            });
            let outbox_instruction = Instruction {
                program_id: outbox.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts: vec![
                    AccountMeta::new(outbox_account, false),
                    AccountMeta::new_readonly(payer.pubkey(), true),
                    AccountMeta::new_readonly(Pubkey::from_str(SPL_NOOP).unwrap(), false),
                ],
            };
            instructions.push(outbox_instruction);
            let recent_blockhash = client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &instructions,
                Some(&payer.pubkey()),
                &[&payer],
                recent_blockhash,
            );

            let signature = client.send_transaction(&txn).unwrap();
            client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, commitment)
                .unwrap();
        }
        MailboxCmd::Receive(inbox) => {
            let (inbox_account, _inbox_bump) = Pubkey::find_program_address(
                mailbox_inbox_pda_seeds!(inbox.local_domain),
                &inbox.program_id,
            );
            let (auth_account, _auth_bump) = Pubkey::find_program_address(
                mailbox_authority_pda_seeds!(inbox.local_domain),
                &inbox.program_id,
            );
            let hyperlane_message = HyperlaneMessage {
                version: VERSION,
                nonce: inbox.nonce,
                origin: inbox.origin,
                sender: H256::repeat_byte(123),
                destination: inbox.local_domain,
                recipient: H256::from(inbox.recipient.to_bytes()),
                body: inbox.message.bytes().collect(),
            };
            let mut encoded_message = vec![];
            hyperlane_message.write_to(&mut encoded_message).unwrap();
            let metadata = ExampleMetadata {
                root: Default::default(),
                index: 1,
                leaf_index: 0,
                // proof: Default::default(),
                signatures: vec![],
            };
            let mut encoded_metadata = vec![];
            metadata.write_to(&mut encoded_metadata).unwrap();

            let ixn = MailboxInstruction::InboxProcess(InboxProcess {
                metadata: encoded_metadata,
                message: encoded_message,
            });
            let inbox_instruction = Instruction {
                program_id: inbox.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts: vec![
                    AccountMeta::new(inbox_account, false),
                    AccountMeta::new_readonly(auth_account, false),
                    AccountMeta::new_readonly(Pubkey::from_str(SPL_NOOP).unwrap(), false),
                    AccountMeta::new_readonly(inbox.ism, false),
                    AccountMeta::new_readonly(inbox.recipient, false),
                    // Note: we would have to provide ism accounts and recipient accounts here if
                    // they were to use other accounts.
                ],
            };
            instructions.push(inbox_instruction);
            let recent_blockhash = client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &instructions,
                Some(&payer.pubkey()),
                &[&payer],
                recent_blockhash,
            );

            let signature = client.send_transaction(&txn).unwrap();
            client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, commitment)
                .unwrap();
        }
    };
}
