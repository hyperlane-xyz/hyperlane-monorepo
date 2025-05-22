//! Test client for Hyperlane Sealevel Mailbox contract.

// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use std::{path::PathBuf, str::FromStr};

use clap::{Args, Parser, Subcommand, ValueEnum};
use solana_clap_utils::input_validators::{is_keypair, is_url, normalize_to_url_if_moniker};
use solana_cli_config::{Config, CONFIG_FILE};
use solana_client::rpc_client::RpcClient;
use solana_program::pubkey;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer as _},
    system_program,
};

use account_utils::DiscriminatorEncode;
use hyperlane_core::{H160, H256};
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_igp::{
    accounts::{InterchainGasPaymasterType, OverheadIgpAccount},
    igp_gas_payment_pda_seeds, igp_program_data_pda_seeds,
};
use hyperlane_sealevel_mailbox::{
    accounts::{InboxAccount, OutboxAccount},
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_dispatched_message_pda_seeds, mailbox_inbox_pda_seeds,
    mailbox_message_dispatch_authority_pda_seeds, mailbox_outbox_pda_seeds,
    mailbox_processed_message_pda_seeds,
    protocol_fee::ProtocolFee,
    spl_noop,
};

use hyperlane_sealevel_token::{
    hyperlane_token_ata_payer_pda_seeds, hyperlane_token_mint_pda_seeds,
    spl_associated_token_account::get_associated_token_address_with_program_id, spl_token_2022,
};
use hyperlane_sealevel_token_collateral::{
    hyperlane_token_escrow_pda_seeds, plugin::CollateralPlugin,
};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneTokenAccount,
    hyperlane_token_pda_seeds,
    instruction::{Instruction as HtInstruction, TransferRemote as HtTransferRemote},
};
use hyperlane_sealevel_token_native::hyperlane_token_native_collateral_pda_seeds;
use hyperlane_sealevel_validator_announce::{
    accounts::ValidatorStorageLocationsAccount,
    instruction::{
        AnnounceInstruction as ValidatorAnnounceAnnounceInstruction,
        Instruction as ValidatorAnnounceInstruction,
    },
    replay_protection_pda_seeds, validator_announce_pda_seeds,
    validator_storage_locations_pda_seeds,
};
use squads::{process_squads_cmd, SquadsCmd};
use warp_route::parse_token_account_data;

mod artifacts;
mod cmd_utils;
mod context;
mod r#core;
mod helloworld;
mod igp;
mod multisig_ism;
mod router;
mod serde;
mod squads;
mod warp_route;

use crate::helloworld::process_helloworld_cmd;
use crate::igp::process_igp_cmd;
use crate::multisig_ism::process_multisig_ism_message_id_cmd;
use crate::warp_route::process_warp_route_cmd;
pub(crate) use crate::{context::*, core::*};

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
    #[arg(long, short = 'C')]
    config: Option<String>,
    #[arg(long, default_value_t = false)]
    require_tx_approval: bool,
}

#[derive(Subcommand)]
enum HyperlaneSealevelCmd {
    Core(CoreCmd),
    Mailbox(MailboxCmd),
    Token(TokenCmd),
    Igp(IgpCmd),
    ValidatorAnnounce(ValidatorAnnounceCmd),
    MultisigIsmMessageId(MultisigIsmMessageIdCmd),
    WarpRoute(WarpRouteCmd),
    HelloWorld(HelloWorldCmd),
    Squads(SquadsCmd),
}

#[derive(Args)]
pub struct EnvironmentArgs {
    #[arg(long)]
    environment: String,
    #[arg(long)]
    environments_dir: PathBuf,
}

#[derive(Args)]
pub(crate) struct WarpRouteCmd {
    #[command(subcommand)]
    cmd: WarpRouteSubCmd,
}

#[derive(Subcommand)]
pub(crate) enum WarpRouteSubCmd {
    Deploy(WarpRouteDeploy),
    DestinationGas(DestinationGasArgs),
}

#[derive(Args)]
pub(crate) struct WarpRouteDeploy {
    #[command(flatten)]
    env_args: EnvironmentArgs,
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
struct DestinationGasArgs {
    #[arg(long)]
    program_id: Pubkey,
    #[arg(long)]
    destination_domain: u32,
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
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    protocol_fee_config_file: Option<PathBuf>,
    #[arg(long)]
    gas_oracle_config_file: Option<PathBuf>,
    #[arg(long)]
    overhead_config_file: Option<PathBuf>,
    #[arg(long)]
    chain: String,
    #[arg(long, num_args = 1.., value_delimiter = ',')]
    remote_domains: Vec<u32>,
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
    Delivered(Delivered),
    TransferOwnership(TransferOwnership),
    SetDefaultIsm(SetDefaultIsm),
}

const MAILBOX_PROG_ID: Pubkey = pubkey!("692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1");
const HYPERLANE_TOKEN_PROG_ID: Pubkey = pubkey!("3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH");
const MULTISIG_ISM_MESSAGE_ID_PROG_ID: Pubkey =
    pubkey!("2YjtZDiUoptoSsA5eVrDCcX6wxNK6YoEVW7y82x5Z2fw");
const VALIDATOR_ANNOUNCE_PROG_ID: Pubkey = pubkey!("DH43ae1LwemXAboWwSh8zc9pG8j72gKUEXNi57w8fEnn");
pub const DEFAULT_PROTOCOL_FEE: u64 = 0;
pub const ONE_SOL_IN_LAMPORTS: u64 = 1_000_000_000;

#[derive(Args)]
struct Init {
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
    #[arg(long, short, default_value_t = ECLIPSE_DOMAIN)]
    local_domain: u32,
    #[arg(long, short, default_value_t = MULTISIG_ISM_MESSAGE_ID_PROG_ID)]
    default_ism: Pubkey,
    #[arg(long, short, default_value_t = ONE_SOL_IN_LAMPORTS)]
    max_protocol_fee: u64,
    #[arg(long, short, default_value_t = DEFAULT_PROTOCOL_FEE)]
    protocol_fee: u64,
    #[arg(long, short, default_value = None)]
    protocol_fee_beneficiary: Option<Pubkey>,
}

#[derive(Args)]
struct Query {
    #[arg(long, short, default_value_t = MAILBOX_PROG_ID)]
    program_id: Pubkey,
}

#[derive(Args)]
struct SetDefaultIsm {
    #[arg(long, short)]
    program_id: Pubkey,
    #[arg(long, short)]
    default_ism: Pubkey,
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

#[derive(Args)]
struct TokenCmd {
    #[command(subcommand)]
    cmd: TokenSubCmd,
}

#[derive(Subcommand)]
enum TokenSubCmd {
    Query(TokenQuery),
    TransferRemote(TokenTransferRemote),
    EnrollRemoteRouter(TokenEnrollRemoteRouter),
    TransferOwnership(TransferOwnership),
    SetInterchainSecurityModule(SetInterchainSecurityModule),
    Igp(Igp),
}

#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, ValueEnum)]
pub enum TokenType {
    Native,
    Synthetic,
    Collateral,
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
    // Note this is the keypair for normal account not the derived associated token account or delegate.
    sender: String,
    amount: u64,
    destination_domain: u32,
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
struct SetInterchainSecurityModule {
    #[arg(long, short)]
    program_id: Pubkey,
    #[arg(long, short)]
    ism: Option<Pubkey>,
}

#[derive(Args)]
struct TransferOwnership {
    #[arg(long, short)]
    program_id: Pubkey,
    // To avoid accidentally transferring ownership to None,
    // only support transferring to other Pubkeys for now.
    new_owner: Pubkey,
}

#[derive(Args)]
struct Igp {
    #[arg(long, short, default_value_t = HYPERLANE_TOKEN_PROG_ID)]
    program_id: Pubkey,
    #[command(subcommand)]
    cmd: GetSetCmd<GetIgpArgs, SetIgpArgs>,
}

#[derive(Subcommand)]
enum GetSetCmd<G: Args, S: Args> {
    Get(G),
    Set(S),
}

#[derive(Args)]
struct SetIgpArgs {
    igp_program: Pubkey,
    #[arg(value_enum)]
    igp_type: IgpType,
    igp_account: Pubkey,
}

#[derive(Args)]
struct GetIgpArgs {
    token_type: TokenType,
}

#[derive(ValueEnum, Clone)]
enum IgpType {
    Igp,
    OverheadIgp,
}

#[derive(Args)]
struct IgpCmd {
    #[command(subcommand)]
    cmd: IgpSubCmd,
}

#[derive(Subcommand)]
enum IgpSubCmd {
    DeployProgram(IgpDeployProgramArgs),
    InitIgpAccount(InitIgpAccountArgs),
    InitOverheadIgpAccount(InitOverheadIgpAccountArgs),
    Query(IgpQueryArgs),
    PayForGas(PayForGasArgs),
    Claim(ClaimArgs),
    SetIgpBeneficiary(SetIgpBeneficiaryArgs),
    GasOracleConfig(GasOracleConfigArgs),
    DestinationGasOverhead(DestinationGasOverheadArgs),
    TransferIgpOwnership(TransferIgpOwnership),
    TransferOverheadIgpOwnership(TransferIgpOwnership),
    Configure(ConfigureIgpArgs),
}

#[derive(Args)]
struct IgpDeployProgramArgs {
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    chain: String,
    #[arg(long)]
    built_so_dir: PathBuf,
}

#[derive(Args)]
struct InitIgpAccountArgs {
    #[arg(long)]
    program_id: Pubkey,
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    chain: String,
    #[arg(long)]
    context: Option<String>,
    #[arg(long)]
    account_salt: Option<String>, // optional salt for deterministic account creation
}

#[derive(Args)]
struct InitOverheadIgpAccountArgs {
    #[arg(long)]
    program_id: Pubkey,
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    chain: String,
    #[arg(long)]
    inner_igp_account: Pubkey,
    #[arg(long)]
    context: Option<String>,
    #[arg(long)]
    account_salt: Option<String>, // optional salt for deterministic account creation
}

#[derive(Args)]
struct IgpQueryArgs {
    #[arg(long)]
    program_id: Pubkey,
    #[arg(long)]
    igp_account: Pubkey,
    #[arg(long)]
    gas_payment_account: Option<Pubkey>,
}

#[derive(Args)]
struct TransferIgpOwnership {
    #[arg(long, short)]
    program_id: Pubkey,
    // To avoid accidentally transferring ownership to None,
    // only support transferring to other Pubkeys for now.
    new_owner: Pubkey,
    #[arg(long)]
    igp_account: Pubkey,
}

#[derive(Args)]
struct PayForGasArgs {
    #[arg(long)]
    program_id: Pubkey,
    #[arg(long)]
    message_id: String,
    #[arg(long)]
    destination_domain: u32,
    #[arg(long)]
    gas: u64,
    #[arg(long)]
    account_salt: Option<String>, // optional salt for paying gas to a deterministically derived account
}

#[derive(Args)]
struct ClaimArgs {
    #[arg(long)]
    program_id: Pubkey,
    #[arg(long)]
    igp_account: Pubkey,
}

#[derive(Args)]
struct SetIgpBeneficiaryArgs {
    #[arg(long)]
    program_id: Pubkey,
    #[arg(long)]
    igp_account: Pubkey,
    new_beneficiary: Pubkey,
}

#[derive(Args)]
struct GasOracleConfigArgs {
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    chain_name: String,
    #[arg(long)]
    remote_domain: u32,
    #[command(subcommand)]
    cmd: GetSetCmd<GetGasOracleArgs, SetGasOracleArgs>,
}

#[derive(Args)]
struct SetGasOracleArgs {
    #[arg(long)]
    token_exchange_rate: u128,
    #[arg(long)]
    gas_price: u128,
    #[arg(long)]
    token_decimals: u8,
}

#[derive(Args)]
struct GetGasOracleArgs;

#[derive(Args)]
struct DestinationGasOverheadArgs {
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    chain_name: String,
    #[arg(long)]
    remote_domain: u32,
    #[command(subcommand)]
    cmd: GasOverheadSubCmd,
}

#[derive(Subcommand)]
enum GasOverheadSubCmd {
    Set(SetGasOverheadArgs),
    Get,
}

#[derive(Args)]
struct SetGasOverheadArgs {
    #[arg(long)]
    gas_overhead: u64,
}

#[derive(Args)]
struct ConfigureIgpArgs {
    #[arg(long)]
    program_id: Pubkey,
    #[arg(long)]
    chain: String,
    #[arg(long)]
    gas_oracle_config_file: PathBuf,
    #[arg(long)]
    chain_config_file: PathBuf,
    #[arg(long)]
    account_salt: Option<H256>,
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
    Deploy(MultisigIsmMessageIdDeploy),
    Init(MultisigIsmMessageIdInit),
    SetValidatorsAndThreshold(MultisigIsmMessageIdSetValidatorsAndThreshold),
    Query(MultisigIsmMessageIdQuery),
    TransferOwnership(TransferOwnership),
    Configure(MultisigIsmMessageIdConfigure),
}

#[derive(Args)]
struct MultisigIsmMessageIdDeploy {
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    built_so_dir: PathBuf,
    #[arg(long)]
    chain: String,
    #[arg(long)]
    context: String,
    #[arg(long)]
    chain_config_file: PathBuf,
}

#[derive(Args)]
struct MultisigIsmMessageIdConfigure {
    #[arg(long)]
    program_id: Pubkey,
    #[arg(long)]
    multisig_config_file: PathBuf,
    #[arg(long)]
    chain_config_file: PathBuf,
}

#[derive(Args)]
struct MultisigIsmMessageIdInit {
    #[arg(long, short, default_value_t = MULTISIG_ISM_MESSAGE_ID_PROG_ID)]
    program_id: Pubkey,
}

#[derive(Args)]
struct MultisigIsmMessageIdQuery {
    #[arg(long, short)]
    program_id: Pubkey,
    #[arg(long, value_delimiter = ',')]
    domains: Option<Vec<u32>>,
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

#[derive(Args)]
pub(crate) struct HelloWorldCmd {
    #[command(subcommand)]
    cmd: HelloWorldSubCmd,
}

#[derive(Subcommand)]
pub(crate) enum HelloWorldSubCmd {
    Deploy(HelloWorldDeploy),
    Query(HelloWorldQuery),
}

#[derive(Args)]
pub(crate) struct HelloWorldDeploy {
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    built_so_dir: PathBuf,
    #[arg(long)]
    config_file: PathBuf,
    #[arg(long)]
    chain_config_file: PathBuf,
    #[arg(long)]
    context: String,
}

#[derive(Args)]
pub(crate) struct HelloWorldQuery {
    #[arg(long)]
    program_id: Pubkey,
}

fn main() {
    pretty_env_logger::init();

    let cli = Cli::parse();
    let config = match cli.config.as_ref().or(CONFIG_FILE.as_ref()) {
        Some(config_file) => Config::load(config_file)
            .map_err(|e| format!("Failed to load solana config file {}: {}", config_file, e))
            .unwrap(),
        None => Config::default(),
    };
    let url = normalize_to_url_if_moniker(cli.url.unwrap_or(config.json_rpc_url));
    is_url(&url).unwrap();
    let client = RpcClient::new(url);

    let keypair_path = cli.keypair.unwrap_or(config.keypair_path);
    let (payer_pubkey, payer_keypair) = if let Ok(payer_keypair) = read_keypair_file(&keypair_path)
    {
        (
            payer_keypair.pubkey(),
            Some(PayerKeypair {
                keypair: payer_keypair,
                keypair_path: keypair_path.clone(),
            }),
        )
    } else {
        println!(
            "Provided key is not a keypair file, treating as a public key {}",
            keypair_path
        );
        (Pubkey::from_str(&keypair_path).unwrap(), None)
    };

    let commitment = CommitmentConfig::confirmed();

    let mut instructions = vec![];

    if cli.compute_budget != DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT {
        assert!(cli.compute_budget <= MAX_COMPUTE_UNIT_LIMIT);
        instructions.push(
            (
                ComputeBudgetInstruction::set_compute_unit_limit(cli.compute_budget),
                Some(format!("Set compute unit limit to {}", cli.compute_budget)),
            )
                .into(),
        );
    }
    if let Some(heap_size) = cli.heap_size {
        assert!(heap_size <= MAX_HEAP_FRAME_BYTES);
        instructions.push(
            (
                ComputeBudgetInstruction::request_heap_frame(heap_size),
                Some(format!("Request heap frame of {} bytes", heap_size)),
            )
                .into(),
        );
    }

    let ctx = Context::new(
        client,
        payer_pubkey,
        payer_keypair,
        commitment,
        instructions.into(),
        cli.require_tx_approval,
    );
    match cli.cmd {
        HyperlaneSealevelCmd::Mailbox(cmd) => process_mailbox_cmd(ctx, cmd),
        HyperlaneSealevelCmd::Token(cmd) => process_token_cmd(ctx, cmd),
        HyperlaneSealevelCmd::ValidatorAnnounce(cmd) => process_validator_announce_cmd(ctx, cmd),
        HyperlaneSealevelCmd::MultisigIsmMessageId(cmd) => {
            process_multisig_ism_message_id_cmd(ctx, cmd)
        }
        HyperlaneSealevelCmd::Core(cmd) => process_core_cmd(ctx, cmd),
        HyperlaneSealevelCmd::WarpRoute(cmd) => process_warp_route_cmd(ctx, cmd),
        HyperlaneSealevelCmd::HelloWorld(cmd) => process_helloworld_cmd(ctx, cmd),
        HyperlaneSealevelCmd::Igp(cmd) => process_igp_cmd(ctx, cmd),
        HyperlaneSealevelCmd::Squads(cmd) => process_squads_cmd(ctx, cmd),
    }
}

fn process_mailbox_cmd(ctx: Context, cmd: MailboxCmd) {
    match cmd.cmd {
        MailboxSubCmd::Init(init) => {
            let protocol_fee_beneficiary =
                init.protocol_fee_beneficiary.unwrap_or(ctx.payer_pubkey);
            let instruction = hyperlane_sealevel_mailbox::instruction::init_instruction(
                init.program_id,
                init.local_domain,
                init.default_ism,
                init.max_protocol_fee,
                ProtocolFee {
                    fee: init.protocol_fee,
                    beneficiary: protocol_fee_beneficiary,
                },
                ctx.payer_pubkey,
            )
            .unwrap();

            ctx.new_txn().add(instruction).send_with_payer();
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
                sender: ctx.payer_pubkey,
                destination_domain: outbox.destination,
                recipient: H256(outbox.recipient.to_bytes()),
                message_body: outbox.message.into(),
            });
            let outbox_instruction = Instruction {
                program_id: outbox.program_id,
                data: ixn.into_instruction_data().unwrap(),
                accounts: vec![
                    AccountMeta::new(outbox_account, false),
                    AccountMeta::new_readonly(ctx.payer_pubkey, true),
                    AccountMeta::new_readonly(spl_noop::id(), false),
                ],
            };
            ctx.new_txn().add(outbox_instruction).send_with_payer();
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
        MailboxSubCmd::TransferOwnership(transfer_ownership) => {
            let instruction =
                hyperlane_sealevel_mailbox::instruction::transfer_ownership_instruction(
                    transfer_ownership.program_id,
                    ctx.payer_pubkey,
                    Some(transfer_ownership.new_owner),
                )
                .unwrap();
            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!("Transfer ownership to {}", transfer_ownership.new_owner),
                )
                .send_with_payer();
        }
        MailboxSubCmd::SetDefaultIsm(set_default_ism) => {
            let instruction = hyperlane_sealevel_mailbox::instruction::set_default_ism_instruction(
                set_default_ism.program_id,
                ctx.payer_pubkey,
                set_default_ism.default_ism,
            )
            .unwrap();
            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!("Setting default ISM to {}", set_default_ism.default_ism),
                )
                .send_with_payer();
        }
    };
}

fn process_token_cmd(mut ctx: Context, cmd: TokenCmd) {
    match cmd.cmd {
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
                parse_token_account_data(query.token_type, &mut info.data.as_ref());
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

                    let (ata_payer_account, ata_payer_bump) = Pubkey::find_program_address(
                        hyperlane_token_ata_payer_pda_seeds!(),
                        &query.program_id,
                    );

                    println!(
                        "ATA payer account: {}, bump={}",
                        ata_payer_account, ata_payer_bump,
                    );
                }
            }
        }
        TokenSubCmd::TransferRemote(xfer) => {
            is_keypair(&xfer.sender).unwrap();
            ctx.commitment = CommitmentConfig::finalized();
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

            let fetched_token_account = ctx
                .client
                .get_account_with_commitment(&token_account, ctx.commitment)
                .unwrap()
                .value
                .unwrap();
            let token = HyperlaneTokenAccount::<()>::fetch(&mut &fetched_token_account.data[..])
                .unwrap()
                .into_inner();

            let unique_message_account_keypair = Keypair::new();
            let (dispatched_message_account, _dispatched_message_bump) =
                Pubkey::find_program_address(
                    mailbox_dispatched_message_pda_seeds!(&unique_message_account_keypair.pubkey()),
                    &token.mailbox,
                );

            let (mailbox_outbox_account, _mailbox_outbox_bump) =
                Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), &token.mailbox);

            let ixn = HtInstruction::TransferRemote(HtTransferRemote {
                destination_domain: xfer.destination_domain,
                recipient,
                amount_or_id: xfer.amount.into(),
            });

            // Transfers tokens to a remote.
            // Burns the tokens from the sender's associated token account and
            // then dispatches a message to the remote recipient.
            //
            // 0.    [executable] The system program.
            // 1.    [executable] The spl_noop program.
            // 2.    [] The token PDA account.
            // 3.    [executable] The mailbox program.
            // 4.    [writeable] The mailbox outbox account.
            // 5.    [] Message dispatch authority.
            // 6.    [signer] The token sender and mailbox payer.
            // 7.    [signer] Unique message / gas payment account.
            // 8.    [writeable] Message storage PDA.
            //       ---- If using an IGP ----
            // 9.    [executable] The IGP program.
            // 10.   [writeable] The IGP program data.
            // 11.   [writeable] Gas payment PDA.
            // 12.   [] OPTIONAL - The Overhead IGP program, if the configured IGP is an Overhead IGP.
            // 13.   [writeable] The IGP account.
            //       ---- End if ----
            // 14..N [??..??] Plugin-specific accounts.
            let mut accounts = vec![
                AccountMeta::new_readonly(system_program::id(), false),
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new_readonly(token_account, false),
                AccountMeta::new_readonly(token.mailbox, false),
                AccountMeta::new(mailbox_outbox_account, false),
                AccountMeta::new_readonly(dispatch_authority_account, false),
                AccountMeta::new(sender.pubkey(), true),
                AccountMeta::new_readonly(unique_message_account_keypair.pubkey(), true),
                AccountMeta::new(dispatched_message_account, false),
            ];

            if let Some((igp_program_id, igp_account_type)) = token.interchain_gas_paymaster {
                let (igp_program_data, _bump) =
                    Pubkey::find_program_address(igp_program_data_pda_seeds!(), &igp_program_id);
                let (gas_payment_pda, _bump) = Pubkey::find_program_address(
                    igp_gas_payment_pda_seeds!(&unique_message_account_keypair.pubkey()),
                    &igp_program_id,
                );

                accounts.extend([
                    AccountMeta::new_readonly(igp_program_id, false),
                    AccountMeta::new(igp_program_data, false),
                    AccountMeta::new(gas_payment_pda, false),
                ]);

                match igp_account_type {
                    InterchainGasPaymasterType::OverheadIgp(overhead_igp_account_id) => {
                        let overhead_igp_account = ctx
                            .client
                            .get_account_with_commitment(&overhead_igp_account_id, ctx.commitment)
                            .unwrap()
                            .value
                            .unwrap();
                        let overhead_igp_account =
                            OverheadIgpAccount::fetch(&mut &overhead_igp_account.data[..])
                                .unwrap()
                                .into_inner();
                        accounts.extend([
                            AccountMeta::new_readonly(overhead_igp_account_id, false),
                            AccountMeta::new(overhead_igp_account.inner, false),
                        ]);
                    }
                    InterchainGasPaymasterType::Igp(igp_account_id) => {
                        accounts.push(AccountMeta::new(igp_account_id, false));
                    }
                }
            }

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
            let tx_result = ctx.new_txn().add(xfer_instruction).send(&[
                &*ctx.payer_signer(),
                &sender,
                &unique_message_account_keypair,
            ]);
            // Print the output so it can be used in e2e tests
            println!("{:?}", tx_result);
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
                    AccountMeta::new_readonly(ctx.payer_pubkey, true),
                ],
            };
            ctx.new_txn().add(instruction).send_with_payer();
        }
        TokenSubCmd::TransferOwnership(transfer) => {
            let instruction =
                hyperlane_sealevel_token_lib::instruction::transfer_ownership_instruction(
                    transfer.program_id,
                    ctx.payer_pubkey,
                    Some(transfer.new_owner),
                )
                .unwrap();

            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!("Transfer ownership to {}", transfer.new_owner),
                )
                .send_with_payer();
        }
        TokenSubCmd::SetInterchainSecurityModule(set_ism) => {
            let instruction =
                hyperlane_sealevel_token_lib::instruction::set_interchain_security_module_instruction(
                    set_ism.program_id,
                    ctx.payer_pubkey,
                    set_ism.ism
                )
                .unwrap();

            ctx.new_txn()
                .add_with_description(instruction, format!("Set ISM to {:?}", set_ism.ism))
                .send_with_payer();
        }
        TokenSubCmd::Igp(args) => match args.cmd {
            GetSetCmd::Set(set_args) => {
                let igp_type: InterchainGasPaymasterType = match set_args.igp_type {
                    IgpType::Igp => InterchainGasPaymasterType::Igp(set_args.igp_account),
                    IgpType::OverheadIgp => {
                        InterchainGasPaymasterType::OverheadIgp(set_args.igp_account)
                    }
                };
                let instruction = hyperlane_sealevel_token_lib::instruction::set_igp_instruction(
                    args.program_id,
                    ctx.payer_pubkey,
                    Some((set_args.igp_program, igp_type.clone())),
                )
                .unwrap();

                ctx.new_txn()
                    .add_with_description(
                        instruction,
                        format!(
                            "Set IGP of {} to program {}, type {:?}",
                            args.program_id, set_args.igp_program, igp_type
                        ),
                    )
                    .send_with_payer();
            }
            GetSetCmd::Get(get_args) => {
                let (token_account, _token_bump) =
                    Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &args.program_id);
                let token_account = ctx
                    .client
                    .get_account_with_commitment(&token_account, ctx.commitment)
                    .unwrap()
                    .value
                    .expect(
                        "Token account not found. Make sure you are connected to the right RPC.",
                    );

                parse_token_account_data(get_args.token_type, &mut &token_account.data[..]);
            }
        },
    }
}

fn process_validator_announce_cmd(ctx: Context, cmd: ValidatorAnnounceCmd) {
    match cmd.cmd {
        ValidatorAnnounceSubCmd::Init(init) => {
            let init_instruction =
                hyperlane_sealevel_validator_announce::instruction::init_instruction(
                    init.program_id,
                    ctx.payer_pubkey,
                    init.mailbox_id,
                    init.local_domain,
                )
                .unwrap();
            ctx.new_txn().add(init_instruction).send_with_payer();
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
                AccountMeta::new_readonly(ctx.payer_pubkey, true),
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
            ctx.new_txn().add(announce_instruction).send_with_payer();
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
