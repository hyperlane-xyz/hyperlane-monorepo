//! Test client for Hyperlane Sealevel Mailbox contract.

// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use std::str::FromStr as _;

use clap::{Args, Parser, Subcommand};
use hyperlane_sealevel_ism_rubber_stamp::ID as DEFAULT_ISM_PROG_ID;
use hyperlane_sealevel_mailbox::{
    ID as MAILBOX_PROG_ID,
    spl_noop,
    hyperlane_core::{message::HyperlaneMessage, types::{H256, U256}, Encode},
    accounts::{InboxAccount, OutboxAccount},
    instruction::{
        InboxProcess, Init as InitMailbox, Instruction as MailboxInstruction, OutboxDispatch,
        MailboxRecipientInstruction, VERSION,
    },
    mailbox_authority_pda_seeds, mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds
};
use hyperlane_sealevel_recipient_echo::ID as RECIPIENT_ECHO_PROG_ID;
use hyperlane_sealevel_token::{
    ID as HYPERLANE_ERC20_PROG_ID,
    accounts::HyperlaneErc20Account,
    hyperlane_token_erc20_pda_seeds,
    hyperlane_token_mint_pda_seeds,
    instruction::{
        Instruction as Erc20Instruction, Init as Erc20Init, TokenMessage as Erc20Message,
        TransferFromRemote as Erc20TransferFromRemote,
        TransferFromSender as Erc20TransferFromSender, TransferRemote as Erc20TransferRemote,
        TransferTo as Erc20TransferTo
    },
    spl_associated_token_account::{self, get_associated_token_address_with_program_id},
    spl_token_2022,
};
use solana_clap_utils::input_validators::{is_keypair, is_url, normalize_to_url_if_moniker};
use solana_cli_config::{Config, CONFIG_FILE};
use solana_client::{rpc_client::RpcClient, rpc_config::RpcSendTransactionConfig};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, read_keypair_file, Signer as _},
    system_program,
    transaction::Transaction,
};
// Note: from solana_program_runtime::compute_budget
const DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT: u32 = 200_000;
const MAX_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;
const MAX_HEAP_FRAME_BYTES: u32 = 256 * 1024;

const ECLIPSE_DOMAIN: u32 = 13375; // TODO import from hyperlane

// TODO use real paymaster - it is ignored currently...
static INTERCHAIN_GAS_PAYMASTER_PROG_ID: Pubkey = MAILBOX_PROG_ID;

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: HyperlaneSealevelCmd,
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
enum HyperlaneSealevelCmd {
    Mailbox(MailboxCmd),
    Token(TokenCmd),
}

#[derive(Args)]
struct MailboxCmd {
    #[command(subcommand)]
    cmd: MailboxSubCmd,
}

#[derive(Subcommand)]
enum MailboxSubCmd {
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

#[derive(Args)]
struct TokenCmd {
    #[command(subcommand)]
    cmd: TokenSubCmd,
}

#[derive(Subcommand)]
enum TokenSubCmd {
    Init(TokenInit),
    Query(TokenQuery),
    TransferRemote(TokenTransferRemote),
    TransferFromRemote(TokenTransferFromRemote),

    // FIXME get rid of these?
    TransferFromSender(TokenTransferFromSender),
    TransferTo(TokenTransferTo),
}

#[derive(Args)]
struct TokenInit {
    #[arg(long, short, default_value_t = HYPERLANE_ERC20_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    mailbox: Pubkey,
    #[arg(long, short = 'd', default_value_t = ECLIPSE_DOMAIN)]
    mailbox_local_domain: u32,
    #[arg(long, short, default_value_t = INTERCHAIN_GAS_PAYMASTER_PROG_ID)]
    interchain_gas_paymaster: Pubkey,
    #[arg(long, short, default_value_t = u64::MAX)]
    total_supply: u64,
    #[arg(long, short, default_value_t = ("MOON_SPL".to_string()))]
    name: String,
    #[arg(long, short, default_value_t = ("$".to_string()))]
    symbol: String,
}

#[derive(Args)]
struct TokenQuery {
    #[arg(long, short, default_value_t = HYPERLANE_ERC20_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ("MOON_SPL".to_string()))]
    name: String,
    #[arg(long, short, default_value_t = ("$".to_string()))]
    symbol: String,
}

#[derive(Args)]
struct TokenTransferRemote {
    #[arg(long, short, default_value_t = HYPERLANE_ERC20_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ("MOON_SPL".to_string()))]
    name: String,
    #[arg(long, short, default_value_t = ("$".to_string()))]
    symbol: String,
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    mailbox: Pubkey,
    #[arg(long, short = 'd', default_value_t = ECLIPSE_DOMAIN)]
    mailbox_local_domain: u32,
    // Note this is the keypair for normal account not the derived associated token account or delegate.
    sender: String,
    amount: u64,
    // #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    destination_domain: u32,
    #[arg(long, short = 't', default_value_t = HYPERLANE_ERC20_PROG_ID)]
    destination_token_program_id: Pubkey,
    recipient: Pubkey,
}

// FIXME once check for mailbox inbox calling the token contract, we will need to trigger this
// through the mailbox as recipient
#[derive(Args)]
struct TokenTransferFromRemote {
    #[arg(long, short, default_value_t = HYPERLANE_ERC20_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ("MOON_SPL".to_string()))]
    name: String,
    #[arg(long, short, default_value_t = ("$".to_string()))]
    symbol: String,
    // #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    origin_domain: u32,
    // Note this is normal account not the derived associated token account.
    recipient: Pubkey,
    amount: u64,
}

// FIXME remove?
#[derive(Args)]
struct TokenTransferFromSender {
    #[arg(long, short, default_value_t = HYPERLANE_ERC20_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ("MOON_SPL".to_string()))]
    name: String,
    #[arg(long, short, default_value_t = ("$".to_string()))]
    symbol: String,
    // Note this is the keypair for normal account not the derived associated token account or delegate.
    sender: String,
    amount: u64,
}

// FIXME remove?
#[derive(Args)]
struct TokenTransferTo {
    #[arg(long, short, default_value_t = HYPERLANE_ERC20_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ("MOON_SPL".to_string()))]
    name: String,
    #[arg(long, short, default_value_t = ("$".to_string()))]
    symbol: String,
    // Note this is normal account not the derived associated token account.
    recipient: Pubkey,
    amount: u64,
}

struct Context {
    client: RpcClient,
    payer: Keypair,
    commitment: CommitmentConfig,
    instructions: Vec<Instruction>,
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

    let ctx = Context {
        client,
        payer,
        commitment,
        instructions
    };
    match cli.cmd {
        HyperlaneSealevelCmd::Mailbox(cmd) => process_mailbox_cmd(ctx, cmd),
        HyperlaneSealevelCmd::Token(cmd) => process_token_cmd(ctx, cmd),
    }
}

fn process_mailbox_cmd(mut ctx: Context, cmd: MailboxCmd) {
    match cmd.cmd {
        MailboxSubCmd::Init(init) => {
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
                    AccountMeta::new(system_program::id(), false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new(auth_account, false),
                    AccountMeta::new(inbox_account, false),
                    AccountMeta::new(outbox_account, false),
                ],
            };

            let recent_blockhash = ctx.client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &[init_instruction],
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            );

            let signature = ctx.client.send_transaction(&txn).unwrap();
            ctx.client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, ctx.commitment)
                .unwrap();

            println!("auth=({}, {})", auth_account, auth_bump);
            println!("inbox=({}, {})", inbox_account, inbox_bump);
            println!("outbox=({}, {})", outbox_account, outbox_bump);
        }
        MailboxSubCmd::Query(query) => {
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

            let accounts = ctx
                .client
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
        MailboxSubCmd::Send(outbox) => {
            let (outbox_account, _outbox_bump) = Pubkey::find_program_address(
                mailbox_outbox_pda_seeds!(outbox.local_domain),
                &outbox.program_id,
            );
            let ixn = MailboxInstruction::OutboxDispatch(OutboxDispatch {
                sender: ctx.payer.pubkey(),
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
                    AccountMeta::new_readonly(ctx.payer.pubkey(), true),
                    AccountMeta::new_readonly(spl_noop::id(), false),
                ],
            };
            ctx.instructions.push(outbox_instruction);
            let recent_blockhash = ctx.client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &ctx.instructions,
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            );

            let signature = ctx.client.send_transaction(&txn).unwrap();
            ctx
                .client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, ctx.commitment)
                .unwrap();
        }
        MailboxSubCmd::Receive(inbox) => {
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
                    AccountMeta::new_readonly(spl_noop::id(), false),
                    AccountMeta::new_readonly(inbox.ism, false),
                    AccountMeta::new_readonly(inbox.recipient, false),
                    // Note: we would have to provide ism accounts and recipient accounts here if
                    // they were to use other accounts.
                ],
            };
            ctx.instructions.push(inbox_instruction);
            let recent_blockhash = ctx.client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &ctx.instructions,
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            );

            let signature = ctx.client.send_transaction(&txn).unwrap();
            ctx
                .client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, ctx.commitment)
                .unwrap();
        }
    };
}

fn process_token_cmd(mut ctx: Context, cmd: TokenCmd) {
    match cmd.cmd {
        TokenSubCmd::Init(init) => {
            let (erc20_account, erc20_bump) = Pubkey::find_program_address(
                hyperlane_token_erc20_pda_seeds!(init.name, init.symbol),
                &init.program_id,
            );
            let (mint_account, mint_bump) = Pubkey::find_program_address(
                hyperlane_token_mint_pda_seeds!(init.name, init.symbol),
                &init.program_id,
            );
            let (mailbox_outbox_account, _mailbox_outbox_bump) = Pubkey::find_program_address(
                mailbox_outbox_pda_seeds!(init.mailbox_local_domain),
                &init.mailbox,
            );

            let ixn = MailboxRecipientInstruction::new_custom(Erc20Instruction::Init(Erc20Init {
                mailbox: init.mailbox,
                mailbox_outbox: mailbox_outbox_account,
                mailbox_local_domain: init.mailbox_local_domain,
                interchain_gas_paymaster: init.interchain_gas_paymaster,
                total_supply: init.total_supply.into(),
                name: init.name,
                symbol: init.symbol,
            }));
            let init_instruction = Instruction {
                program_id: init.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts: vec![
                    AccountMeta::new_readonly(system_program::id(), false),
                    AccountMeta::new_readonly(spl_token_2022::id(), false),
                    AccountMeta::new(ctx.payer.pubkey(), true),
                    AccountMeta::new(erc20_account, false),
                    AccountMeta::new(mint_account, false),
                ],
            };
            ctx.instructions.push(init_instruction);

            let recent_blockhash = ctx.client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &ctx.instructions,
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            );

            let signature = ctx.client.send_transaction(&txn).unwrap();
            ctx.client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, ctx.commitment)
                .unwrap();

            println!("erc20=({}, {})", erc20_account, erc20_bump);
            println!("mint=({}, {})", mint_account, mint_bump);
        },
        TokenSubCmd::Query(query) => {
            let (erc20_account, erc20_bump) = Pubkey::find_program_address(
                hyperlane_token_erc20_pda_seeds!(query.name, query.symbol),
                &query.program_id,
            );
            let (mint_account, mint_bump) = Pubkey::find_program_address(
                hyperlane_token_mint_pda_seeds!(query.name, query.symbol),
                &query.program_id,
            );

            let accounts = ctx
                .client
                .get_multiple_accounts(&[erc20_account, mint_account])
                .unwrap();
            println!("hyperlane-sealevel-token={}", query.program_id);
            println!("--------------------------------");
            println!("ERC20: {}, bump={}", erc20_account, erc20_bump);
            if let Some(info) = &accounts[0] {
                println!("{:#?}", info);
                match HyperlaneErc20Account::fetch(&mut info.data.as_ref()) {
                    Ok(erc20) => println!("{:#?}", erc20.into_inner()),
                    Err(err) => println!("Failed to deserialize account data: {}", err),
                }
            } else {
                println!("Not yet created?");
            }
            println!("--------------------------------");
            println!("Mint / Mint Authority: {}, bump={}", mint_account, mint_bump);
            if let Some(info) = &accounts[1] {
                println!("{:#?}", info);
                use solana_program::program_pack::Pack as _;
                match spl_token_2022::state::Mint::unpack_from_slice(info.data.as_ref()) {
                    Ok(mint) => println!("{:#?}", mint),
                    Err(err) => println!("Failed to deserialize account data: {}", err),
                }
            } else {
                println!("Not yet created?");
            }
        },
        TokenSubCmd::TransferRemote(xfer) => {
            is_keypair(&xfer.sender).unwrap();
            let sender = read_keypair_file(xfer.sender).unwrap();

            let (erc20_account, _erc20_bump) = Pubkey::find_program_address(
                hyperlane_token_erc20_pda_seeds!(xfer.name, xfer.symbol),
                &xfer.program_id,
            );
            let (mint_account, _mint_bump) = Pubkey::find_program_address(
                hyperlane_token_mint_pda_seeds!(xfer.name, xfer.symbol),
                &xfer.program_id,
            );
            // FIXME should we use a sender delegate?
            let sender_associated_token_account = get_associated_token_address_with_program_id(
                &sender.pubkey(),
                &mint_account,
                &spl_token_2022::id(),
            );
            let (mailbox_outbox_account, _mailbox_outbox_bump) = Pubkey::find_program_address(
                mailbox_outbox_pda_seeds!(xfer.mailbox_local_domain),
                &xfer.mailbox,
            );

            let ixn = MailboxRecipientInstruction::new_custom(Erc20Instruction::TransferRemote(
                Erc20TransferRemote {
                    destination_domain: xfer.destination_domain,
                    destination_program_id: xfer.destination_token_program_id.to_bytes().into(),
                    recipient: xfer.recipient.to_bytes().into(),
                    amount_or_id: xfer.amount.into(),
                }
            ));

            // 1. spl_noop
            // 2. spl_token_2022
            // 3. hyperlane_token_erc20
            // 4. hyperlane_token_mint
            // FIXME should we use a delegate / does it even matter if it is one?
            // 5. sender wallet
            // 6. sender associated token account
            // 7. mailbox program
            // 8. mailbox outbox
            let accounts = vec![
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new_readonly(erc20_account, false),
                AccountMeta::new(mint_account, false),
                AccountMeta::new(sender.pubkey(), true),
                AccountMeta::new(sender_associated_token_account, false),
                AccountMeta::new_readonly(xfer.mailbox, false),
                AccountMeta::new(mailbox_outbox_account, false),
            ];
            let xfer_instruction = Instruction {
                program_id: xfer.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts,
            };
            ctx.instructions.push(xfer_instruction);

            let recent_blockhash = ctx.client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &ctx.instructions,
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer, &sender],
                recent_blockhash,
            );

            let signature = ctx
                .client
                .send_transaction(&txn)
                .unwrap();
            ctx
                .client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, ctx.commitment)
                .unwrap();
        },
        TokenSubCmd::TransferFromRemote(xfer) => {
            let (erc20_account, _erc20_bump) = Pubkey::find_program_address(
                hyperlane_token_erc20_pda_seeds!(xfer.name, xfer.symbol),
                &xfer.program_id,
            );
            let (mint_account, _mint_bump) = Pubkey::find_program_address(
                hyperlane_token_mint_pda_seeds!(xfer.name, xfer.symbol),
                &xfer.program_id,
            );
            let recipient_associated_token_account = get_associated_token_address_with_program_id(
                &xfer.recipient,
                &mint_account,
                &spl_token_2022::id(),
            );

            let message = Erc20Message::new_erc20(
                H256::from(xfer.recipient.to_bytes()),
                U256::from(xfer.amount),
                vec![],
            );
            let ixn = MailboxRecipientInstruction::new_custom(Erc20Instruction::TransferFromRemote(
                Erc20TransferFromRemote {
                    origin: xfer.origin_domain,
                    message: message.to_vec(),
                }
            ));
            let accounts = vec![
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                AccountMeta::new(ctx.payer.pubkey(), true),
                AccountMeta::new_readonly(erc20_account, false),
                AccountMeta::new(mint_account, false),
                AccountMeta::new(xfer.recipient, false),
                AccountMeta::new(recipient_associated_token_account, false),
            ];
            let xfer_instruction = Instruction {
                program_id: xfer.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts,
            };
            ctx.instructions.push(xfer_instruction);

            let recent_blockhash = ctx.client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &ctx.instructions,
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            );

            let signature = ctx
                .client
                .send_transaction(&txn)
                .unwrap();
            ctx.client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, ctx.commitment)
                .unwrap();
        },
        TokenSubCmd::TransferFromSender(xfer) => {
            is_keypair(&xfer.sender).unwrap();
            let sender = read_keypair_file(xfer.sender).unwrap();

            let (erc20_account, _erc20_bump) = Pubkey::find_program_address(
                hyperlane_token_erc20_pda_seeds!(xfer.name, xfer.symbol),
                &xfer.program_id,
            );
            let (mint_account, _mint_bump) = Pubkey::find_program_address(
                hyperlane_token_mint_pda_seeds!(xfer.name, xfer.symbol),
                &xfer.program_id,
            );
            // FIXME should we use a sender delegate?
            let sender_associated_token_account = get_associated_token_address_with_program_id(
                &sender.pubkey(),
                &mint_account,
                &spl_token_2022::id(),
            );

            let ixn = MailboxRecipientInstruction::new_custom(Erc20Instruction::TransferFromSender(
                    Erc20TransferFromSender {
                    amount: xfer.amount.into(),
                }
            ));
            // 1. spl_token_2022
            // 2. hyperlane_token_erc20
            // 3. hyperlane_token_mint
            // FIXME should we use a delegate / does it even matter if it is one?
            // 4. sender wallet
            // 4. sender associated token account
            let accounts = vec![
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new_readonly(erc20_account, false),
                AccountMeta::new(mint_account, false),
                AccountMeta::new(sender.pubkey(), true),
                AccountMeta::new(sender_associated_token_account, false),
            ];
            let xfer_instruction = Instruction {
                program_id: xfer.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts,
            };
            ctx.instructions.push(xfer_instruction);

            let recent_blockhash = ctx.client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &ctx.instructions,
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer, &sender],
                recent_blockhash,
            );

            let signature = ctx
                .client
                .send_transaction(&txn)
                .unwrap();
            ctx
                .client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, ctx.commitment)
                .unwrap();
        },
        TokenSubCmd::TransferTo(xfer) => {
            let (erc20_account, _erc20_bump) = Pubkey::find_program_address(
                hyperlane_token_erc20_pda_seeds!(xfer.name, xfer.symbol),
                &xfer.program_id,
            );
            let (mint_account, _mint_bump) = Pubkey::find_program_address(
                hyperlane_token_mint_pda_seeds!(xfer.name, xfer.symbol),
                &xfer.program_id,
            );
            let recipient_associated_token_account = get_associated_token_address_with_program_id(
                &xfer.recipient,
                &mint_account,
                &spl_token_2022::id(),
            );

            let ixn = MailboxRecipientInstruction::new_custom(Erc20Instruction::TransferTo(
                Erc20TransferTo {
                    amount: xfer.amount.into(),
                }
            ));
            let accounts = vec![
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(spl_token_2022::id(), false),
                AccountMeta::new_readonly(spl_associated_token_account::id(), false),
                AccountMeta::new(ctx.payer.pubkey(), true),
                AccountMeta::new_readonly(erc20_account, false),
                AccountMeta::new(mint_account, false),
                AccountMeta::new(xfer.recipient, false),
                AccountMeta::new(recipient_associated_token_account, false),
            ];
            let xfer_instruction = Instruction {
                program_id: xfer.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts,
            };
            ctx.instructions.push(xfer_instruction);

            let recent_blockhash = ctx.client.get_latest_blockhash().unwrap();
            let txn = Transaction::new_signed_with_payer(
                &ctx.instructions,
                Some(&ctx.payer.pubkey()),
                &[&ctx.payer],
                recent_blockhash,
            );

            let signature = ctx.client.send_transaction(&txn).unwrap();
            ctx.client
                .confirm_transaction_with_spinner(&signature, &recent_blockhash, ctx.commitment)
                .unwrap();
        },
    }
}
