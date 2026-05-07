//! Functional tests for the hyperlane-sealevel-fee program.

use std::{
    collections::BTreeSet,
    ops::{Deref, DerefMut},
};

use hyperlane_core::{H160, H256};
use solana_program::{
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
};
use solana_program_test::*;
use solana_sdk::{
    message::Message, signature::Signer, signer::keypair::Keypair, transaction::Transaction,
    transaction::TransactionError,
};
use solana_system_interface::program as system_program;

use serializable_account_meta::SimulationReturnData;

use account_utils::AccountError;
use hyperlane_sealevel_fee::{
    accounts::{
        CrossCollateralRoute, CrossCollateralRouteAccount, CrossCollateralRoutingFeeConfig,
        FeeAccount, FeeAccountData, FeeAccountPrefix, FeeData, FeeStandingQuotePda,
        FeeStandingQuotePdaAccount, LeafFeeConfig, RouteDomain, RouteDomainAccount,
        RoutingFeeConfig, DEFAULT_ROUTER, WILDCARD_AMOUNT, WILDCARD_DOMAIN, WILDCARD_RECIPIENT,
    },
    cc_route_pda_seeds,
    error::Error as FeeError,
    fee_account_pda_seeds,
    fee_math::{FeeDataStrategy, FeeParams},
    fee_standing_quote_pda_seeds,
    instruction::{self, Instruction as FeeInstruction},
    processor::process_instruction as fee_process_instruction,
    route_domain_pda_seeds, transient_quote_pda_seeds,
};
use k256::ecdsa::{SigningKey, VerifyingKey};
use quote_verifier::{QuoteValidationError, QuoteVerifyError, SvmSignedQuote};
use solana_program::keccak;

const LOCAL_DOMAIN: u32 = 1234;

fn fee_program_id() -> Pubkey {
    solana_program::pubkey!("Fee1111111111111111111111111111111111111111")
}

// --- Shared test helpers ---

struct TestBanksClient {
    ctx: ProgramTestContext,
}

impl Deref for TestBanksClient {
    type Target = BanksClient;

    fn deref(&self) -> &Self::Target {
        &self.ctx.banks_client
    }
}

impl DerefMut for TestBanksClient {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.ctx.banks_client
    }
}

async fn setup_client() -> (TestBanksClient, Keypair) {
    let program_id = fee_program_id();
    let program_test = ProgramTest::new(
        "hyperlane_sealevel_fee",
        program_id,
        processor!(fee_process_instruction),
    );
    let ctx = program_test.start_with_context().await;
    // Reset the clock to 0 so that transient-quote tests using small timestamps work.
    let mut clock = ctx
        .banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = 2;
    ctx.set_sysvar(&clock);
    let payer = ctx.payer.insecure_clone();
    (TestBanksClient { ctx }, payer)
}

async fn process_tx(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    instruction: Instruction,
    extra_signers: &[&Keypair],
) -> Result<(), BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await?;
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &signers,
        recent_blockhash,
    );
    banks_client.process_transaction(transaction).await
}

/// Simulates a QuoteFee instruction and returns the fee value from return data.
async fn simulate_quote_fee(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    instruction: Instruction,
) -> u64 {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[instruction],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap();
    if let Some(Err(err)) = &simulation.result {
        panic!("Simulation failed: {:?}", err);
    }
    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .expect("no return data");
    let bytes: [u8; 8] = return_data
        .data
        .try_into()
        .expect("expected 8 bytes of return data");
    u64::from_le_bytes(bytes)
}

fn assert_tx_error<T>(result: Result<T, BanksClientError>, expected: TransactionError) {
    if let BanksClientError::TransactionError(tx_err) = result.err().unwrap() {
        assert_eq!(tx_err, expected);
    } else {
        panic!("expected TransactionError");
    }
}

fn default_salt() -> H256 {
    H256::zero()
}

/// Extracts the leaf signers from a FeeAccount's fee_data.
fn leaf_signers(acct: &FeeAccount) -> &Option<BTreeSet<H160>> {
    match &acct.fee_data {
        FeeData::Leaf(cfg) => &cfg.signers,
        _ => panic!("expected Leaf fee_data"),
    }
}

/// Signs a message hash with a k256 private key and returns the 65-byte signature.
fn sign_hash(signing_key: &SigningKey, hash: &[u8; 32]) -> [u8; 65] {
    let (sig, recovery_id) = signing_key
        .sign_prehash_recoverable(hash)
        .expect("signing failed");
    let mut bytes = [0u8; 65];
    bytes[..64].copy_from_slice(&sig.to_bytes());
    bytes[64] = recovery_id.to_byte();
    bytes
}

/// Derives the Ethereum address (H160) from a k256 signing key.
fn eth_address(signing_key: &SigningKey) -> H160 {
    let verifying_key = VerifyingKey::from(signing_key);
    let pubkey_bytes = verifying_key.to_encoded_point(false);
    let hash = keccak::hash(&pubkey_bytes.as_bytes()[1..]);
    H160::from_slice(&hash.as_ref()[12..])
}

/// Creates a signed transient quote (expiry == issued_at).
fn make_signed_transient_quote(
    signing_key: &SigningKey,
    fee_account: &Pubkey,
    domain_id: u32,
    payer: &Pubkey,
    context: Vec<u8>,
    data: Vec<u8>,
    issued_at: [u8; 6],
) -> SvmSignedQuote {
    let client_salt = H256::random();
    let mut quote = SvmSignedQuote {
        context,
        data,
        issued_at,
        expiry: issued_at, // transient: expiry == issued_at
        client_salt,
        signature: [0u8; 65],
    };
    let scoped_salt = quote.compute_scoped_salt(payer);
    let message_hash = quote.build_message_hash(fee_account, domain_id, &scoped_salt);
    quote.signature = sign_hash(signing_key, message_hash.as_fixed_bytes());
    quote
}

fn default_leaf_fee_data() -> FeeData {
    FeeData::Leaf(LeafFeeConfig {
        strategy: FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        }),
        signers: Some(BTreeSet::new()),
    })
}

fn build_init_fee_ix(
    payer: &Pubkey,
    salt: H256,
    beneficiary: Pubkey,
    fee_data: FeeData,
) -> (Instruction, Pubkey) {
    let program_id = fee_program_id();
    let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(salt), &program_id);
    let ix = instruction::init_fee_instruction(
        program_id,
        *payer,
        salt,
        beneficiary,
        fee_data,
        LOCAL_DOMAIN,
    )
    .unwrap();
    (ix, fee_account)
}

async fn init_fee_account(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    salt: H256,
    beneficiary: Pubkey,
    fee_data: FeeData,
) -> Pubkey {
    let (ix, fee_account) = build_init_fee_ix(&payer.pubkey(), salt, beneficiary, fee_data);
    process_tx(banks_client, payer, ix, &[]).await.unwrap();
    fee_account
}

async fn fetch_fee_account(banks_client: &mut BanksClient, key: Pubkey) -> FeeAccount {
    let account = banks_client.get_account(key).await.unwrap().unwrap();
    FeeAccountData::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner()
        .data
}

async fn fetch_route_domain(banks_client: &mut BanksClient, key: Pubkey) -> RouteDomain {
    let account = banks_client.get_account(key).await.unwrap().unwrap();
    RouteDomainAccount::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner()
        .data
}

async fn fund_keypair(banks_client: &mut BanksClient, payer: &Keypair, target: &Keypair) {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[solana_system_interface::instruction::transfer(
            &payer.pubkey(),
            &target.pubkey(),
            1_000_000_000,
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();
}

async fn fetch_cc_route(banks_client: &mut BanksClient, key: Pubkey) -> CrossCollateralRoute {
    let account = banks_client.get_account(key).await.unwrap().unwrap();
    CrossCollateralRouteAccount::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner()
        .data
}

fn cc_route_pda_for(fee_account: &Pubkey, destination: u32, target_router: &H256) -> Pubkey {
    let dest_le = destination.to_le_bytes();
    let (pda, _) = Pubkey::find_program_address(
        cc_route_pda_seeds!(fee_account, &dest_le, target_router),
        &fee_program_id(),
    );
    pda
}

fn build_set_cc_route_ix(
    fee_account: &Pubkey,
    owner: &Pubkey,
    destination: u32,
    target_router: H256,
    strategy: FeeDataStrategy,
) -> Instruction {
    instruction::set_remote_fee_route_instruction(
        fee_program_id(),
        *fee_account,
        *owner,
        destination,
        Some(target_router),
        strategy,
        None,
    )
    .unwrap()
}

fn build_remove_cc_route_ix(
    fee_account: &Pubkey,
    owner: &Pubkey,
    destination: u32,
    target_router: H256,
) -> Instruction {
    instruction::remove_remote_fee_route_instruction(
        fee_program_id(),
        *fee_account,
        *owner,
        destination,
        Some(target_router),
    )
    .unwrap()
}

fn route_pda_for(fee_account: &Pubkey, domain: u32) -> Pubkey {
    let domain_le = domain.to_le_bytes();
    let (pda, _) = Pubkey::find_program_address(
        route_domain_pda_seeds!(fee_account, &domain_le),
        &fee_program_id(),
    );
    pda
}

fn build_set_route_ix(
    fee_account: &Pubkey,
    owner: &Pubkey,
    domain: u32,
    strategy: FeeDataStrategy,
) -> Instruction {
    instruction::set_remote_fee_route_instruction(
        fee_program_id(),
        *fee_account,
        *owner,
        domain,
        None,
        strategy,
        None,
    )
    .unwrap()
}

fn build_remove_route_ix(fee_account: &Pubkey, owner: &Pubkey, domain: u32) -> Instruction {
    instruction::remove_remote_fee_route_instruction(
        fee_program_id(),
        *fee_account,
        *owner,
        domain,
        None,
    )
    .unwrap()
}

/// Derives the standing quote PDA for a domain (or wildcard).
/// Standing quote PDA for Leaf/Routing (target_router = H256::zero() sentinel).
fn standing_quote_pda_for(fee_account: &Pubkey, domain: u32) -> Pubkey {
    let domain_le = domain.to_le_bytes();
    let (pda, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account, &domain_le),
        &fee_program_id(),
    );
    pda
}

/// Standing quote PDA for CC routing (target_router = actual router).
fn cc_standing_quote_pda_for(fee_account: &Pubkey, domain: u32, target_router: &H256) -> Pubkey {
    let domain_le = domain.to_le_bytes();
    let (pda, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account, &domain_le, target_router),
        &fee_program_id(),
    );
    pda
}

/// Builds a QuoteFee instruction for Leaf mode (no route accounts, no quote accounts).
fn build_quote_fee_leaf_ix(
    fee_account: &Pubkey,
    payer: &Pubkey,
    destination_domain: u32,
    recipient: H256,
    amount: u64,
) -> Instruction {
    // Standing quote PDAs (always present, uninitialized for on-chain-only tests).
    let domain_quotes_pda = standing_quote_pda_for(fee_account, destination_domain);
    let wildcard_quotes_pda = standing_quote_pda_for(fee_account, WILDCARD_DOMAIN);

    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
            destination_domain,
            recipient,
            amount,
            target_router: H256::zero(),
        }),
        vec![
            AccountMeta::new_readonly(*fee_account, false),
            AccountMeta::new(*payer, true),
            // No transient PDA — first variable account is domain standing quote.
            AccountMeta::new_readonly(domain_quotes_pda, false),
            AccountMeta::new_readonly(wildcard_quotes_pda, false),
        ],
    )
}

/// Builds a QuoteFee instruction for Routing mode.
fn build_quote_fee_routing_ix(
    fee_account: &Pubkey,
    payer: &Pubkey,
    destination_domain: u32,
    recipient: H256,
    amount: u64,
) -> Instruction {
    let domain_quotes_pda = standing_quote_pda_for(fee_account, destination_domain);
    let wildcard_quotes_pda = standing_quote_pda_for(fee_account, WILDCARD_DOMAIN);
    let route_pda = route_pda_for(fee_account, destination_domain);

    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
            destination_domain,
            recipient,
            amount,
            target_router: H256::zero(),
        }),
        vec![
            AccountMeta::new_readonly(*fee_account, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(domain_quotes_pda, false),
            AccountMeta::new_readonly(wildcard_quotes_pda, false),
            AccountMeta::new_readonly(route_pda, false),
        ],
    )
}

/// Builds a QuoteFee instruction for CrossCollateralRouting mode, emitting
/// every standing/route PDA the cascade may consult.
fn build_quote_fee_cc_ix(
    fee_account: &Pubkey,
    payer: &Pubkey,
    destination_domain: u32,
    recipient: H256,
    amount: u64,
    target_router: H256,
) -> Instruction {
    let specific_domain_quotes_pda =
        cc_standing_quote_pda_for(fee_account, destination_domain, &target_router);
    let default_domain_quotes_pda =
        cc_standing_quote_pda_for(fee_account, destination_domain, &DEFAULT_ROUTER);
    let wildcard_quotes_pda =
        cc_standing_quote_pda_for(fee_account, WILDCARD_DOMAIN, &target_router);
    let cc_specific_pda = cc_route_pda_for(fee_account, destination_domain, &target_router);
    let cc_default_pda = cc_route_pda_for(fee_account, destination_domain, &DEFAULT_ROUTER);

    let accounts = vec![
        AccountMeta::new_readonly(*fee_account, false),
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(specific_domain_quotes_pda, false),
        AccountMeta::new_readonly(default_domain_quotes_pda, false),
        AccountMeta::new_readonly(wildcard_quotes_pda, false),
        AccountMeta::new_readonly(cc_specific_pda, false),
        AccountMeta::new_readonly(cc_default_pda, false),
    ];

    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
            destination_domain,
            recipient,
            amount,
            target_router,
        }),
        accounts,
    )
}

fn build_add_quote_signer_ix(fee_account: &Pubkey, owner: &Pubkey, signer: H160) -> Instruction {
    build_add_quote_signer_ix_with_route(fee_account, owner, signer, None)
}

fn build_add_quote_signer_ix_with_route(
    fee_account: &Pubkey,
    owner: &Pubkey,
    signer: H160,
    route: Option<instruction::RouteKey>,
) -> Instruction {
    instruction::set_quote_signer_instruction(
        fee_program_id(),
        *fee_account,
        *owner,
        instruction::SetQuoteSignerOperation::Add(signer),
        route,
    )
    .unwrap()
}

fn build_remove_quote_signer_ix(fee_account: &Pubkey, owner: &Pubkey, signer: H160) -> Instruction {
    instruction::set_quote_signer_instruction(
        fee_program_id(),
        *fee_account,
        *owner,
        instruction::SetQuoteSignerOperation::Remove(signer),
        None,
    )
    .unwrap()
}

fn build_set_min_issued_at_ix(
    fee_account: &Pubkey,
    owner: &Pubkey,
    min_issued_at: i64,
) -> Instruction {
    instruction::set_min_issued_at_instruction(
        fee_program_id(),
        *fee_account,
        *owner,
        min_issued_at,
    )
    .unwrap()
}

// --- Shared encoding helpers ---

fn encode_u48(ts: i64) -> [u8; 6] {
    let bytes = ts.to_be_bytes();
    let mut out = [0u8; 6];
    out.copy_from_slice(&bytes[2..8]);
    out
}

fn encode_data(strategy: &FeeDataStrategy) -> Vec<u8> {
    borsh::to_vec(strategy).unwrap()
}

/// Shorthand for encoding Linear fee data (most common in tests).
fn encode_linear_data(max_fee: u64, half_amount: u64) -> Vec<u8> {
    encode_data(&FeeDataStrategy::Linear(FeeParams {
        max_fee,
        half_amount,
    }))
}

fn encode_context(dest: u32, recipient: H256, amount: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(44);
    buf.extend_from_slice(&dest.to_le_bytes());
    buf.extend_from_slice(recipient.as_bytes());
    buf.extend_from_slice(&amount.to_le_bytes());
    buf
}

fn encode_cc_context(dest: u32, recipient: H256, amount: u64, target_router: H256) -> Vec<u8> {
    let mut buf = Vec::with_capacity(76);
    buf.extend_from_slice(&dest.to_le_bytes());
    buf.extend_from_slice(recipient.as_bytes());
    buf.extend_from_slice(&amount.to_le_bytes());
    buf.extend_from_slice(target_router.as_bytes());
    buf
}

fn encode_standing_context(dest: u32, recipient: H256) -> Vec<u8> {
    let mut buf = Vec::with_capacity(44);
    buf.extend_from_slice(&dest.to_le_bytes());
    buf.extend_from_slice(recipient.as_bytes());
    buf.extend_from_slice(&u64::MAX.to_le_bytes());
    buf
}

fn encode_cc_standing_context(dest: u32, recipient: H256, target_router: H256) -> Vec<u8> {
    let mut buf = Vec::with_capacity(76);
    buf.extend_from_slice(&dest.to_le_bytes());
    buf.extend_from_slice(recipient.as_bytes());
    buf.extend_from_slice(&u64::MAX.to_le_bytes());
    buf.extend_from_slice(target_router.as_bytes());
    buf
}

fn make_signed_standing_quote(
    signing_key: &SigningKey,
    fee_account: &Pubkey,
    domain_id: u32,
    payer: &Pubkey,
    context: Vec<u8>,
    data: Vec<u8>,
    issued_at: [u8; 6],
    expiry: [u8; 6],
) -> SvmSignedQuote {
    let client_salt = H256::random();
    let mut quote = SvmSignedQuote {
        context,
        data,
        issued_at,
        expiry,
        client_salt,
        signature: [0u8; 65],
    };
    let scoped_salt = quote.compute_scoped_salt(payer);
    let message_hash = quote.build_message_hash(fee_account, domain_id, &scoped_salt);
    quote.signature = sign_hash(signing_key, message_hash.as_fixed_bytes());
    quote
}

fn build_submit_transient_ix(
    fee_account: &Pubkey,
    payer: &Pubkey,
    quote: &SvmSignedQuote,
) -> Instruction {
    build_submit_transient_ix_with_routes(fee_account, payer, quote, &[])
}

fn build_submit_transient_ix_with_routes(
    fee_account: &Pubkey,
    payer: &Pubkey,
    quote: &SvmSignedQuote,
    route_pdas: &[Pubkey],
) -> Instruction {
    let scoped_salt = quote.compute_scoped_salt(payer);
    instruction::submit_transient_quote_instruction(
        fee_program_id(),
        *payer,
        *fee_account,
        scoped_salt,
        quote.clone(),
        route_pdas,
    )
    .unwrap()
}

fn build_submit_standing_ix(
    fee_account: &Pubkey,
    payer: &Pubkey,
    quote: &SvmSignedQuote,
    dest_domain: u32,
) -> Instruction {
    build_submit_standing_ix_with_routes(fee_account, payer, quote, dest_domain, &H256::zero(), &[])
}

fn build_submit_standing_ix_with_routes(
    fee_account: &Pubkey,
    payer: &Pubkey,
    quote: &SvmSignedQuote,
    dest_domain: u32,
    target_router: &H256,
    route_pdas: &[Pubkey],
) -> Instruction {
    instruction::submit_standing_quote_instruction(
        fee_program_id(),
        *payer,
        *fee_account,
        dest_domain,
        *target_router,
        quote.clone(),
        route_pdas,
    )
    .unwrap()
}

fn build_close_transient_ix(
    fee_key: &Pubkey,
    transient_pda: &Pubkey,
    payer_refund: &Pubkey,
) -> Instruction {
    instruction::close_transient_quote_instruction(
        fee_program_id(),
        *fee_key,
        *transient_pda,
        *payer_refund,
    )
    .unwrap()
}

fn build_prune_ix(fee_account: &Pubkey, owner: &Pubkey, domain: u32) -> Instruction {
    instruction::prune_expired_quotes_instruction(
        fee_program_id(),
        *fee_account,
        *owner,
        domain,
        None,
    )
    .unwrap()
}

async fn fetch_standing_pda(banks_client: &mut BanksClient, key: Pubkey) -> FeeStandingQuotePda {
    let account = banks_client.get_account(key).await.unwrap().unwrap();
    FeeStandingQuotePdaAccount::fetch(&mut &account.data[..])
        .unwrap()
        .into_inner()
        .data
}

// ========= Test modules per instruction =========

mod init_fee {
    use super::*;

    #[tokio::test]
    async fn test_leaf() {
        let (mut banks_client, payer) = setup_client().await;
        let beneficiary = Pubkey::new_unique();
        let fee_data = default_leaf_fee_data();

        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            beneficiary,
            fee_data.clone(),
        )
        .await;

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.owner, Some(payer.pubkey()));
        assert_eq!(acct.beneficiary, beneficiary);
        assert_eq!(acct.fee_data, fee_data);
        assert_eq!(acct.domain_id, LOCAL_DOMAIN);
        assert_eq!(leaf_signers(&acct), &Some(BTreeSet::new()));
        assert_eq!(acct.min_issued_at, 0);
    }

    #[tokio::test]
    async fn test_routing() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(
            acct.fee_data,
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new()
            })
        );
    }

    #[tokio::test]
    async fn test_cross_collateral_routing() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(
            acct.fee_data,
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new()
            })
        );
    }

    #[tokio::test]
    async fn test_owner_is_signer() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.owner, Some(payer.pubkey()));
    }

    #[tokio::test]
    async fn test_double_init_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let _fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        // Use a different payer to avoid transaction deduplication.
        let payer2 = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &payer2).await;

        let (ix, _) = build_init_fee_ix(
            &payer2.pubkey(),
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        );
        let result = process_tx(&mut banks_client, &payer2, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
        );
    }

    #[tokio::test]
    async fn test_fee_account_prefix_parse_from_live_account() {
        let (mut banks_client, payer) = setup_client().await;
        let beneficiary = Pubkey::new_unique();
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            beneficiary,
            default_leaf_fee_data(),
        )
        .await;

        let account = banks_client.get_account(fee_key).await.unwrap().unwrap();
        let prefix = FeeAccountPrefix::parse_from(&account.data).unwrap();
        assert_eq!(prefix.beneficiary, beneficiary);
    }

    #[tokio::test]
    async fn test_leaf_zero_max_fee_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let (ix, _) = build_init_fee_ix(
            &payer.pubkey(),
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 0,
                    half_amount: 500,
                }),
                signers: Some(BTreeSet::new()),
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ZeroFeeParams as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_leaf_zero_half_amount_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let (ix, _) = build_init_fee_ix(
            &payer.pubkey(),
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Regressive(FeeParams {
                    max_fee: 1000,
                    half_amount: 0,
                }),
                signers: Some(BTreeSet::new()),
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ZeroFeeParams as u32),
            ),
        );
    }
}

mod set_beneficiary {
    use super::*;

    fn build_ix(fee_account: &Pubkey, owner: &Pubkey, beneficiary: Pubkey) -> Instruction {
        instruction::set_beneficiary_instruction(
            fee_program_id(),
            *fee_account,
            *owner,
            beneficiary,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn test_success() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let new_beneficiary = Pubkey::new_unique();
        let ix = build_ix(&key, &payer.pubkey(), new_beneficiary);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.beneficiary, new_beneficiary);
    }

    #[tokio::test]
    async fn test_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let non_owner = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &non_owner).await;

        let ix = build_ix(&key, &non_owner.pubkey(), Pubkey::new_unique());
        let result = process_tx(&mut banks_client, &non_owner, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }
}

mod transfer_ownership {
    use super::*;

    fn build_ix(fee_account: &Pubkey, owner: &Pubkey, new_owner: Option<Pubkey>) -> Instruction {
        Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::TransferOwnership(new_owner),
            vec![
                AccountMeta::new(*fee_account, false),
                AccountMeta::new_readonly(*owner, true),
            ],
        )
    }

    #[tokio::test]
    async fn test_transfer_to_new_owner() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let new_owner = Pubkey::new_unique();
        let ix = build_ix(&key, &payer.pubkey(), Some(new_owner));
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.owner, Some(new_owner));
    }

    #[tokio::test]
    async fn test_renounce_ownership() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_ix(&key, &payer.pubkey(), None);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.owner, None);
    }

    #[tokio::test]
    async fn test_immutable_account_rejects_admin_ops() {
        let (mut banks_client, payer) = setup_client().await;

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        // Renounce ownership to make the account immutable.
        let ix = build_ix(&fee_key, &payer.pubkey(), None);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let expected_err = TransactionError::InstructionError(0, InstructionError::InvalidArgument);

        // SetBeneficiary should fail — no owner.
        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SetBeneficiary(Pubkey::new_unique()),
            vec![
                AccountMeta::new(fee_key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(result, expected_err.clone());

        // TransferOwnership should fail.
        let ix = build_ix(&fee_key, &payer.pubkey(), Some(Pubkey::new_unique()));
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(result, expected_err.clone());

        // AddQuoteSigner should fail.
        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), H160::zero());
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(result, expected_err.clone());

        // UpdateFeeParams should fail.
        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::UpdateFeeParams(FeeParams {
                max_fee: 999,
                half_amount: 111,
            }),
            vec![
                AccountMeta::new(fee_key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(result, expected_err);
    }
}

mod update_fee_params {
    use super::*;

    fn build_ix(fee_account: &Pubkey, owner: &Pubkey, params: FeeParams) -> Instruction {
        Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::UpdateFeeParams(params),
            vec![
                AccountMeta::new(*fee_account, false),
                AccountMeta::new_readonly(*owner, true),
            ],
        )
    }

    #[tokio::test]
    async fn test_update_params() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let new_params = FeeParams {
            max_fee: 2000,
            half_amount: 1000,
        };
        let ix = build_ix(&key, &payer.pubkey(), new_params.clone());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, key).await;
        match acct.fee_data {
            FeeData::Leaf(cfg) => assert_eq!(*cfg.strategy.params(), new_params),
            _ => panic!("expected Leaf"),
        }
    }

    #[tokio::test]
    async fn test_preserves_curve_type() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Progressive(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let new_params = FeeParams {
            max_fee: 9999,
            half_amount: 5000,
        };
        let ix = build_ix(&key, &payer.pubkey(), new_params.clone());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, key).await;
        match acct.fee_data {
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Progressive(params),
                ..
            }) => {
                assert_eq!(params, new_params);
            }
            _ => panic!("expected Progressive Leaf"),
        }
    }

    #[tokio::test]
    async fn test_on_routing_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_ix(
            &key,
            &payer.pubkey(),
            FeeParams {
                max_fee: 100,
                half_amount: 50,
            },
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::NotLeafFeeData as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_zero_params_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_ix(
            &key,
            &payer.pubkey(),
            FeeParams {
                max_fee: 0,
                half_amount: 50,
            },
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ZeroFeeParams as u32),
            ),
        );

        let ix = build_ix(
            &key,
            &payer.pubkey(),
            FeeParams {
                max_fee: 100,
                half_amount: 0,
            },
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ZeroFeeParams as u32),
            ),
        );
    }
}

mod set_route {
    use super::*;

    #[tokio::test]
    async fn test_create_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 500,
            half_amount: 250,
        });
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), domain, strategy.clone());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route = fetch_route_domain(&mut banks_client, route_pda_for(&fee_key, domain)).await;
        assert_eq!(route.fee_data, strategy);
    }

    #[tokio::test]
    async fn test_update_existing_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let strategy1 = FeeDataStrategy::Linear(FeeParams {
            max_fee: 100,
            half_amount: 50,
        });
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), domain, strategy1);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let strategy2 = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 999,
            half_amount: 333,
        });
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), domain, strategy2.clone());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route = fetch_route_domain(&mut banks_client, route_pda_for(&fee_key, domain)).await;
        assert_eq!(route.fee_data, strategy2);
    }

    #[tokio::test]
    async fn test_on_leaf_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            42,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::NotRoutingFeeData as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_wildcard_domain_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            hyperlane_sealevel_fee::accounts::WILDCARD_DOMAIN,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::InvalidRouteDomain as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_zero_domain_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            0,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::InvalidRouteDomain as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_non_owner_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let non_owner = Keypair::new();

        // Fund non_owner so they can sign.
        let transfer_ix = solana_system_interface::instruction::transfer(
            &payer.pubkey(),
            &non_owner.pubkey(),
            1_000_000_000,
        );
        process_tx(&mut banks_client, &payer, transfer_ix, &[])
            .await
            .unwrap();

        let ix = build_set_route_ix(
            &fee_key,
            &non_owner.pubkey(),
            42,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        let result = process_tx(&mut banks_client, &non_owner, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }

    #[tokio::test]
    async fn test_set_route_resets_standing_quotes() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 100,
            half_amount: 50,
        });
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), domain, strategy);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Add signer to the route PDA.
        let ix = build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            signer_address,
            Some(instruction::RouteKey::Domain(domain)),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit a standing quote for that domain.
        let recipient = H256::zero();
        let context = encode_standing_context(domain, recipient);
        let data = encode_linear_data(5000, 2500);

        let quote = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix_with_routes(
            &fee_key,
            &payer.pubkey(),
            &quote,
            domain,
            &H256::zero(),
            &[route_pda_for(&fee_key, domain)],
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Verify standing quote exists.
        let domain_pda = standing_quote_pda_for(&fee_key, domain);
        let standing = fetch_standing_pda(&mut banks_client, domain_pda).await;
        assert_eq!(standing.quotes.len(), 1);

        // Update the route — this should reset (empty) the standing quote PDA.
        let new_strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 200,
            half_amount: 100,
        });
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), domain, new_strategy);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Verify standing quote PDA is now empty.
        let standing = fetch_standing_pda(&mut banks_client, domain_pda).await;
        assert!(
            standing.quotes.is_empty(),
            "Standing quotes must be reset after route update"
        );
    }

    #[tokio::test]
    async fn test_zero_params_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            42,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 0,
                half_amount: 50,
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ZeroFeeParams as u32),
            ),
        );
    }
}

mod remove_route {
    use super::*;

    #[tokio::test]
    async fn test_remove_existing_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            domain,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = build_remove_route_ix(&fee_key, &payer.pubkey(), domain);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let account = banks_client
            .get_account(route_pda_for(&fee_key, domain))
            .await
            .unwrap();
        assert!(account.is_none() || account.unwrap().data.is_empty());
    }

    #[tokio::test]
    async fn test_remove_nonexistent_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_remove_route_ix(&fee_key, &payer.pubkey(), 42);
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::RouteNotFound as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_recreate_after_remove() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let strategy1 = FeeDataStrategy::Linear(FeeParams {
            max_fee: 100,
            half_amount: 50,
        });

        // Create route.
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), domain, strategy1);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Remove route (close PDA).
        let ix = build_remove_route_ix(&fee_key, &payer.pubkey(), domain);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Recreate route on the same domain — PDA must be reusable after close.
        let strategy2 = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 200,
            half_amount: 100,
        });
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), domain, strategy2.clone());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route = fetch_route_domain(&mut banks_client, route_pda_for(&fee_key, domain)).await;
        assert_eq!(route.fee_data, strategy2);
    }

    #[tokio::test]
    async fn test_non_owner_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        // Create a route first (as owner).
        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            42,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Non-owner tries to remove it.
        let non_owner = Keypair::new();
        let transfer_ix = solana_system_interface::instruction::transfer(
            &payer.pubkey(),
            &non_owner.pubkey(),
            1_000_000_000,
        );
        process_tx(&mut banks_client, &payer, transfer_ix, &[])
            .await
            .unwrap();

        let ix = build_remove_route_ix(&fee_key, &non_owner.pubkey(), 42);
        let result = process_tx(&mut banks_client, &non_owner, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }

    #[tokio::test]
    async fn test_remove_route_closes_standing_quotes() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            domain,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Add signer and submit standing quote.
        let ix = build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            signer_address,
            Some(instruction::RouteKey::Domain(domain)),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let recipient = H256::zero();
        let context = encode_standing_context(domain, recipient);
        let data = encode_linear_data(5000, 2500);
        let quote = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix_with_routes(
            &fee_key,
            &payer.pubkey(),
            &quote,
            domain,
            &H256::zero(),
            &[route_pda_for(&fee_key, domain)],
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Verify standing quote PDA exists.
        let domain_pda = standing_quote_pda_for(&fee_key, domain);
        let account = banks_client.get_account(domain_pda).await.unwrap();
        assert!(account.is_some());

        // Remove the route.
        let ix = build_remove_route_ix(&fee_key, &payer.pubkey(), domain);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Verify standing quote PDA was closed.
        let account = banks_client.get_account(domain_pda).await.unwrap();
        assert!(
            account.is_none() || account.unwrap().data.is_empty(),
            "Standing quote PDA must be closed after route removal"
        );
    }
}

mod set_cc_route {
    use super::*;

    #[tokio::test]
    async fn test_create_cc_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let dest = 42u32;
        let target_router = H256::random();
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 500,
            half_amount: 250,
        });
        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            target_router,
            strategy.clone(),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route = fetch_cc_route(
            &mut banks_client,
            cc_route_pda_for(&fee_key, dest, &target_router),
        )
        .await;
        assert_eq!(route.fee_data, strategy);
    }

    #[tokio::test]
    async fn test_update_existing_cc_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let dest = 42u32;
        let target_router = H256::random();
        let strategy1 = FeeDataStrategy::Linear(FeeParams {
            max_fee: 100,
            half_amount: 50,
        });
        let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, target_router, strategy1);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let strategy2 = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 999,
            half_amount: 333,
        });
        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            target_router,
            strategy2.clone(),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route = fetch_cc_route(
            &mut banks_client,
            cc_route_pda_for(&fee_key, dest, &target_router),
        )
        .await;
        assert_eq!(route.fee_data, strategy2);
    }

    #[tokio::test]
    async fn test_different_target_routers_are_separate() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let dest = 42u32;
        let router_a = H256::random();
        let router_b = H256::random();

        let strategy_a = FeeDataStrategy::Linear(FeeParams {
            max_fee: 100,
            half_amount: 50,
        });
        let strategy_b = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 200,
            half_amount: 100,
        });

        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            router_a,
            strategy_a.clone(),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            router_b,
            strategy_b.clone(),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route_a = fetch_cc_route(
            &mut banks_client,
            cc_route_pda_for(&fee_key, dest, &router_a),
        )
        .await;
        let route_b = fetch_cc_route(
            &mut banks_client,
            cc_route_pda_for(&fee_key, dest, &router_b),
        )
        .await;
        assert_eq!(route_a.fee_data, strategy_a);
        assert_eq!(route_b.fee_data, strategy_b);
    }

    #[tokio::test]
    async fn test_on_routing_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            42,
            H256::random(),
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::NotCrossCollateralRoutingFeeData as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_wildcard_domain_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            WILDCARD_DOMAIN,
            H256::random(),
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::InvalidRouteDomain as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_zero_domain_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            0,
            H256::random(),
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::InvalidRouteDomain as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_zero_params_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            42,
            H256::random(),
            FeeDataStrategy::Progressive(FeeParams {
                max_fee: 100,
                half_amount: 0,
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ZeroFeeParams as u32),
            ),
        );
    }
}

mod remove_cc_route {
    use super::*;

    #[tokio::test]
    async fn test_remove_existing_cc_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let dest = 42u32;
        let target_router = H256::random();
        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            target_router,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = build_remove_cc_route_ix(&fee_key, &payer.pubkey(), dest, target_router);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let account = banks_client
            .get_account(cc_route_pda_for(&fee_key, dest, &target_router))
            .await
            .unwrap();
        assert!(account.is_none() || account.unwrap().data.is_empty());
    }

    #[tokio::test]
    async fn test_remove_nonexistent_cc_route_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_remove_cc_route_ix(&fee_key, &payer.pubkey(), 42, H256::random());
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::RouteNotFound as u32),
            ),
        );
    }
}

mod quote_fee {
    use super::*;

    #[tokio::test]
    async fn test_leaf_linear() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 1000,
                    half_amount: 500,
                }),
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        // Linear: min(1000, 500 * 1000 / (2 * 500)) = 500.
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), 42, H256::zero(), 500);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 500);
    }

    #[tokio::test]
    async fn test_leaf_regressive() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Regressive(FeeParams {
                    max_fee: 1000,
                    half_amount: 500,
                }),
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        // Regressive: 1000 * 1000 / (500 + 1000) = 666.
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), 42, H256::zero(), 1000);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 666);
    }

    #[tokio::test]
    async fn test_leaf_progressive() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Progressive(FeeParams {
                    max_fee: 1000,
                    half_amount: 500,
                }),
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        // Progressive: 1000 * 1000^2 / (500^2 + 1000^2) = 1000 * 1000000 / 1250000 = 800.
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), 42, H256::zero(), 1000);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 800);
    }

    #[tokio::test]
    async fn test_routing_with_configured_domain() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 500,
            half_amount: 250,
        });
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), domain, strategy);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = build_quote_fee_routing_ix(
            &fee_key,
            &payer.pubkey(),
            domain,
            H256::zero(),
            250, // at half_amount → fee = 250
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_routing_unconfigured_domain_returns_zero() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        // Unconfigured domain → fee = 0 (EVM-compatible behavior).
        let ix = build_quote_fee_routing_ix(
            &fee_key,
            &payer.pubkey(),
            99, // no route configured
            H256::zero(),
            1000,
        );
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 0);
    }

    #[tokio::test]
    async fn test_cc_routing_specific_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let dest = 42u32;
        let target_router = H256::random();
        let strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 500,
            half_amount: 250,
        });
        let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, target_router, strategy);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            H256::zero(),
            500,
            target_router,
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_cc_routing_falls_back_to_default_router() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let dest = 42u32;
        // Only set the DEFAULT_ROUTER route, not the specific one.
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 300,
            half_amount: 150,
        });
        let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, DEFAULT_ROUTER, strategy);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // QuoteFee with a specific target_router that has no route → falls back to default.
        let ix = build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            H256::zero(),
            150,
            H256::random(), // specific router not configured
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_cc_routing_no_route_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        // No routes configured at all.
        let ix = build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            42,
            H256::zero(),
            1000,
            H256::random(),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::RouteNotFound as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_cc_routing_default_pda_drained_when_specific_active() {
        // Both CC route PDAs are always required by the layout. When the
        // specific route is initialized it takes precedence, but the default
        // slot must still be drained so ensure_no_extraneous_accounts doesn't
        // reject it.
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let dest = 42u32;
        let target_router = H256::random();
        // Initialize both specific and default with distinct strategies so we
        // can tell which one was used by the resulting fee.
        process_tx(
            &mut banks_client,
            &payer,
            build_set_cc_route_ix(
                &fee_key,
                &payer.pubkey(),
                dest,
                target_router,
                FeeDataStrategy::Linear(FeeParams {
                    max_fee: 500,
                    half_amount: 250,
                }),
            ),
            &[],
        )
        .await
        .unwrap();
        process_tx(
            &mut banks_client,
            &payer,
            build_set_cc_route_ix(
                &fee_key,
                &payer.pubkey(),
                dest,
                DEFAULT_ROUTER,
                FeeDataStrategy::Linear(FeeParams {
                    max_fee: 999,
                    half_amount: 1,
                }),
            ),
            &[],
        )
        .await
        .unwrap();

        let ix = build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            H256::zero(),
            500,
            target_router,
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_cc_routing_extraneous_after_both_pdas() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let dest = 42u32;
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 300,
            half_amount: 150,
        });
        let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, DEFAULT_ROUTER, strategy);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let target_router = H256::random();
        let specific_domain_quotes_pda = cc_standing_quote_pda_for(&fee_key, dest, &target_router);
        let default_domain_quotes_pda = cc_standing_quote_pda_for(&fee_key, dest, &DEFAULT_ROUTER);
        let wildcard_quotes_pda =
            cc_standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN, &target_router);
        let cc_specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);
        let cc_default_pda = cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER);

        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient: H256::zero(),
                amount: 150,
                target_router,
            }),
            vec![
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(specific_domain_quotes_pda, false),
                AccountMeta::new_readonly(default_domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
                AccountMeta::new_readonly(cc_specific_pda, false),
                AccountMeta::new_readonly(cc_default_pda, false),
                AccountMeta::new_readonly(Pubkey::new_unique(), false), // extraneous
            ],
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(AccountError::ExtraneousAccount as u32),
            ),
        );
    }
}

mod add_quote_signer {
    use super::*;

    #[tokio::test]
    async fn test_add_signer() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let signer = H160::random();
        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        assert!(leaf_signers(&acct).as_ref().unwrap().contains(&signer));
        assert_eq!(leaf_signers(&acct).as_ref().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_add_multiple_signers() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let signer1 = H160::random();
        let signer2 = H160::random();

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer1);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer2);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        assert!(leaf_signers(&acct).as_ref().unwrap().contains(&signer1));
        assert!(leaf_signers(&acct).as_ref().unwrap().contains(&signer2));
        assert_eq!(leaf_signers(&acct).as_ref().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn test_add_duplicate_is_idempotent() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let signer = H160::random();
        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        assert_eq!(leaf_signers(&acct).as_ref().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let non_owner = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &non_owner).await;

        let ix = build_add_quote_signer_ix(&fee_key, &non_owner.pubkey(), H160::random());
        let result = process_tx(&mut banks_client, &non_owner, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }

    #[tokio::test]
    async fn test_add_on_leaf_with_no_signers_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: None, // on-chain-only
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), H160::random());
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::OffchainQuotingNotConfigured as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_add_signer_to_domain_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            domain,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let signer = H160::random();
        let ix = build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            signer,
            Some(instruction::RouteKey::Domain(domain)),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route = fetch_route_domain(&mut banks_client, route_pda_for(&fee_key, domain)).await;
        assert!(route.signers.as_ref().unwrap().contains(&signer));
        assert_eq!(route.signers.as_ref().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_remove_signer_from_domain_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let ix = build_set_route_ix(
            &fee_key,
            &payer.pubkey(),
            domain,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let signer = H160::random();
        let ix = build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            signer,
            Some(instruction::RouteKey::Domain(domain)),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = instruction::set_quote_signer_instruction(
            fee_program_id(),
            fee_key,
            payer.pubkey(),
            instruction::SetQuoteSignerOperation::Remove(signer),
            Some(instruction::RouteKey::Domain(domain)),
        )
        .unwrap();
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route = fetch_route_domain(&mut banks_client, route_pda_for(&fee_key, domain)).await;
        assert!(route.signers.as_ref().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_domain_route_signer_on_leaf_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            H160::random(),
            Some(instruction::RouteKey::Domain(42)),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::NotRoutingFeeData as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_cc_route_signer_on_routing_account_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            H160::random(),
            Some(instruction::RouteKey::CrossCollateral {
                destination: 42,
                target_router: H256::random(),
            }),
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::NotCrossCollateralRoutingFeeData as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_add_signer_to_cc_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let domain = 42u32;
        let target_router = H256::random();
        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            domain,
            target_router,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let signer = H160::random();
        let ix = build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            signer,
            Some(instruction::RouteKey::CrossCollateral {
                destination: domain,
                target_router,
            }),
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let route = fetch_cc_route(
            &mut banks_client,
            cc_route_pda_for(&fee_key, domain, &target_router),
        )
        .await;
        assert!(route.signers.as_ref().unwrap().contains(&signer));
        assert_eq!(route.signers.as_ref().unwrap().len(), 1);
    }
}

mod remove_quote_signer {
    use super::*;

    #[tokio::test]
    async fn test_remove_signer() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let signer = H160::random();
        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let ix = build_remove_quote_signer_ix(&fee_key, &payer.pubkey(), signer);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        assert!(!leaf_signers(&acct).as_ref().unwrap().contains(&signer));
        assert_eq!(leaf_signers(&acct).as_ref().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_is_safe() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_remove_quote_signer_ix(&fee_key, &payer.pubkey(), H160::random());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // signers is still Some(empty) (remove nonexistent from empty set is a no-op).
        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        assert_eq!(leaf_signers(&acct), &Some(BTreeSet::new()));
    }

    #[tokio::test]
    async fn test_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let non_owner = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &non_owner).await;

        let ix = build_remove_quote_signer_ix(&fee_key, &non_owner.pubkey(), H160::random());
        let result = process_tx(&mut banks_client, &non_owner, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }
}

mod set_min_issued_at {
    use super::*;

    #[tokio::test]
    async fn test_set_value() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_set_min_issued_at_ix(&fee_key, &payer.pubkey(), 1000);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        assert_eq!(acct.min_issued_at, 1000);
    }

    #[tokio::test]
    async fn test_monotonic_increase_only() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        // Increase: 0 → 5000.
        let ix = build_set_min_issued_at_ix(&fee_key, &payer.pubkey(), 5000);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
        assert_eq!(
            fetch_fee_account(&mut banks_client, fee_key)
                .await
                .min_issued_at,
            5000
        );

        // Decrease: 5000 → 100. Must fail.
        let ix = build_set_min_issued_at_ix(&fee_key, &payer.pubkey(), 100);
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::MinIssuedAtMustBeMonotonic as u32),
            ),
        );

        // Value unchanged.
        assert_eq!(
            fetch_fee_account(&mut banks_client, fee_key)
                .await
                .min_issued_at,
            5000
        );
    }

    #[tokio::test]
    async fn test_equal_value_accepted() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_set_min_issued_at_ix(&fee_key, &payer.pubkey(), 5000);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Same value again — should succeed (< is the guard, not <=).
        let ix = build_set_min_issued_at_ix(&fee_key, &payer.pubkey(), 5000);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        assert_eq!(
            fetch_fee_account(&mut banks_client, fee_key)
                .await
                .min_issued_at,
            5000
        );
    }

    #[tokio::test]
    async fn test_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let non_owner = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &non_owner).await;

        let ix = build_set_min_issued_at_ix(&fee_key, &non_owner.pubkey(), 999);
        let result = process_tx(&mut banks_client, &non_owner, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }
}

mod set_wildcard_quote_signers {
    use super::*;

    fn build_set_wildcard_signers_ix(
        fee_account: &Pubkey,
        owner: &Pubkey,
        signers: BTreeSet<H160>,
    ) -> Instruction {
        instruction::set_wildcard_quote_signers_instruction(
            fee_program_id(),
            *fee_account,
            *owner,
            signers,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn test_routing_set_wildcard_signers() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        let ix = build_set_wildcard_signers_ix(&fee_key, &payer.pubkey(), signers.clone());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        match &acct.fee_data {
            FeeData::Routing(cfg) => assert_eq!(cfg.wildcard_signers, signers),
            _ => panic!("expected Routing"),
        }
    }

    #[tokio::test]
    async fn test_cc_set_wildcard_signers() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        let ix = build_set_wildcard_signers_ix(&fee_key, &payer.pubkey(), signers.clone());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        match &acct.fee_data {
            FeeData::CrossCollateralRouting(cfg) => {
                assert_eq!(cfg.wildcard_signers, signers)
            }
            _ => panic!("expected CrossCollateralRouting"),
        }
    }

    #[tokio::test]
    async fn test_leaf_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_set_wildcard_signers_ix(&fee_key, &payer.pubkey(), BTreeSet::new());
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::WildcardSignersNotApplicable as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let non_owner = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &non_owner).await;

        let ix = build_set_wildcard_signers_ix(&fee_key, &non_owner.pubkey(), BTreeSet::new());
        let result = process_tx(&mut banks_client, &non_owner, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }

    #[tokio::test]
    async fn test_set_to_none_disables() {
        let (mut banks_client, payer) = setup_client().await;
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: signers,
            }),
        )
        .await;

        // Set to empty (disables wildcard quoting).
        let ix = build_set_wildcard_signers_ix(&fee_key, &payer.pubkey(), BTreeSet::new());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        match &acct.fee_data {
            FeeData::Routing(cfg) => assert!(cfg.wildcard_signers.is_empty()),
            _ => panic!("expected Routing"),
        }
    }
}

#[path = "functional/cc.rs"]
mod cc;
#[path = "functional/helpers.rs"]
mod helpers;
#[path = "functional/standing.rs"]
mod standing;
#[path = "functional/transient.rs"]
mod transient;
