//! Test client for Hyperlane Sealevel Mailbox contract.

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use std::str::FromStr as _;

use clap::{Args, Parser, Subcommand};
use hyperlane_sealevel_mailbox::{
    hyperlane_core::{
        Encode,
        message::HyperlaneMessage,
        types::H256,
    },
    accounts::CONFIG_ACCOUNT_SIZE,
    instruction::{
        Instruction as MailboxInstruction,
        InboxProcess,
        MAX_MESSAGE_BODY_BYTES,
        OutboxDispatch,
        VERSION
    },
};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Signer as _, read_keypair_file},
    signer::keypair::Keypair,
    system_instruction,
    transaction::Transaction,
};
use solana_client::rpc_client::RpcClient;
use solana_cli_config::{CONFIG_FILE, Config};
use solana_clap_utils::input_validators::{
    is_keypair,
    is_url,
    normalize_to_url_if_moniker,
};
// Note: from solana_program_runtime::compute_budget
const DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT: u32 = 200_000;
const MAX_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;
const MAX_HEAP_FRAME_BYTES: u32 = 256 * 1024;

// FIXME can we import from libs?
lazy_static::lazy_static! {
    static ref MAILBOX_PROG_ID: Pubkey = Pubkey::from_str(
        "8TibDpWMQfTjG6JxvF85pxJXxwqXZUCuUx3Q1vwojvRh"
    ).unwrap();
    static ref INBOX_ACCOUNT: Pubkey = Pubkey::from_str(
        "CGmTMdoLqRBpaP8sfsEozFkopJVmaSCLUDpG2kPiYjRQ"
    ).unwrap();
    static ref OUTBOX_ACCOUNT: Pubkey = Pubkey::from_str(
        "5AsfPQ8j5RzFP7uq72DtrkgqNvKNwndsrFLsM88axHpt"
    ).unwrap();
    static ref CONFIG_ACCOUNT: Pubkey = Pubkey::from_str(
        "AxCerXNwKLKqPmCs4iJ37A65kcSyBjvezENUL8s8KLmL"
    ).unwrap();
    static ref DEFAULT_ISM_PROG_ID: Pubkey = Pubkey::from_str(
        "6TCwgXydobJUEqabm7e6SL4FMdiFDvp1pmYoL6xXmRJq"
    ).unwrap();
    static ref RECIPIENT_ECHO_PROG_ID: Pubkey = Pubkey::from_str(
        "AziCxohg8Tw46EsZGUCvxsVbqFmJVnSWuEqoTKaAfNiC"
    ).unwrap();
}

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
    CreateAccounts(CreateAccounts),
    Send(Outbox),
    Receive(Inbox),
}

#[derive(Args)]
struct CreateAccounts {
    #[arg(long, short, default_value_t = *MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = *OUTBOX_ACCOUNT)]
    outbox_account: Pubkey,
    #[arg(long, short, default_value_t = *INBOX_ACCOUNT)]
    inbox_account: Pubkey,
    #[arg(long, short, default_value_t = *CONFIG_ACCOUNT)]
    config_account: Pubkey,
}

#[derive(Args)]
struct Outbox {
    #[arg(long, short, default_value_t = u32::MAX)]
    destination: u32,
    #[arg(long, short, default_value_t = *RECIPIENT_ECHO_PROG_ID)]
    recipient: Pubkey,
    // #[arg(long, short, default_value = "Hello, World!")]
    // message: String,
    #[arg(long, short, default_value_t = *MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = *OUTBOX_ACCOUNT)]
    outbox_account: Pubkey,
    #[arg(long, short, default_value_t = *CONFIG_ACCOUNT)]
    config_account: Pubkey,

    #[arg(long, short, default_value_t = MAX_MESSAGE_BODY_BYTES)]
    message_len: usize,
}

#[derive(Args)]
struct Inbox {
    #[arg(long, short, default_value_t = u32::MAX)]
    origin: u32,
    #[arg(long, short, default_value_t = *RECIPIENT_ECHO_PROG_ID)]
    recipient: Pubkey,
    #[arg(long, short, default_value = "Hello, World!")]
    message: String,
    #[arg(long, short, default_value_t = 1)]
    nonce: u32,
    #[arg(long, short, default_value_t = *MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = *INBOX_ACCOUNT)]
    inbox_account: Pubkey,
    #[arg(long, short, default_value_t = *CONFIG_ACCOUNT)]
    config_account: Pubkey,
    #[arg(long, default_value_t = *DEFAULT_ISM_PROG_ID)]
    ism: Pubkey,
}

fn create_account(
    client: &RpcClient,
    payer: &Keypair,
    owner: &Pubkey,
    seed: &str,
    size: usize,
) -> Pubkey {
    // FIXME what is meant by "base" pubkey here?
    let account = Pubkey::create_with_seed(&payer.pubkey(), seed, &owner).unwrap();

    let commitment = CommitmentConfig::confirmed();
    match client.get_account_with_commitment(&account, commitment).unwrap().value {
        Some(account) => {
            if account.owner != *owner {
                panic!("data account has incorrect owner: {}", account.owner);
            }
        },
        None => {
            let rent_exemption_amount = client
                .get_minimum_balance_for_rent_exemption(size)
                .unwrap();
            let recent_blockhash = client.get_latest_blockhash().unwrap();
            let instruction = system_instruction::create_account_with_seed(
                &payer.pubkey(),
                &account,
                &payer.pubkey(),
                seed,
                rent_exemption_amount,
                size.try_into().unwrap(),
                &owner
            );
            let txn = Transaction::new_signed_with_payer(
                &[instruction],
                Some(&payer.pubkey()),
                &[payer],
                recent_blockhash,
            );
            let signature = client.send_transaction(&txn).unwrap();
            client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, commitment)
                .unwrap();
        },
    };
    account
}

struct ExampleMetadata { // Depends on which ISM is used.
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
        writer.write_all(&self.root.as_ref())?;
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
        Some(config_file) => {
            Config::load(&config_file).unwrap()
        },
        None => {
            Config::default()
        }
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
        instructions.push(ComputeBudgetInstruction::set_compute_unit_limit(cli.compute_budget));
    }
    if let Some(heap_size) = cli.heap_size {
        assert!(heap_size <= MAX_HEAP_FRAME_BYTES);
        instructions.push(ComputeBudgetInstruction::request_heap_frame(heap_size));
    }

    match cli.cmd {
        MailboxCmd::CreateAccounts(create) => {
            let config = create_account(
                &client,
                &payer,
                &create.program_id,
                "hyperlane_mailbox_config",
                CONFIG_ACCOUNT_SIZE,
            );
            println!("config_account={}", config);
            let mailbox_size = 10_000_000;
            let outbox = create_account(
                &client,
                &payer,
                &create.program_id,
                "hyperlane_mailbox_outbox",
                mailbox_size,
            );
            println!("outbox_account={}", outbox);
            let inbox = create_account(
                &client,
                &payer,
                &create.program_id,
                "hyperlane_mailbox_inbox",
                mailbox_size,
            );
            println!("inbox_account={}", inbox);
        },
        MailboxCmd::Send(outbox) => {
            let ixn = MailboxInstruction::OutboxDispatch(OutboxDispatch {
                sender: payer.pubkey(),
                destination_domain: outbox.destination.into(),
                recipient: H256(outbox.recipient.to_bytes()),
                message_body: std::iter::repeat(0x41).take(outbox.message_len).collect(),
            });
            let outbox_instruction = Instruction {
                program_id: outbox.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts: vec![
                    AccountMeta::new(outbox.outbox_account, false),
                    AccountMeta::new(outbox.config_account, false),
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
        },
        MailboxCmd::Receive(inbox) => {
            let hyperlane_message = HyperlaneMessage {
                version: VERSION,
                nonce: inbox.nonce,
                origin: inbox.origin.into(),
                sender: H256::repeat_byte(123),
                destination: u32::MAX,
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
                    AccountMeta::new(inbox.inbox_account, false),
                    AccountMeta::new_readonly(inbox.config_account, false),
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
        },
    };
}
