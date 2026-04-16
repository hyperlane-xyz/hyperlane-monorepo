//! Functional tests for the hyperlane-sealevel-fee program.

use std::collections::BTreeSet;

use hyperlane_core::{H160, H256};
use solana_program::{
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
};
use solana_program_test::*;
use solana_sdk::{
    signature::Signer, signer::keypair::Keypair, transaction::Transaction,
    transaction::TransactionError,
};
use solana_system_interface::program as system_program;

use account_utils::AccountData;
use hyperlane_sealevel_fee::{
    accounts::{
        CrossCollateralRoute, CrossCollateralRouteAccount, FeeAccount, FeeAccountData, FeeData,
        RouteDomain, RouteDomainAccount, DEFAULT_ROUTER, WILDCARD_DOMAIN,
    },
    cc_route_pda_seeds,
    error::Error as FeeError,
    fee_account_pda_seeds,
    fee_math::{FeeDataStrategy, FeeParams},
    fee_standing_quote_pda_seeds,
    instruction::Instruction as FeeInstruction,
    processor::process_instruction as fee_process_instruction,
    route_domain_pda_seeds, transient_quote_pda_seeds,
};
use k256::ecdsa::{SigningKey, VerifyingKey};
use quote_verifier::SvmSignedQuote;
use solana_program::keccak;

const LOCAL_DOMAIN: u32 = 1234;

fn fee_program_id() -> Pubkey {
    solana_program::pubkey!("Fee1111111111111111111111111111111111111111")
}

// --- Shared test helpers ---

async fn setup_client() -> (BanksClient, Keypair) {
    let program_id = fee_program_id();
    let program_test = ProgramTest::new(
        "hyperlane_sealevel_fee",
        program_id,
        processor!(fee_process_instruction),
    );
    let (banks_client, payer, _) = program_test.start().await;
    (banks_client, payer)
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
    FeeData::Leaf(FeeDataStrategy::Linear(FeeParams {
        max_fee: 1000,
        half_amount: 500,
    }))
}

fn build_init_fee_ix(
    payer: &Pubkey,
    salt: H256,
    owner: Option<Pubkey>,
    beneficiary: Pubkey,
    fee_data: FeeData,
) -> (Instruction, Pubkey) {
    let program_id = fee_program_id();
    let (fee_account, _) = Pubkey::find_program_address(fee_account_pda_seeds!(salt), &program_id);
    let ix = Instruction::new_with_borsh(
        program_id,
        &FeeInstruction::InitFee(hyperlane_sealevel_fee::instruction::InitFee {
            salt,
            owner,
            beneficiary,
            fee_data,
            domain_id: LOCAL_DOMAIN,
        }),
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new(fee_account, false),
        ],
    );
    (ix, fee_account)
}

async fn init_fee_account(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    salt: H256,
    owner: Option<Pubkey>,
    beneficiary: Pubkey,
    fee_data: FeeData,
) -> Pubkey {
    let (ix, fee_account) = build_init_fee_ix(&payer.pubkey(), salt, owner, beneficiary, fee_data);
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
    let cc_pda = cc_route_pda_for(fee_account, destination, &target_router);
    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::SetCrossCollateralRoute(
            hyperlane_sealevel_fee::instruction::SetCrossCollateralRoute {
                destination,
                target_router,
                fee_data: strategy,
            },
        ),
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(*fee_account, false),
            AccountMeta::new(*owner, true),
            AccountMeta::new(cc_pda, false),
        ],
    )
}

fn build_remove_cc_route_ix(
    fee_account: &Pubkey,
    owner: &Pubkey,
    destination: u32,
    target_router: H256,
) -> Instruction {
    let cc_pda = cc_route_pda_for(fee_account, destination, &target_router);
    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::RemoveCrossCollateralRoute(
            hyperlane_sealevel_fee::instruction::RemoveCrossCollateralRoute {
                destination,
                target_router,
            },
        ),
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(*fee_account, false),
            AccountMeta::new(*owner, true),
            AccountMeta::new(cc_pda, false),
        ],
    )
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
    let route_pda = route_pda_for(fee_account, domain);
    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::SetRoute(hyperlane_sealevel_fee::instruction::SetRoute {
            domain,
            fee_data: strategy,
        }),
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(*fee_account, false),
            AccountMeta::new(*owner, true),
            AccountMeta::new(route_pda, false),
        ],
    )
}

fn build_remove_route_ix(fee_account: &Pubkey, owner: &Pubkey, domain: u32) -> Instruction {
    let route_pda = route_pda_for(fee_account, domain);
    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::RemoveRoute(domain),
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(*fee_account, false),
            AccountMeta::new(*owner, true),
            AccountMeta::new(route_pda, false),
        ],
    )
}

/// Derives the standing quote PDA for a domain (or wildcard).
fn standing_quote_pda_for(fee_account: &Pubkey, domain: u32) -> Pubkey {
    let domain_le = domain.to_le_bytes();
    let (pda, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account, &domain_le),
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
            AccountMeta::new_readonly(system_program::ID, false),
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
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(*fee_account, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(domain_quotes_pda, false),
            AccountMeta::new_readonly(wildcard_quotes_pda, false),
            AccountMeta::new_readonly(route_pda, false),
        ],
    )
}

/// Builds a QuoteFee instruction for CrossCollateralRouting mode.
/// `include_default` controls whether the DEFAULT_ROUTER PDA is appended (for fallback tests).
fn build_quote_fee_cc_ix(
    fee_account: &Pubkey,
    payer: &Pubkey,
    destination_domain: u32,
    recipient: H256,
    amount: u64,
    target_router: H256,
    include_default: bool,
) -> Instruction {
    let domain_quotes_pda = standing_quote_pda_for(fee_account, destination_domain);
    let wildcard_quotes_pda = standing_quote_pda_for(fee_account, WILDCARD_DOMAIN);
    let cc_specific_pda = cc_route_pda_for(fee_account, destination_domain, &target_router);

    let mut accounts = vec![
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(*fee_account, false),
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(domain_quotes_pda, false),
        AccountMeta::new_readonly(wildcard_quotes_pda, false),
        AccountMeta::new_readonly(cc_specific_pda, false),
    ];

    if include_default {
        let cc_default_pda = cc_route_pda_for(fee_account, destination_domain, &DEFAULT_ROUTER);
        accounts.push(AccountMeta::new_readonly(cc_default_pda, false));
    }

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
    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::AddQuoteSigner { signer },
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(*fee_account, false),
            AccountMeta::new(*owner, true),
        ],
    )
}

fn build_remove_quote_signer_ix(fee_account: &Pubkey, owner: &Pubkey, signer: H160) -> Instruction {
    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::RemoveQuoteSigner { signer },
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(*fee_account, false),
            AccountMeta::new(*owner, true),
        ],
    )
}

fn build_set_min_issued_at_ix(
    fee_account: &Pubkey,
    owner: &Pubkey,
    min_issued_at: i64,
) -> Instruction {
    Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::SetMinIssuedAt { min_issued_at },
        vec![
            AccountMeta::new(*fee_account, false),
            AccountMeta::new_readonly(*owner, true),
        ],
    )
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
            Some(payer.pubkey()),
            beneficiary,
            fee_data.clone(),
        )
        .await;

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.owner, Some(payer.pubkey()));
        assert_eq!(acct.beneficiary, beneficiary);
        assert_eq!(acct.fee_data, fee_data);
        assert_eq!(acct.domain_id, LOCAL_DOMAIN);
        assert_eq!(acct.signers, BTreeSet::new());
        assert_eq!(acct.min_issued_at, 0);
        assert_eq!(acct.standing_quote_domains, BTreeSet::new());
    }

    #[tokio::test]
    async fn test_routing() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
        )
        .await;

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.fee_data, FeeData::Routing);
    }

    #[tokio::test]
    async fn test_cross_collateral_routing() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
        )
        .await;

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.fee_data, FeeData::CrossCollateralRouting);
    }

    #[tokio::test]
    async fn test_no_owner() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            None,
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let acct = fetch_fee_account(&mut banks_client, key).await;
        assert_eq!(acct.owner, None);
    }

    #[tokio::test]
    async fn test_double_init_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let _fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
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
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        );
        let result = process_tx(&mut banks_client, &payer2, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
        );
    }
}

mod set_beneficiary {
    use super::*;

    fn build_ix(fee_account: &Pubkey, owner: &Pubkey, beneficiary: Pubkey) -> Instruction {
        Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SetBeneficiary(beneficiary),
            vec![
                AccountMeta::new(*fee_account, false),
                AccountMeta::new_readonly(*owner, true),
            ],
        )
    }

    #[tokio::test]
    async fn test_success() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
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
            Some(payer.pubkey()),
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

    #[tokio::test]
    async fn test_extraneous_account_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SetBeneficiary(Pubkey::new_unique()),
            vec![
                AccountMeta::new(key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(Pubkey::new_unique(), false),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ExtraneousAccount as u32),
            ),
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
            Some(payer.pubkey()),
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
            Some(payer.pubkey()),
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
            Some(payer.pubkey()),
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
            FeeData::Leaf(strategy) => assert_eq!(*strategy.params(), new_params),
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Leaf(FeeDataStrategy::Progressive(FeeParams {
                max_fee: 100,
                half_amount: 50,
            })),
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
            FeeData::Leaf(FeeDataStrategy::Progressive(params)) => {
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
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
            Some(payer.pubkey()),
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Leaf(FeeDataStrategy::Linear(FeeParams {
                max_fee: 1000,
                half_amount: 500,
            })),
        )
        .await;

        let ix = build_quote_fee_leaf_ix(
            &fee_key,
            &payer.pubkey(),
            42,
            H256::zero(),
            500, // at half_amount → fee = 500
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_leaf_regressive() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Leaf(FeeDataStrategy::Regressive(FeeParams {
                max_fee: 1000,
                half_amount: 500,
            })),
        )
        .await;

        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), 42, H256::zero(), 1000);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_leaf_progressive() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Leaf(FeeDataStrategy::Progressive(FeeParams {
                max_fee: 1000,
                half_amount: 500,
            })),
        )
        .await;

        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), 42, H256::zero(), 1000);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_routing_with_configured_domain() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
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
    async fn test_routing_unconfigured_domain_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
        )
        .await;

        let ix = build_quote_fee_routing_ix(
            &fee_key,
            &payer.pubkey(),
            99, // no route configured
            H256::zero(),
            1000,
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
    async fn test_cc_routing_specific_route() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
            false, // specific route exists, no need for default
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
            true,           // include default PDA for fallback
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
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
            true, // include default PDA (both uninitialized)
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
    async fn test_cc_routing_extraneous_default_when_specific_exists() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
        )
        .await;

        let dest = 42u32;
        let target_router = H256::random();
        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 500,
            half_amount: 250,
        });
        let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, target_router, strategy);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Pass both specific + default PDAs even though specific exists.
        // The default PDA should be flagged as extraneous.
        let ix = build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            H256::zero(),
            500,
            target_router,
            true, // include default — should be extraneous
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ExtraneousAccount as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_cc_routing_extraneous_after_both_pdas() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
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
        let domain_quotes_pda = standing_quote_pda_for(&fee_key, dest);
        let wildcard_quotes_pda = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);
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
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(domain_quotes_pda, false),
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
                InstructionError::Custom(FeeError::ExtraneousAccount as u32),
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
            Some(payer.pubkey()),
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
        assert!(acct.signers.contains(&signer));
        assert_eq!(acct.signers.len(), 1);
    }

    #[tokio::test]
    async fn test_add_multiple_signers() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
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
        assert!(acct.signers.contains(&signer1));
        assert!(acct.signers.contains(&signer2));
        assert_eq!(acct.signers.len(), 2);
    }

    #[tokio::test]
    async fn test_add_duplicate_is_idempotent() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
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
        assert_eq!(acct.signers.len(), 1);
    }

    #[tokio::test]
    async fn test_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
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
    async fn test_extraneous_account_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::AddQuoteSigner {
                signer: H160::random(),
            },
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(Pubkey::new_unique(), false),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ExtraneousAccount as u32),
            ),
        );
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
            Some(payer.pubkey()),
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
        assert!(!acct.signers.contains(&signer));
        assert_eq!(acct.signers.len(), 0);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_is_safe() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_remove_quote_signer_ix(&fee_key, &payer.pubkey(), H160::random());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        assert_eq!(acct.signers.len(), 0);
    }

    #[tokio::test]
    async fn test_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
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

    #[tokio::test]
    async fn test_extraneous_account_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::RemoveQuoteSigner {
                signer: H160::random(),
            },
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(Pubkey::new_unique(), false),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ExtraneousAccount as u32),
            ),
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
            Some(payer.pubkey()),
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
    async fn test_can_increase_and_decrease() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

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

        let ix = build_set_min_issued_at_ix(&fee_key, &payer.pubkey(), 100);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
        assert_eq!(
            fetch_fee_account(&mut banks_client, fee_key)
                .await
                .min_issued_at,
            100
        );
    }

    #[tokio::test]
    async fn test_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
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

    #[tokio::test]
    async fn test_extraneous_account_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SetMinIssuedAt { min_issued_at: 100 },
            vec![
                AccountMeta::new(fee_key, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new_readonly(Pubkey::new_unique(), false),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ExtraneousAccount as u32),
            ),
        );
    }
}

mod submit_transient_quote {
    use super::*;

    fn build_submit_transient_ix(
        fee_account: &Pubkey,
        payer: &Pubkey,
        quote: &SvmSignedQuote,
    ) -> Instruction {
        let scoped_salt = quote.compute_scoped_salt(payer);
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_account, scoped_salt),
            &fee_program_id(),
        );

        Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SubmitQuote(quote.clone()),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(*payer, true),
                AccountMeta::new_readonly(*fee_account, false),
                AccountMeta::new(transient_pda, false),
            ],
        )
    }

    /// Encodes a u48 BE timestamp from an i64.
    fn encode_u48(ts: i64) -> [u8; 6] {
        let bytes = ts.to_be_bytes();
        let mut out = [0u8; 6];
        out.copy_from_slice(&bytes[2..8]);
        out
    }

    #[tokio::test]
    async fn test_submit_transient_quote() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        // Add signer.
        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Use a far-future timestamp so the quote hasn't expired.
        let issued_at = encode_u48(9999999999);
        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            vec![1, 2, 3, 4],
            vec![5, 6, 7, 8],
            issued_at,
        );

        let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Verify the transient PDA was created.
        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );
        let account = banks_client
            .get_account(transient_pda)
            .await
            .unwrap()
            .unwrap();
        assert!(!account.data.is_empty());
        assert_eq!(account.owner, fee_program_id());
    }

    #[tokio::test]
    async fn test_invalid_signature_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Create a quote signed by a DIFFERENT key.
        let wrong_key = SigningKey::random(&mut rand::thread_rng());
        let issued_at = encode_u48(9999999999);
        let quote = make_signed_transient_quote(
            &wrong_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            vec![1, 2, 3],
            vec![4, 5, 6],
            issued_at,
        );

        let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::InvalidQuoteSignature as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_no_signers_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        // Don't add any signers.
        let issued_at = encode_u48(9999999999);
        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            vec![],
            vec![],
            issued_at,
        );

        let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::InvalidQuoteSignature as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_expiry_before_issued_at_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Manually create a quote with expiry < issued_at.
        let quote = SvmSignedQuote {
            context: vec![],
            data: vec![],
            issued_at: encode_u48(200),
            expiry: encode_u48(100), // expiry before issued_at
            client_salt: H256::random(),
            signature: [0u8; 65],
        };

        let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::InvalidQuoteExpiry as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_extraneous_account_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let issued_at = encode_u48(9999999999);
        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            vec![1, 2],
            vec![3, 4],
            issued_at,
        );

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SubmitQuote(quote),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(transient_pda, false),
                AccountMeta::new_readonly(Pubkey::new_unique(), false), // extraneous
            ],
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::ExtraneousAccount as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_expired_quote_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Use a very small timestamp that the clock has already passed.
        let issued_at = encode_u48(1);
        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            vec![],
            vec![],
            issued_at,
        );

        let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::QuoteExpired as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_zero_fee_params_transient_quote() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Zero fee params (max_fee=0, half_amount=0).
        let issued_at = encode_u48(9999999999);
        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            vec![0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // context
            vec![0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // data (zero fees)
            issued_at,
        );

        let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_double_submit_same_salt_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let issued_at = encode_u48(9999999999);
        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            vec![1, 2],
            vec![3, 4],
            issued_at,
        );

        // First submission succeeds.
        let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Second submission with same quote (same salt → same PDA) should fail.
        // Use a different payer for the second tx to avoid transaction deduplication.
        // The quote is still signed for `payer`, so we pass `payer` as extra signer.
        let payer2 = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &payer2).await;

        let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        let result = process_tx(&mut banks_client, &payer2, ix, &[&payer]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::AccountAlreadyInitialized),
        );
    }
}

mod quote_fee_transient {
    use super::*;

    /// Encodes a u48 BE timestamp from an i64.
    fn encode_u48(ts: i64) -> [u8; 6] {
        let bytes = ts.to_be_bytes();
        let mut out = [0u8; 6];
        out.copy_from_slice(&bytes[2..8]);
        out
    }

    /// Encodes a FeeQuoteContext (non-CC) into raw bytes (44 bytes).
    fn encode_context(dest: u32, recipient: H256, amount: u64) -> Vec<u8> {
        let mut buf = Vec::with_capacity(44);
        buf.extend_from_slice(&dest.to_le_bytes());
        buf.extend_from_slice(recipient.as_bytes());
        buf.extend_from_slice(&amount.to_le_bytes());
        buf
    }

    /// Encodes a CcFeeQuoteContext into raw bytes (76 bytes).
    fn encode_cc_context(dest: u32, recipient: H256, amount: u64, target_router: H256) -> Vec<u8> {
        let mut buf = Vec::with_capacity(76);
        buf.extend_from_slice(&dest.to_le_bytes());
        buf.extend_from_slice(recipient.as_bytes());
        buf.extend_from_slice(&amount.to_le_bytes());
        buf.extend_from_slice(target_router.as_bytes());
        buf
    }

    /// Encodes FeeQuoteData into raw bytes.
    fn encode_data(max_fee: u64, half_amount: u64) -> Vec<u8> {
        let mut buf = Vec::with_capacity(16);
        buf.extend_from_slice(&max_fee.to_le_bytes());
        buf.extend_from_slice(&half_amount.to_le_bytes());
        buf
    }

    fn build_submit_transient_ix(
        fee_account: &Pubkey,
        payer: &Pubkey,
        quote: &SvmSignedQuote,
    ) -> Instruction {
        let scoped_salt = quote.compute_scoped_salt(payer);
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_account, scoped_salt),
            &fee_program_id(),
        );
        Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SubmitQuote(quote.clone()),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(*payer, true),
                AccountMeta::new_readonly(*fee_account, false),
                AccountMeta::new(transient_pda, false),
            ],
        )
    }

    fn build_quote_fee_with_transient_ix(
        fee_account: &Pubkey,
        payer: &Pubkey,
        transient_pda: &Pubkey,
        dest: u32,
        recipient: H256,
        amount: u64,
    ) -> Instruction {
        let domain_quotes_pda = standing_quote_pda_for(fee_account, dest);
        let wildcard_quotes_pda = standing_quote_pda_for(fee_account, WILDCARD_DOMAIN);

        Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient,
                amount,
                target_router: H256::zero(),
            }),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(*fee_account, false),
                AccountMeta::new(*payer, true),
                AccountMeta::new(*transient_pda, false), // transient PDA (writable for autoclose)
                AccountMeta::new_readonly(domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
            ],
        )
    }

    #[tokio::test]
    async fn test_transient_quote_consumed_and_autoclosed() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        // Init fee account with Linear curve, on-chain params max_fee=100, half_amount=50.
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Leaf(FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            })),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit a transient quote with DIFFERENT params: max_fee=2000, half_amount=1000.
        let dest = 42u32;
        let recipient = H256::zero();
        let amount = 1000u64;
        let context = encode_context(dest, recipient, amount);
        let data = encode_data(2000, 1000);
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        // Derive transient PDA address.
        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        // QuoteFee with the transient PDA.
        let quote_ix = build_quote_fee_with_transient_ix(
            &fee_key,
            &payer.pubkey(),
            &transient_pda,
            dest,
            recipient,
            amount,
        );
        process_tx(&mut banks_client, &payer, quote_ix, &[])
            .await
            .unwrap();

        // Verify transient PDA was autoclosed.
        let account = banks_client.get_account(transient_pda).await.unwrap();
        assert!(
            account.is_none() || account.unwrap().data.is_empty(),
            "Transient PDA should be closed after consumption"
        );
    }

    #[tokio::test]
    async fn test_context_mismatch_different_amount() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit transient quote for amount=500.
        let dest = 42u32;
        let recipient = H256::zero();
        let context = encode_context(dest, recipient, 500);
        let data = encode_data(1000, 500);
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        // QuoteFee with DIFFERENT amount (999 instead of 500).
        let quote_ix = build_quote_fee_with_transient_ix(
            &fee_key,
            &payer.pubkey(),
            &transient_pda,
            dest,
            recipient,
            999, // mismatch
        );
        let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::TransientContextMismatch as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_context_mismatch_different_destination() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let context = encode_context(42, H256::zero(), 500);
        let data = encode_data(1000, 500);
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        // QuoteFee with different destination (99 instead of 42).
        let quote_ix = build_quote_fee_with_transient_ix(
            &fee_key,
            &payer.pubkey(),
            &transient_pda,
            99,
            H256::zero(),
            500,
        );
        let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::TransientContextMismatch as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_context_mismatch_different_recipient() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let context = encode_context(42, H256::zero(), 500);
        let data = encode_data(1000, 500);
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        // QuoteFee with different recipient.
        let quote_ix = build_quote_fee_with_transient_ix(
            &fee_key,
            &payer.pubkey(),
            &transient_pda,
            42,
            H256::random(), // different recipient
            500,
        );
        let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::TransientContextMismatch as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_zero_fee_params_consumed() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Leaf(FeeDataStrategy::Linear(FeeParams {
                max_fee: 1000,
                half_amount: 500,
            })),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit transient with zero fee params (max_fee=0, half_amount=0).
        let dest = 42u32;
        let recipient = H256::zero();
        let amount = 1000u64;
        let context = encode_context(dest, recipient, amount);
        let data = encode_data(0, 0); // zero fee
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        // QuoteFee should succeed (fee = 0 from zero params, not from on-chain 1000/500).
        let quote_ix = build_quote_fee_with_transient_ix(
            &fee_key,
            &payer.pubkey(),
            &transient_pda,
            dest,
            recipient,
            amount,
        );
        process_tx(&mut banks_client, &payer, quote_ix, &[])
            .await
            .unwrap();

        // Verify autoclosed.
        let account = banks_client.get_account(transient_pda).await.unwrap();
        assert!(account.is_none() || account.unwrap().data.is_empty());
    }

    #[tokio::test]
    async fn test_transient_on_routing_account_works() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::Routing,
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Configure route for domain 42.
        let route_strategy = FeeDataStrategy::Regressive(FeeParams {
            max_fee: 100,
            half_amount: 50,
        });
        let ix = build_set_route_ix(&fee_key, &payer.pubkey(), 42, route_strategy);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let dest = 42u32;
        let recipient = H256::zero();
        let amount = 100u64;
        let context = encode_context(dest, recipient, amount);
        let data = encode_data(2000, 1000); // override params
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        // QuoteFee with transient + route PDA. Transient should be consumed.
        let domain_quotes_pda = standing_quote_pda_for(&fee_key, dest);
        let wildcard_quotes_pda = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);
        let route_pda = route_pda_for(&fee_key, dest);

        let quote_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient,
                amount,
                target_router: H256::zero(),
            }),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(transient_pda, false),
                AccountMeta::new_readonly(domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
                AccountMeta::new_readonly(route_pda, false),
            ],
        );
        process_tx(&mut banks_client, &payer, quote_ix, &[])
            .await
            .unwrap();

        // Verify transient PDA was autoclosed.
        let account = banks_client.get_account(transient_pda).await.unwrap();
        assert!(account.is_none() || account.unwrap().data.is_empty());
    }

    #[tokio::test]
    async fn test_transient_on_cc_account_works() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let dest = 42u32;
        let recipient = H256::zero();
        let amount = 500u64;
        let target_router = H256::random();

        // Configure CC route.
        let route_strategy = FeeDataStrategy::Progressive(FeeParams {
            max_fee: 100,
            half_amount: 50,
        });
        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            target_router,
            route_strategy,
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit transient with CC context (76 bytes).
        let context = encode_cc_context(dest, recipient, amount, target_router);
        let data = encode_data(3000, 1500);
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        // QuoteFee with CC accounts + transient.
        let ix = build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            recipient,
            amount,
            target_router,
            false,
        );
        // Rebuild with transient PDA inserted before standing PDAs.
        let domain_quotes_pda = standing_quote_pda_for(&fee_key, dest);
        let wildcard_quotes_pda = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);
        let cc_specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);

        let quote_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient,
                amount,
                target_router,
            }),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(transient_pda, false),
                AccountMeta::new_readonly(domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
                AccountMeta::new_readonly(cc_specific_pda, false),
            ],
        );
        process_tx(&mut banks_client, &payer, quote_ix, &[])
            .await
            .unwrap();

        // Verify autoclosed.
        let account = banks_client.get_account(transient_pda).await.unwrap();
        assert!(account.is_none() || account.unwrap().data.is_empty());
    }

    #[tokio::test]
    async fn test_cc_context_wrong_target_router_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            FeeData::CrossCollateralRouting,
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let dest = 42u32;
        let target_router = H256::random();
        let wrong_router = H256::random();

        let route_strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 100,
            half_amount: 50,
        });
        let ix = build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            target_router,
            route_strategy,
        );
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit transient with wrong target_router in context.
        let context = encode_cc_context(dest, H256::zero(), 100, wrong_router);
        let data = encode_data(1000, 500);
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        // QuoteFee with correct target_router but quote has wrong_router → mismatch.
        let domain_quotes_pda = standing_quote_pda_for(&fee_key, dest);
        let wildcard_quotes_pda = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);
        let cc_specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);

        let quote_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient: H256::zero(),
                amount: 100,
                target_router, // correct router in instruction
            }),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(transient_pda, false),
                AccountMeta::new_readonly(domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
                AccountMeta::new_readonly(cc_specific_pda, false),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::TransientContextMismatch as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_payer_mismatch_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            Some(payer.pubkey()),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let dest = 42u32;
        let recipient = H256::zero();
        let amount = 100u64;
        let context = encode_context(dest, recipient, amount);
        let data = encode_data(1000, 500);
        let issued_at = encode_u48(9999999999);

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(), // signed for payer
            context,
            data,
            issued_at,
        );

        let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        // Different payer tries to consume the transient quote.
        let other_payer = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &other_payer).await;

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        let domain_quotes_pda = standing_quote_pda_for(&fee_key, dest);
        let wildcard_quotes_pda = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);

        let quote_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient,
                amount,
                target_router: H256::zero(),
            }),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(other_payer.pubkey(), true), // different payer
                AccountMeta::new(transient_pda, false),
                AccountMeta::new_readonly(domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
            ],
        );
        let result = process_tx(&mut banks_client, &other_payer, quote_ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::TransientPayerMismatch as u32),
            ),
        );
    }
}
