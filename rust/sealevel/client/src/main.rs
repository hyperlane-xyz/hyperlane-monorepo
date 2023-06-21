//! Test client for Hyperlane Sealevel Mailbox contract.

// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use account_utils::DiscriminatorEncode;
use clap::{Args, Parser, Subcommand, ValueEnum};
use hyperlane_core::H160;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_mailbox::{
    accounts::{InboxAccount, OutboxAccount},
    hyperlane_core::{message::HyperlaneMessage, types::H256, Encode},
    instruction::{InboxProcess, Instruction as MailboxInstruction, OutboxDispatch, VERSION},
    mailbox_dispatched_message_pda_seeds, mailbox_inbox_pda_seeds,
    mailbox_message_dispatch_authority_pda_seeds, mailbox_outbox_pda_seeds,
    mailbox_processed_message_pda_seeds, spl_noop,
};
use hyperlane_sealevel_multisig_ism_message_id::{
    access_control_pda_seeds as multisig_ism_message_id_access_control_pda_seeds,
    accounts::AccessControlAccount,
    domain_data_pda_seeds as multisig_ism_message_id_domain_data_pda_seeds,
    instruction::{
        Domained, Instruction as MultisigIsmMessageIdInstruction, ValidatorsAndThreshold,
    },
};
use hyperlane_sealevel_token::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_mint_pda_seeds, plugin::SyntheticPlugin,
    spl_associated_token_account::get_associated_token_address_with_program_id, spl_token_2022,
};
use hyperlane_sealevel_token_collateral::{
    hyperlane_token_escrow_pda_seeds, plugin::CollateralPlugin,
};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneTokenAccount,
    hyperlane_token_pda_seeds,
    instruction::{
        Init as HtInit, Instruction as HtInstruction, TransferRemote as HtTransferRemote,
    },
};
use hyperlane_sealevel_token_native::{
    hyperlane_token_native_collateral_pda_seeds, plugin::NativePlugin,
};

use hyperlane_sealevel_validator_announce::{
    accounts::ValidatorStorageLocationsAccount,
    instruction::{
        AnnounceInstruction as ValidatorAnnounceAnnounceInstruction,
        Instruction as ValidatorAnnounceInstruction,
    },
    replay_protection_pda_seeds, validator_announce_pda_seeds,
    validator_storage_locations_pda_seeds,
};

use solana_clap_utils::input_validators::{is_keypair, is_url, normalize_to_url_if_moniker};
use solana_cli_config::{Config, CONFIG_FILE};
use solana_client::{rpc_client::RpcClient, rpc_config::RpcSendTransactionConfig};
use solana_program::pubkey;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer as _},
    signer::signers::Signers,
    system_program,
    transaction::Transaction,
};

use std::{path::PathBuf, str::FromStr};

mod cmd_utils;
mod r#core;
mod warp_route;

pub(crate) use crate::core::*;

use crate::warp_route::process_warp_route_cmd;

// Note: from solana_program_runtime::compute_budget
const DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT: u32 = 200_000;
const MAX_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;
const MAX_HEAP_FRAME_BYTES: u32 = 256 * 1024;

const ECLIPSE_DOMAIN: u32 = 13375; // TODO import from hyperlane

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
    Core(CoreCmd),
    Mailbox(MailboxCmd),
    Token(TokenCmd),
    ValidatorAnnounce(ValidatorAnnounceCmd),
    MultisigIsmMessageId(MultisigIsmMessageIdCmd),
    WarpRoute(WarpRouteCmd),
}

#[derive(Args)]
pub(crate) struct WarpRouteCmd {
    #[command(subcommand)]
    cmd: WarpRouteSubCmd,
}

#[derive(Subcommand)]
pub(crate) enum WarpRouteSubCmd {
    Deploy(WarpRouteDeploy),
}

#[derive(Args)]
pub(crate) struct WarpRouteDeploy {
    #[arg(long)]
    environment: String,
    #[arg(long)]
    environments_dir: PathBuf,
    #[arg(long)]
    built_so_dir: PathBuf,
    #[arg(long)]
    warp_route_name: String,
    #[arg(long)]
    token_config_file: PathBuf,
    #[arg(long)]
    chain_config_file: PathBuf,
    #[arg(long)]
    ata_payer_funding_amount: Option<u64>,
}

#[derive(Args)]
struct CoreCmd {
    #[command(subcommand)]
    cmd: CoreSubCmd,
}

#[derive(Subcommand)]
enum CoreSubCmd {
    Deploy(CoreDeploy),
}

#[derive(Args)]
struct CoreDeploy {
    #[arg(long)]
    local_domain: u32,
    #[arg(long)]
    environment: String,
    #[arg(long)]
    chain: String,
    #[arg(long)]
    use_existing_keys: bool,
    #[arg(long)]
    environments_dir: PathBuf,
    #[arg(long)]
    built_so_dir: PathBuf,
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
    Delivered(Delivered),
}

const MAILBOX_PROG_ID: Pubkey = pubkey!("692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1");
const HYPERLANE_TOKEN_PROG_ID: Pubkey = pubkey!("3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH");
const MULTISIG_ISM_MESSAGE_ID_PROG_ID: Pubkey =
    pubkey!("2YjtZDiUoptoSsA5eVrDCcX6wxNK6YoEVW7y82x5Z2fw");
const VALIDATOR_ANNOUNCE_PROG_ID: Pubkey = pubkey!("DH43ae1LwemXAboWwSh8zc9pG8j72gKUEXNi57w8fEnn");

#[derive(Args)]
struct Init {
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    local_domain: u32,
    #[arg(long, short, default_value_t = MULTISIG_ISM_MESSAGE_ID_PROG_ID)]
    default_ism: Pubkey,
}

#[derive(Args)]
struct Query {
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
}

#[derive(Args)]
struct Outbox {
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    destination: u32,
    #[arg(long, short)]
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
    #[arg(long, short)]
    recipient: Pubkey,
    #[arg(long, short, default_value = "Hello, World!")]
    message: String,
    #[arg(long, short, default_value_t = 1)]
    nonce: u32,
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, default_value_t = MULTISIG_ISM_MESSAGE_ID_PROG_ID)]
    ism: Pubkey,
}

#[derive(Args)]
struct Delivered {
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short)]
    message_id: H256,
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
    EnrollRemoteRouter(TokenEnrollRemoteRouter),
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, ValueEnum)]
enum TokenType {
    Native,
    Synthetic,
    Collateral,
}

#[derive(Args)]
struct TokenInit {
    #[arg(long, short, default_value_t = HYPERLANE_TOKEN_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    mailbox: Pubkey,
    #[arg(value_enum)]
    token_type: TokenType,
    #[arg(long, short)]
    interchain_security_module: Option<Pubkey>,
    #[arg(long, short, default_value_t = 9)]
    decimals: u8,
    #[arg(long, short, default_value_t = 18)]
    remote_decimals: u8,
}

#[derive(Args)]
struct TokenQuery {
    #[arg(long, short, default_value_t = HYPERLANE_TOKEN_PROG_ID)]
    program_id: Pubkey,
    #[arg(value_enum)]
    token_type: TokenType,
}

#[derive(Args)]
struct TokenTransferRemote {
    #[arg(long, short, default_value_t = HYPERLANE_TOKEN_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    mailbox: Pubkey,
    // Note this is the keypair for normal account not the derived associated token account or delegate.
    sender: String,
    amount: u64,
    // #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    destination_domain: u32,
    #[arg(long, short = 't', default_value_t = HYPERLANE_TOKEN_PROG_ID)]
    destination_token_program_id: Pubkey,
    recipient: String,
    #[arg(value_enum)]
    token_type: TokenType,
}

#[derive(Args)]
struct TokenEnrollRemoteRouter {
    #[arg(long, short, default_value_t = HYPERLANE_TOKEN_PROG_ID)]
    program_id: Pubkey,
    domain: u32,
    router: H256,
}

#[derive(Args)]
struct ValidatorAnnounceCmd {
    #[command(subcommand)]
    cmd: ValidatorAnnounceSubCmd,
}

#[derive(Subcommand)]
enum ValidatorAnnounceSubCmd {
    Init(ValidatorAnnounceInit),
    Announce(ValidatorAnnounceAnnounce),
    Query(ValidatorAnnounceQuery),
}

#[derive(Args)]
struct ValidatorAnnounceInit {
    #[arg(long, short, default_value_t = VALIDATOR_ANNOUNCE_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    mailbox_id: Pubkey,
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    local_domain: u32,
}

#[derive(Args)]
struct ValidatorAnnounceAnnounce {
    #[arg(long, short, default_value_t = VALIDATOR_ANNOUNCE_PROG_ID)]
    program_id: Pubkey,
    #[arg(long)]
    validator: H160,
    #[arg(long)]
    storage_location: String,
    #[arg(long)]
    signature: String,
}

#[derive(Args)]
struct ValidatorAnnounceQuery {
    #[arg(long, short, default_value_t = VALIDATOR_ANNOUNCE_PROG_ID)]
    program_id: Pubkey,
    validator: H160,
}

#[derive(Args)]
struct MultisigIsmMessageIdCmd {
    #[command(subcommand)]
    cmd: MultisigIsmMessageIdSubCmd,
}

#[derive(Subcommand)]
enum MultisigIsmMessageIdSubCmd {
    Init(MultisigIsmMessageIdInit),
    SetValidatorsAndThreshold(MultisigIsmMessageIdSetValidatorsAndThreshold),
    Query(MultisigIsmMessageIdInit),
}

#[derive(Args)]
struct MultisigIsmMessageIdInit {
    #[arg(long, short, default_value_t = MULTISIG_ISM_MESSAGE_ID_PROG_ID)]
    program_id: Pubkey,
}

#[derive(Args)]
struct MultisigIsmMessageIdSetValidatorsAndThreshold {
    #[arg(long, short, default_value_t = MULTISIG_ISM_MESSAGE_ID_PROG_ID)]
    program_id: Pubkey,
    #[arg(long)]
    domain: u32,
    #[arg(long, value_delimiter = ',')]
    validators: Vec<H160>,
    #[arg(long)]
    threshold: u8,
}

pub(crate) struct Context {
    client: RpcClient,
    payer: Keypair,
    payer_path: String,
    commitment: CommitmentConfig,
    instructions: Vec<Instruction>,
}

impl Context {
    fn send_transaction<T: Signers>(&self, signers: &T) {
        let recent_blockhash = self.client.get_latest_blockhash().unwrap();
        let txn = Transaction::new_signed_with_payer(
            &self.instructions,
            Some(&self.payer.pubkey()),
            signers,
            recent_blockhash,
        );

        let _signature = self
            .client
            .send_and_confirm_transaction_with_spinner_and_config(
                &txn,
                self.commitment,
                RpcSendTransactionConfig {
                    preflight_commitment: Some(self.commitment.commitment),
                    ..RpcSendTransactionConfig::default()
                },
            )
            .map_err(|err| {
                eprintln!("{:#?}", err);
                err
            })
            .unwrap();
    }

    fn send_transaction_with_client<T: Signers>(&self, client: &RpcClient, signers: &T) {
        let recent_blockhash = client.get_latest_blockhash().unwrap();
        let txn = Transaction::new_signed_with_payer(
            &self.instructions,
            Some(&self.payer.pubkey()),
            signers,
            recent_blockhash,
        );

        let _signature = client
            .send_and_confirm_transaction_with_spinner_and_config(
                &txn,
                self.commitment,
                RpcSendTransactionConfig {
                    preflight_commitment: Some(self.commitment.commitment),
                    ..RpcSendTransactionConfig::default()
                },
            )
            .map_err(|err| {
                eprintln!("{:#?}", err);
                err
            })
            .unwrap();
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
    let payer = read_keypair_file(keypair_path.clone()).unwrap();
    let commitment = CommitmentConfig::processed();

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
        payer_path: keypair_path,
        commitment,
        instructions,
    };
    match cli.cmd {
        HyperlaneSealevelCmd::Mailbox(cmd) => process_mailbox_cmd(ctx, cmd),
        HyperlaneSealevelCmd::Token(cmd) => process_token_cmd(ctx, cmd),
        HyperlaneSealevelCmd::ValidatorAnnounce(cmd) => process_validator_announce_cmd(ctx, cmd),
        HyperlaneSealevelCmd::MultisigIsmMessageId(cmd) => {
            process_multisig_ism_message_id_cmd(ctx, cmd)
        }
        HyperlaneSealevelCmd::Core(cmd) => process_core_cmd(ctx, cmd),
        HyperlaneSealevelCmd::WarpRoute(cmd) => process_warp_route_cmd(ctx, cmd),
    }
}

fn process_mailbox_cmd(mut ctx: Context, cmd: MailboxCmd) {
    match cmd.cmd {
        MailboxSubCmd::Init(init) => {
            let instruction = hyperlane_sealevel_mailbox::instruction::init_instruction(
                init.program_id,
                init.local_domain,
                init.default_ism,
                ctx.payer.pubkey(),
            )
            .unwrap();

            ctx.instructions.push(instruction);
            ctx.send_transaction(&[&ctx.payer]);
        }
        MailboxSubCmd::Query(query) => {
            let (inbox_account, inbox_bump) =
                Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), &query.program_id);
            let (outbox_account, outbox_bump) =
                Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), &query.program_id);

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(
                    &[inbox_account, outbox_account],
                    ctx.commitment,
                )
                .unwrap()
                .value;
            println!("mailbox={}", query.program_id);
            println!("--------------------------------");
            println!("Inbox: {}, bump={}", inbox_account, inbox_bump);
            if let Some(info) = &accounts[0] {
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
            if let Some(info) = &accounts[1] {
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
            let (outbox_account, _outbox_bump) =
                Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), &outbox.program_id);
            let ixn = MailboxInstruction::OutboxDispatch(OutboxDispatch {
                sender: ctx.payer.pubkey(),
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
            ctx.send_transaction(&[&ctx.payer]);
        }
        MailboxSubCmd::Receive(inbox) => {
            // TODO this probably needs some love

            let (inbox_account, _inbox_bump) =
                Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), &inbox.program_id);
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
                    AccountMeta::new_readonly(spl_noop::id(), false),
                    AccountMeta::new_readonly(inbox.ism, false),
                    AccountMeta::new_readonly(inbox.recipient, false),
                    // Note: we would have to provide ism accounts and recipient accounts here if
                    // they were to use other accounts.
                ],
            };
            ctx.instructions.push(inbox_instruction);
            ctx.send_transaction(&[&ctx.payer]);
        }
        MailboxSubCmd::Delivered(delivered) => {
            let (processed_message_account_key, _processed_message_account_bump) =
                Pubkey::find_program_address(
                    mailbox_processed_message_pda_seeds!(delivered.message_id),
                    &delivered.program_id,
                );
            let account = ctx
                .client
                .get_account_with_commitment(&processed_message_account_key, ctx.commitment)
                .unwrap()
                .value;
            if account.is_none() {
                println!("Message not delivered");
            } else {
                println!("Message delivered");
            }
        }
    };
}

fn process_token_cmd(mut ctx: Context, cmd: TokenCmd) {
    match cmd.cmd {
        TokenSubCmd::Init(init) => {
            let (token_account, token_bump) =
                Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &init.program_id);
            let (dispatch_authority_account, _dispatch_authority_bump) =
                Pubkey::find_program_address(
                    mailbox_message_dispatch_authority_pda_seeds!(),
                    &init.program_id,
                );

            let ixn = HtInstruction::Init(HtInit {
                mailbox: init.mailbox,
                interchain_security_module: init.interchain_security_module,
                decimals: init.decimals,
                remote_decimals: init.remote_decimals,
            });

            // Accounts:
            // 0.   [executable] The system program.
            // 1.   [writable] The token PDA account.
            // 2.   [writable] The dispatch authority.
            // 3.   [signer] The payer.
            // 4..N [??..??] Plugin-specific accounts.
            let mut accounts = vec![
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new(token_account, false),
                AccountMeta::new(dispatch_authority_account, false),
                AccountMeta::new(ctx.payer.pubkey(), true),
            ];

            match init.token_type {
                TokenType::Native => {
                    let (native_collateral_account, native_collateral_bump) =
                        Pubkey::find_program_address(
                            hyperlane_token_native_collateral_pda_seeds!(),
                            &init.program_id,
                        );
                    accounts.push(AccountMeta::new(native_collateral_account, false));

                    println!(
                        "native_collateral_account (key, bump)=({}, {})",
                        native_collateral_account, native_collateral_bump,
                    );
                }
                TokenType::Synthetic => {
                    let (mint_account, mint_bump) = Pubkey::find_program_address(
                        hyperlane_token_mint_pda_seeds!(),
                        &init.program_id,
                    );
                    accounts.push(AccountMeta::new(mint_account, false));
                    println!("mint_account (key, bump)=({}, {})", mint_account, mint_bump,);

                    let (ata_payer_account, ata_payer_bump) = Pubkey::find_program_address(
                        hyperlane_token_ata_payer_pda_seeds!(),
                        &init.program_id,
                    );
                    accounts.push(AccountMeta::new(ata_payer_account, false));
                    println!(
                        "ata_payer_account (key, bump)=({}, {})",
                        ata_payer_account, ata_payer_bump,
                    );
                }
                TokenType::Collateral => {
                    // TODO implement this - for now, the warp route deployment tooling is sufficient
                    unimplemented!()
                }
            }

            println!("init.program_id {}", init.program_id);

            let init_instruction = Instruction {
                program_id: init.program_id,
                data: ixn.encode().unwrap(),
                accounts,
            };
            ctx.instructions.push(init_instruction);

            if init.token_type == TokenType::Synthetic {
                let (mint_account, _mint_bump) = Pubkey::find_program_address(
                    hyperlane_token_mint_pda_seeds!(),
                    &init.program_id,
                );
                ctx.instructions.push(
                    spl_token_2022::instruction::initialize_mint2(
                        &spl_token_2022::id(),
                        &mint_account,
                        &mint_account,
                        None,
                        init.decimals,
                    )
                    .unwrap(),
                );

                let (ata_payer_account, _ata_payer_bump) = Pubkey::find_program_address(
                    hyperlane_token_ata_payer_pda_seeds!(),
                    &init.program_id,
                );
                ctx.instructions
                    .push(solana_program::system_instruction::transfer(
                        &ctx.payer.pubkey(),
                        &ata_payer_account,
                        1000000000,
                    ));
            }

            ctx.send_transaction(&[&ctx.payer]);

            println!(
                "hyperlane_token (key, bump) =({}, {})",
                token_account, token_bump
            );
        }
        TokenSubCmd::Query(query) => {
            let (token_account, token_bump) =
                Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &query.program_id);

            let mut accounts_to_query = vec![token_account];

            match query.token_type {
                TokenType::Native => {
                    let (native_collateral_account, _native_collateral_bump) =
                        Pubkey::find_program_address(
                            hyperlane_token_native_collateral_pda_seeds!(),
                            &query.program_id,
                        );
                    accounts_to_query.push(native_collateral_account);
                }
                TokenType::Synthetic => {
                    let (mint_account, _mint_bump) = Pubkey::find_program_address(
                        hyperlane_token_mint_pda_seeds!(),
                        &query.program_id,
                    );
                    let (ata_payer_account, _ata_payer_bump) = Pubkey::find_program_address(
                        hyperlane_token_ata_payer_pda_seeds!(),
                        &query.program_id,
                    );
                    accounts_to_query.push(mint_account);
                    accounts_to_query.push(ata_payer_account);
                }
                TokenType::Collateral => {
                    let (escrow_account, _escrow_bump) = Pubkey::find_program_address(
                        hyperlane_token_escrow_pda_seeds!(),
                        &query.program_id,
                    );
                    accounts_to_query.push(escrow_account);
                }
            }

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&accounts_to_query, ctx.commitment)
                .unwrap()
                .value;
            println!("hyperlane-sealevel-token={}", query.program_id);
            println!("--------------------------------");
            println!(
                "Hyperlane Token Storage: {}, bump={}",
                token_account, token_bump
            );
            if let Some(info) = &accounts[0] {
                println!("{:#?}", info);

                match query.token_type {
                    TokenType::Native => {
                        match HyperlaneTokenAccount::<NativePlugin>::fetch(&mut info.data.as_ref())
                        {
                            Ok(token) => println!("{:#?}", token.into_inner()),
                            Err(err) => println!("Failed to deserialize account data: {}", err),
                        }
                    }
                    TokenType::Synthetic => {
                        match HyperlaneTokenAccount::<SyntheticPlugin>::fetch(
                            &mut info.data.as_ref(),
                        ) {
                            Ok(token) => println!("{:#?}", token.into_inner()),
                            Err(err) => println!("Failed to deserialize account data: {}", err),
                        }
                    }
                    TokenType::Collateral => {
                        match HyperlaneTokenAccount::<CollateralPlugin>::fetch(
                            &mut info.data.as_ref(),
                        ) {
                            Ok(token) => println!("{:#?}", token.into_inner()),
                            Err(err) => println!("Failed to deserialize account data: {}", err),
                        }
                    }
                }
            } else {
                println!("Not yet created?");
            }
            println!("--------------------------------");

            match query.token_type {
                TokenType::Native => {
                    let (native_collateral_account, native_collateral_bump) =
                        Pubkey::find_program_address(
                            hyperlane_token_native_collateral_pda_seeds!(),
                            &query.program_id,
                        );
                    println!(
                        "Native Token Collateral: {}, bump={}",
                        native_collateral_account, native_collateral_bump
                    );
                    if let Some(info) = &accounts[1] {
                        println!("{:#?}", info);
                    } else {
                        println!("Not yet created?");
                    }
                    println!("--------------------------------");
                }
                TokenType::Synthetic => {
                    let (mint_account, mint_bump) = Pubkey::find_program_address(
                        hyperlane_token_mint_pda_seeds!(),
                        &query.program_id,
                    );
                    println!(
                        "Mint / Mint Authority: {}, bump={}",
                        mint_account, mint_bump
                    );
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

                    let (ata_payer_account, ata_payer_bump) = Pubkey::find_program_address(
                        hyperlane_token_ata_payer_pda_seeds!(),
                        &query.program_id,
                    );
                    println!(
                        "ATA payer account: {}, bump={}",
                        ata_payer_account, ata_payer_bump,
                    );
                }
                TokenType::Collateral => {
                    let (escrow_account, escrow_bump) = Pubkey::find_program_address(
                        hyperlane_token_escrow_pda_seeds!(),
                        &query.program_id,
                    );

                    println!(
                        "escrow_account (key, bump)=({}, {})",
                        escrow_account, escrow_bump,
                    );
                }
            }
        }
        TokenSubCmd::TransferRemote(xfer) => {
            is_keypair(&xfer.sender).unwrap();
            let sender = read_keypair_file(xfer.sender).unwrap();

            let recipient = if xfer.recipient.starts_with("0x") {
                H256::from_str(&xfer.recipient).unwrap()
            } else {
                let pubkey = Pubkey::from_str(&xfer.recipient).unwrap();
                H256::from_slice(&pubkey.to_bytes()[..])
            };

            let (token_account, _token_bump) =
                Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &xfer.program_id);
            let (dispatch_authority_account, _dispatch_authority_bump) =
                Pubkey::find_program_address(
                    mailbox_message_dispatch_authority_pda_seeds!(),
                    &xfer.program_id,
                );

            let unique_message_account_keypair = Keypair::new();
            let (dispatched_message_account, _dispatched_message_bump) =
                Pubkey::find_program_address(
                    mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
                    &xfer.mailbox,
                );

            let (mailbox_outbox_account, _mailbox_outbox_bump) =
                Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), &xfer.mailbox);

            let ixn = HtInstruction::TransferRemote(HtTransferRemote {
                destination_domain: xfer.destination_domain,
                recipient,
                amount_or_id: xfer.amount.into(),
            });

            // Transfers tokens to a remote.
            // Burns the tokens from the sender's associated token account and
            // then dispatches a message to the remote recipient.
            //
            // 0.   [executable] The system program.
            // 0.   [executable] The spl_noop program.
            // 1.   [] The token PDA account.
            // 2.   [executable] The mailbox program.
            // 3.   [writeable] The mailbox outbox account.
            // 4.   [] Message dispatch authority.
            // 5.   [writeable,signer] The token sender and mailbox payer.
            // 6.   [signer] Unique message account.
            // 7.   [writeable] Message storage PDA.
            let mut accounts = vec![
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new_readonly(token_account, false),
                AccountMeta::new_readonly(xfer.mailbox, false),
                AccountMeta::new(mailbox_outbox_account, false),
                AccountMeta::new_readonly(dispatch_authority_account, false),
                AccountMeta::new(sender.pubkey(), true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_account, false),
            ];

            match xfer.token_type {
                TokenType::Native => {
                    // 5. [executable] The system program.
                    // 6. [writeable] The native token collateral PDA account.
                    let (native_collateral_account, _native_collateral_bump) =
                        Pubkey::find_program_address(
                            hyperlane_token_native_collateral_pda_seeds!(),
                            &xfer.program_id,
                        );
                    accounts.extend([
                        AccountMeta::new_readonly(system_program::id(), false),
                        AccountMeta::new(native_collateral_account, false),
                    ]);
                }
                TokenType::Synthetic => {
                    // 5. [executable] The spl_token_2022 program.
                    // 6. [writeable] The mint / mint authority PDA account.
                    // 7. [writeable] The token sender's associated token account, from which tokens will be burned.
                    let (mint_account, _mint_bump) = Pubkey::find_program_address(
                        hyperlane_token_mint_pda_seeds!(),
                        &xfer.program_id,
                    );
                    let sender_associated_token_account =
                        get_associated_token_address_with_program_id(
                            &sender.pubkey(),
                            &mint_account,
                            &spl_token_2022::id(),
                        );
                    accounts.extend([
                        AccountMeta::new_readonly(spl_token_2022::id(), false),
                        AccountMeta::new(mint_account, false),
                        AccountMeta::new(sender_associated_token_account, false),
                    ]);
                }
                TokenType::Collateral => {
                    // 5. [executable] The SPL token program for the mint.
                    // 6. [writeable] The mint.
                    // 7. [writeable] The token sender's associated token account, from which tokens will be sent.
                    // 8. [writeable] The escrow PDA account.
                    let fetched_token_account = ctx
                        .client
                        .get_account_with_commitment(&token_account, ctx.commitment)
                        .unwrap()
                        .value
                        .unwrap();
                    let token = HyperlaneTokenAccount::<CollateralPlugin>::fetch(
                        &mut &fetched_token_account.data[..],
                    )
                    .unwrap()
                    .into_inner();

                    let sender_associated_token_account =
                        get_associated_token_address_with_program_id(
                            &sender.pubkey(),
                            &token.plugin_data.mint,
                            &token.plugin_data.spl_token_program,
                        );
                    accounts.extend([
                        AccountMeta::new_readonly(token.plugin_data.spl_token_program, false),
                        AccountMeta::new(token.plugin_data.mint, false),
                        AccountMeta::new(sender_associated_token_account, false),
                        AccountMeta::new(token.plugin_data.escrow, false),
                    ]);
                }
            }

            eprintln!("accounts={:#?}", accounts); // FIXME remove
            let xfer_instruction = Instruction {
                program_id: xfer.program_id,
                data: ixn.encode().unwrap(),
                accounts,
            };
            ctx.instructions.push(xfer_instruction);

            ctx.send_transaction(&[&ctx.payer, &sender, &unique_message_account_keypair]);
        }
        TokenSubCmd::EnrollRemoteRouter(enroll) => {
            let enroll_instruction = HtInstruction::EnrollRemoteRouter(RemoteRouterConfig {
                domain: enroll.domain,
                router: enroll.router.into(),
            });
            let (token_account, _token_bump) =
                Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &enroll.program_id);

            let instruction = Instruction {
                program_id: enroll.program_id,
                data: enroll_instruction.encode().unwrap(),
                accounts: vec![
                    AccountMeta::new(token_account, false),
                    AccountMeta::new_readonly(ctx.payer.pubkey(), true),
                ],
            };
            ctx.instructions.push(instruction);

            ctx.send_transaction(&[&ctx.payer]);
        }
    }
}

fn process_validator_announce_cmd(mut ctx: Context, cmd: ValidatorAnnounceCmd) {
    match cmd.cmd {
        ValidatorAnnounceSubCmd::Init(init) => {
            let init_instruction =
                hyperlane_sealevel_validator_announce::instruction::init_instruction(
                    init.program_id,
                    ctx.payer.pubkey(),
                    init.mailbox_id,
                    init.local_domain,
                )
                .unwrap();
            ctx.instructions.push(init_instruction);

            ctx.send_transaction(&[&ctx.payer]);
        }
        ValidatorAnnounceSubCmd::Announce(announce) => {
            let signature = hex::decode(if announce.signature.starts_with("0x") {
                &announce.signature[2..]
            } else {
                &announce.signature
            })
            .unwrap();

            let announce_instruction = ValidatorAnnounceAnnounceInstruction {
                validator: announce.validator,
                storage_location: announce.storage_location,
                signature,
            };

            let (validator_announce_account, _validator_announce_bump) =
                Pubkey::find_program_address(validator_announce_pda_seeds!(), &announce.program_id);

            let (validator_storage_locations_key, _validator_storage_locations_bump_seed) =
                Pubkey::find_program_address(
                    validator_storage_locations_pda_seeds!(announce.validator),
                    &announce.program_id,
                );

            let replay_id = announce_instruction.replay_id();
            let (replay_protection_pda_key, _replay_protection_bump_seed) =
                Pubkey::find_program_address(
                    replay_protection_pda_seeds!(replay_id),
                    &announce.program_id,
                );

            let ixn = ValidatorAnnounceInstruction::Announce(announce_instruction);

            // Accounts:
            // 0. [signer] The payer.
            // 1. [executable] The system program.
            // 2. [] The ValidatorAnnounce PDA account.
            // 3. [writeable] The validator-specific ValidatorStorageLocationsAccount PDA account.
            // 4. [writeable] The ReplayProtection PDA account specific to the announcement being made.
            let accounts = vec![
                AccountMeta::new_readonly(ctx.payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(validator_announce_account, false),
                AccountMeta::new(validator_storage_locations_key, false),
                AccountMeta::new(replay_protection_pda_key, false),
            ];

            let announce_instruction = Instruction {
                program_id: announce.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts,
            };
            ctx.instructions.push(announce_instruction);

            ctx.send_transaction(&[&ctx.payer]);
        }
        ValidatorAnnounceSubCmd::Query(query) => {
            let (validator_storage_locations_key, _validator_storage_locations_bump_seed) =
                Pubkey::find_program_address(
                    validator_storage_locations_pda_seeds!(query.validator),
                    &query.program_id,
                );

            let account = ctx
                .client
                .get_account_with_commitment(&validator_storage_locations_key, ctx.commitment)
                .unwrap()
                .value;
            if let Some(account) = account {
                let validator_storage_locations =
                    ValidatorStorageLocationsAccount::fetch(&mut &account.data[..])
                        .unwrap()
                        .into_inner();
                println!(
                    "Validator {} storage locations:\n{:#?}",
                    query.validator, validator_storage_locations
                );
            } else {
                println!("Validator not yet announced");
            }
        }
    }
}

fn process_multisig_ism_message_id_cmd(mut ctx: Context, cmd: MultisigIsmMessageIdCmd) {
    match cmd.cmd {
        MultisigIsmMessageIdSubCmd::Init(init) => {
            let init_instruction =
                hyperlane_sealevel_multisig_ism_message_id::instruction::init_instruction(
                    init.program_id,
                    ctx.payer.pubkey(),
                )
                .unwrap();
            ctx.instructions.push(init_instruction);

            ctx.send_transaction(&[&ctx.payer]);
        }
        MultisigIsmMessageIdSubCmd::SetValidatorsAndThreshold(set_config) => {
            let (access_control_pda_key, _access_control_pda_bump) = Pubkey::find_program_address(
                multisig_ism_message_id_access_control_pda_seeds!(),
                &set_config.program_id,
            );

            let (domain_data_pda_key, _domain_data_pda_bump) = Pubkey::find_program_address(
                multisig_ism_message_id_domain_data_pda_seeds!(set_config.domain),
                &set_config.program_id,
            );

            let ixn = MultisigIsmMessageIdInstruction::SetValidatorsAndThreshold(Domained {
                domain: set_config.domain,
                data: ValidatorsAndThreshold {
                    validators: set_config.validators,
                    threshold: set_config.threshold,
                },
            });

            // Accounts:
            // 0. `[signer]` The access control owner and payer of the domain PDA.
            // 1. `[]` The access control PDA account.
            // 2. `[writable]` The PDA relating to the provided domain.
            // 3. `[executable]` OPTIONAL - The system program account. Required if creating the domain PDA.
            let accounts = vec![
                AccountMeta::new(ctx.payer.pubkey(), true),
                AccountMeta::new_readonly(access_control_pda_key, false),
                AccountMeta::new(domain_data_pda_key, false),
                AccountMeta::new_readonly(system_program::id(), false),
            ];

            let set_instruction = Instruction {
                program_id: set_config.program_id,
                data: ixn.encode().unwrap(),
                accounts,
            };
            ctx.instructions.push(set_instruction);

            ctx.send_transaction(&[&ctx.payer]);
        }
        MultisigIsmMessageIdSubCmd::Query(query) => {
            let (access_control_pda_key, _access_control_pda_bump) = Pubkey::find_program_address(
                multisig_ism_message_id_access_control_pda_seeds!(),
                &query.program_id,
            );

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&[access_control_pda_key], ctx.commitment)
                .unwrap()
                .value;
            let access_control =
                AccessControlAccount::fetch(&mut &accounts[0].as_ref().unwrap().data[..])
                    .unwrap()
                    .into_inner();
            println!("Access control: {:#?}", access_control);
        }
    }
}
