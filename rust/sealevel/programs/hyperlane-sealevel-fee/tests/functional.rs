//! Functional tests for the hyperlane-sealevel-fee program.

use std::collections::BTreeSet;

use hyperlane_core::H256;
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
        RouteDomain, RouteDomainAccount,
    },
    cc_route_pda_seeds,
    error::Error as FeeError,
    fee_account_pda_seeds,
    fee_math::{FeeDataStrategy, FeeParams},
    instruction::Instruction as FeeInstruction,
    processor::process_instruction as fee_process_instruction,
    route_domain_pda_seeds,
};

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
