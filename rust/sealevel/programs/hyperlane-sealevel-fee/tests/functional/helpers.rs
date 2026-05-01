use crate::*;
use hyperlane_sealevel_fee::accounts::{DEFAULT_ROUTER, WILDCARD_DOMAIN};
use serializable_account_meta::SerializableAccountMeta;

async fn simulate_get_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    fee_account: &Pubkey,
    destination_domain: u32,
    target_router: H256,
    scoped_salt: Option<H256>,
) -> Vec<SerializableAccountMeta> {
    let instruction = Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::GetQuoteAccountMetas(
            hyperlane_sealevel_fee::instruction::GetQuoteAccountMetas {
                destination_domain,
                target_router,
                scoped_salt,
            },
        ),
        vec![AccountMeta::new_readonly(*fee_account, false)],
    );
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
    let result: SimulationReturnData<Vec<SerializableAccountMeta>> =
        borsh::from_slice(&return_data.data).expect("failed to deserialize");
    result.return_data
}

#[tokio::test]
async fn test_leaf_no_transient() {
    let (mut banks_client, payer) = setup_client().await;
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let dest = 42u32;
    let metas = simulate_get_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        dest,
        H256::zero(),
        None,
    )
    .await;

    // prefix (2) + domain_quotes + wildcard_quotes = 4
    assert_eq!(metas.len(), 4);

    // Fixed prefix.
    assert_eq!(metas[0].pubkey, fee_key);
    assert!(metas[1].is_signer);
    assert!(metas[1].is_writable);

    let expected_domain = standing_quote_pda_for(&fee_key, dest);
    let expected_wildcard = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);

    assert_eq!(metas[2].pubkey, expected_domain);
    assert!(!metas[2].is_writable);

    assert_eq!(metas[3].pubkey, expected_wildcard);
    assert!(!metas[3].is_writable);
}

#[tokio::test]
async fn test_leaf_with_transient() {
    let (mut banks_client, payer) = setup_client().await;
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let dest = 42u32;
    let scoped_salt = H256::random();

    let (expected_transient, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );

    let metas = simulate_get_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        dest,
        H256::zero(),
        Some(scoped_salt),
    )
    .await;

    // prefix (2) + transient + domain_quotes + wildcard_quotes = 5
    assert_eq!(metas.len(), 5);

    assert_eq!(metas[2].pubkey, expected_transient);
    assert!(metas[2].is_writable);
    assert!(!metas[2].is_signer);

    assert_eq!(metas[3].pubkey, standing_quote_pda_for(&fee_key, dest));
    assert_eq!(
        metas[4].pubkey,
        standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN)
    );
}

#[tokio::test]
async fn test_routing() {
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

    let dest = 42u32;
    let metas = simulate_get_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        dest,
        H256::zero(),
        None,
    )
    .await;

    // prefix (2) + domain_quotes + wildcard_quotes + route_pda = 5
    assert_eq!(metas.len(), 5);

    assert_eq!(metas[2].pubkey, standing_quote_pda_for(&fee_key, dest));
    assert_eq!(
        metas[3].pubkey,
        standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN)
    );
    assert_eq!(metas[4].pubkey, route_pda_for(&fee_key, dest));
    assert!(!metas[4].is_writable);
}

#[tokio::test]
async fn test_cc_routing() {
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
    let metas = simulate_get_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        dest,
        target_router,
        None,
    )
    .await;

    // prefix (2) + domain_quotes + wildcard_quotes + cc_specific + cc_default = 6
    assert_eq!(metas.len(), 6);

    assert_eq!(
        metas[2].pubkey,
        cc_standing_quote_pda_for(&fee_key, dest, &target_router)
    );
    assert_eq!(
        metas[3].pubkey,
        cc_standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN, &target_router)
    );
    assert_eq!(
        metas[4].pubkey,
        cc_route_pda_for(&fee_key, dest, &target_router)
    );
    assert_eq!(
        metas[5].pubkey,
        cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER)
    );
}

#[tokio::test]
async fn test_cc_routing_with_transient() {
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
    let scoped_salt = H256::random();

    let (expected_transient, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );

    let metas = simulate_get_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        dest,
        target_router,
        Some(scoped_salt),
    )
    .await;

    // prefix (2) + transient + domain_quotes + wildcard_quotes + cc_specific + cc_default = 7
    assert_eq!(metas.len(), 7);

    assert_eq!(metas[2].pubkey, expected_transient);
    assert!(metas[2].is_writable);
    assert_eq!(
        metas[3].pubkey,
        cc_standing_quote_pda_for(&fee_key, dest, &target_router)
    );
    assert_eq!(
        metas[4].pubkey,
        cc_standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN, &target_router)
    );
    assert_eq!(
        metas[5].pubkey,
        cc_route_pda_for(&fee_key, dest, &target_router)
    );
    assert_eq!(
        metas[6].pubkey,
        cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER)
    );
}

/// GetQuoteAccountMetas with scoped_salt=Some(...) returns a transient PDA meta.
/// This is only valid when SubmitQuote runs in the same tx before QuoteFee.
#[tokio::test]
async fn test_get_quote_account_metas_scoped_salt_same_tx_expectation() {
    let (mut banks_client, payer) = setup_client().await;

    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let scoped_salt = H256::random();
    let metas = simulate_get_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        42,
        H256::zero(),
        Some(scoped_salt),
    )
    .await;

    let (expected_transient, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );
    assert_eq!(metas[2].pubkey, expected_transient);
    assert!(metas[2].is_writable);
}

async fn simulate_get_submit_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    fee_account: &Pubkey,
    destination_domain: u32,
    target_router: H256,
    scoped_salt: Option<H256>,
) -> Vec<SerializableAccountMeta> {
    let instruction = Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::GetSubmitQuoteAccountMetas(
            hyperlane_sealevel_fee::instruction::GetSubmitQuoteAccountMetas {
                destination_domain,
                target_router,
                scoped_salt,
            },
        ),
        vec![AccountMeta::new_readonly(*fee_account, false)],
    );
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
    let result: SimulationReturnData<Vec<SerializableAccountMeta>> =
        borsh::from_slice(&return_data.data).expect("failed to deserialize");
    result.return_data
}

#[tokio::test]
async fn test_leaf_transient() {
    let (mut banks_client, payer) = setup_client().await;
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let scoped_salt = H256::random();
    let metas = simulate_get_submit_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        42,
        H256::zero(),
        Some(scoped_salt),
    )
    .await;

    // system + payer + fee_account + transient_pda = 4
    assert_eq!(metas.len(), 4);
    assert_eq!(metas[0].pubkey, system_program::ID);
    assert!(metas[1].is_signer); // payer
    assert!(!metas[2].is_writable); // fee_account read-only for transient
    assert!(metas[3].is_writable); // transient PDA
}

#[tokio::test]
async fn test_leaf_standing() {
    let (mut banks_client, payer) = setup_client().await;
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let metas =
        simulate_get_submit_metas(&mut banks_client, &payer, &fee_key, 42, H256::zero(), None)
            .await;

    // system + payer + fee_account(R) + standing_pda = 4
    assert_eq!(metas.len(), 4);
    assert!(!metas[2].is_writable); // fee_account read-only for standing
    assert!(metas[3].is_writable); // standing PDA
}

#[tokio::test]
async fn test_routing_transient() {
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

    let dest = 42u32;
    let ix = build_set_route_ix(
        &fee_key,
        &payer.pubkey(),
        dest,
        FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let scoped_salt = H256::random();
    let metas = simulate_get_submit_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        dest,
        H256::zero(),
        Some(scoped_salt),
    )
    .await;

    // system + payer + fee_account + route_domain_pda + transient_pda = 5
    assert_eq!(metas.len(), 5);
    assert_eq!(metas[3].pubkey, route_pda_for(&fee_key, dest));
    assert!(!metas[3].is_writable); // route PDA read-only
    assert!(metas[4].is_writable); // transient PDA
}

#[tokio::test]
async fn test_cc_standing() {
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

    let metas = simulate_get_submit_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        dest,
        target_router,
        None,
    )
    .await;

    // system + payer + fee_account(R) + cc_specific + cc_default + standing_pda = 6
    assert_eq!(metas.len(), 6);
    assert_eq!(
        metas[3].pubkey,
        cc_route_pda_for(&fee_key, dest, &target_router)
    );
    assert_eq!(
        metas[4].pubkey,
        cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER)
    );
    assert!(metas[5].is_writable); // standing PDA
}
mod get_program_version {
    use super::*;

    #[tokio::test]
    async fn test_returns_version() {
        let (banks_client, payer) = setup_client().await;

        let instruction = Instruction::new_with_bytes(
            fee_program_id(),
            &package_versioned::get_program_version_instruction_data(),
            vec![],
        );
        let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
        let simulation = banks_client
            .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
                &[instruction],
                Some(&payer.pubkey()),
                &recent_blockhash,
            )))
            .await
            .unwrap();

        assert!(simulation.result.unwrap().is_ok());
        let return_data = simulation
            .simulation_details
            .unwrap()
            .return_data
            .expect("no return data");
        let result: SimulationReturnData<String> =
            borsh::from_slice(&return_data.data).expect("failed to deserialize");
        assert_eq!(result.return_data, package_versioned::PACKAGE_VERSION);
    }
}

#[tokio::test]
async fn test_get_quote_metas_with_wildcard_domain() {
    let (mut banks_client, payer) = setup_client().await;
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let metas = simulate_get_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        WILDCARD_DOMAIN,
        H256::zero(),
        None,
    )
    .await;

    // prefix (2) + domain_quotes + wildcard_quotes = 4
    // When dest == WILDCARD_DOMAIN, both PDAs use WILDCARD_DOMAIN in seeds.
    assert_eq!(metas.len(), 4);

    let expected_wildcard = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);
    assert_eq!(metas[2].pubkey, expected_wildcard);
    assert_eq!(metas[3].pubkey, expected_wildcard);
}

#[tokio::test]
async fn test_get_submit_metas_with_wildcard_domain() {
    let (mut banks_client, payer) = setup_client().await;
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let metas = simulate_get_submit_metas(
        &mut banks_client,
        &payer,
        &fee_key,
        WILDCARD_DOMAIN,
        H256::zero(),
        None,
    )
    .await;

    // Standing submit: system_program + fee_account + payer + standing_pda = 4
    assert!(metas.len() >= 4);
    let standing_pda = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);
    assert_eq!(metas[3].pubkey, standing_pda);
}
