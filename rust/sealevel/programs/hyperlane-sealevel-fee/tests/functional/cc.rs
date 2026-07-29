use crate::*;

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
async fn test_cc_standing_creates_route_bound_pda() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

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
    let recipient = H256::zero();

    // Set up CC route so the route PDA exists for signer lookup.
    let ix = build_set_cc_route_ix(
        &fee_key,
        &payer.pubkey(),
        dest,
        target_router,
        FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Add signer to CC route PDA (must exist first).
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let context = encode_cc_standing_context(dest, recipient, target_router);
    let data = encode_linear_data(2000, 1000);
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

    let specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &quote,
        dest,
        &target_router,
        &[specific_pda],
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Verify PDA is at the CC-specific address.
    let cc_pda = cc_standing_quote_pda_for(&fee_key, dest, &target_router);
    let standing = fetch_standing_pda(&mut banks_client, cc_pda).await;
    assert_eq!(standing.quotes.len(), 1);
    assert_eq!(
        standing
            .quotes
            .get(&recipient)
            .unwrap()
            .fee_data
            .params()
            .max_fee,
        2000
    );
}

#[tokio::test]
async fn test_two_routers_get_separate_pdas() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

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
    let recipient = H256::zero();
    let router_a = H256::random();
    let router_b = H256::random();

    // Set up CC routes for both routers.
    let route_strategy = FeeDataStrategy::Linear(FeeParams {
        max_fee: 1000,
        half_amount: 500,
    });
    let ix = build_set_cc_route_ix(
        &fee_key,
        &payer.pubkey(),
        dest,
        router_a,
        route_strategy.clone(),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router_b, route_strategy);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Add signer to both CC route PDAs.
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: router_a,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: router_b,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Submit standing for router_a: max_fee=1000.
    let ctx_a = encode_cc_standing_context(dest, recipient, router_a);
    let q_a = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        ctx_a,
        encode_linear_data(1000, 500),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let specific_pda_a = cc_route_pda_for(&fee_key, dest, &router_a);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &q_a,
        dest,
        &router_a,
        &[specific_pda_a],
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Submit standing for router_b: max_fee=5000.
    let ctx_b = encode_cc_standing_context(dest, recipient, router_b);
    let q_b = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        ctx_b,
        encode_linear_data(5000, 2500),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let specific_pda_b = cc_route_pda_for(&fee_key, dest, &router_b);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &q_b,
        dest,
        &router_b,
        &[specific_pda_b],
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Verify separate PDAs with separate values.
    let pda_a = cc_standing_quote_pda_for(&fee_key, dest, &router_a);
    let pda_b = cc_standing_quote_pda_for(&fee_key, dest, &router_b);
    assert_ne!(pda_a, pda_b);

    let standing_a = fetch_standing_pda(&mut banks_client, pda_a).await;
    let standing_b = fetch_standing_pda(&mut banks_client, pda_b).await;
    assert_eq!(
        standing_a
            .quotes
            .get(&recipient)
            .unwrap()
            .fee_data
            .params()
            .max_fee,
        1000
    );
    assert_eq!(
        standing_b
            .quotes
            .get(&recipient)
            .unwrap()
            .fee_data
            .params()
            .max_fee,
        5000
    );
}

#[tokio::test]
async fn test_cc_standing_zero_target_router_rejected() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

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

    // Set up a DEFAULT_ROUTER CC route so signer resolution succeeds via fallback.
    let ix = build_set_cc_route_ix(
        &fee_key,
        &payer.pubkey(),
        42,
        DEFAULT_ROUTER,
        FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: 42,
            target_router: DEFAULT_ROUTER,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Submit with target_router = H256::zero() → should be rejected.
    let context = encode_cc_standing_context(42, H256::zero(), H256::zero());
    let data = encode_linear_data(1000, 500);
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

    let specific_pda = cc_route_pda_for(&fee_key, 42, &H256::zero());
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &quote,
        42,
        &H256::zero(),
        &[specific_pda],
    );
    let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(FeeError::ZeroTargetRouterNotAllowed as u32),
        ),
    );
}

#[tokio::test]
async fn test_cc_submit_spoofed_specific_route_pda_rejected() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);
    let dest = 42u32;
    let target_router = H256::random();
    let recipient = H256::random();

    let fee_key_a = init_fee_account(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        }),
    )
    .await;
    let fee_key_b = init_fee_account(
        &mut banks_client,
        &payer,
        H256::repeat_byte(1),
        payer.pubkey(),
        FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        }),
    )
    .await;

    let strategy = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    process_tx(
        &mut banks_client,
        &payer,
        build_set_cc_route_ix(
            &fee_key_a,
            &payer.pubkey(),
            dest,
            target_router,
            strategy.clone(),
        ),
        &[],
    )
    .await
    .unwrap();
    process_tx(
        &mut banks_client,
        &payer,
        build_set_cc_route_ix(&fee_key_b, &payer.pubkey(), dest, target_router, strategy),
        &[],
    )
    .await
    .unwrap();
    process_tx(
        &mut banks_client,
        &payer,
        build_add_quote_signer_ix_with_route(
            &fee_key_a,
            &payer.pubkey(),
            signer_address,
            Some(instruction::RouteKey::CrossCollateral {
                destination: dest,
                target_router,
            }),
        ),
        &[],
    )
    .await
    .unwrap();

    let quote = make_signed_standing_quote(
        &signing_key,
        &fee_key_a,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, recipient, target_router),
        encode_linear_data(777, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let result = process_tx(
        &mut banks_client,
        &payer,
        build_submit_standing_ix_with_routes(
            &fee_key_a,
            &payer.pubkey(),
            &quote,
            dest,
            &target_router,
            &[cc_route_pda_for(&fee_key_b, dest, &target_router)],
        ),
        &[],
    )
    .await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_cc_exact_does_not_fallback_to_default_when_specific_exists_without_signers() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);
    let dest = 42u32;
    let target_router = H256::random();

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

    let strategy = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    process_tx(
        &mut banks_client,
        &payer,
        build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            target_router,
            strategy.clone(),
        ),
        &[],
    )
    .await
    .unwrap();
    process_tx(
        &mut banks_client,
        &payer,
        build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, DEFAULT_ROUTER, strategy),
        &[],
    )
    .await
    .unwrap();
    process_tx(
        &mut banks_client,
        &payer,
        build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            signer_address,
            Some(instruction::RouteKey::CrossCollateral {
                destination: dest,
                target_router: DEFAULT_ROUTER,
            }),
        ),
        &[],
    )
    .await
    .unwrap();

    let quote = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, H256::random(), target_router),
        encode_linear_data(777, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let result = process_tx(
        &mut banks_client,
        &payer,
        build_submit_standing_ix_with_routes(
            &fee_key,
            &payer.pubkey(),
            &quote,
            dest,
            &target_router,
            &[cc_route_pda_for(&fee_key, dest, &target_router)],
        ),
        &[],
    )
    .await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(FeeError::OffchainQuotingNotConfigured as u32),
        ),
    );
}

#[tokio::test]
async fn test_cc_default_authorized_standing_quote_invalidated_by_later_specific_route() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);
    let dest = 42u32;
    let recipient = H256::random();
    let target_router = H256::random();

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

    let linear_strategy = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    process_tx(
        &mut banks_client,
        &payer,
        build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            DEFAULT_ROUTER,
            linear_strategy,
        ),
        &[],
    )
    .await
    .unwrap();
    process_tx(
        &mut banks_client,
        &payer,
        build_add_quote_signer_ix_with_route(
            &fee_key,
            &payer.pubkey(),
            signer_address,
            Some(instruction::RouteKey::CrossCollateral {
                destination: dest,
                target_router: DEFAULT_ROUTER,
            }),
        ),
        &[],
    )
    .await
    .unwrap();

    let quote = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, recipient, DEFAULT_ROUTER),
        encode_linear_data(777, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    process_tx(
        &mut banks_client,
        &payer,
        build_submit_standing_ix_with_routes(
            &fee_key,
            &payer.pubkey(),
            &quote,
            dest,
            &DEFAULT_ROUTER,
            &[cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER)],
        ),
        &[],
    )
    .await
    .unwrap();

    let fee_before = simulate_quote_fee(
        &mut banks_client,
        &payer,
        build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            recipient,
            100,
            target_router,
        ),
    )
    .await;
    assert_eq!(fee_before, 777);

    process_tx(
        &mut banks_client,
        &payer,
        build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            target_router,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        ),
        &[],
    )
    .await
    .unwrap();

    let fee_after = simulate_quote_fee(
        &mut banks_client,
        &payer,
        build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            recipient,
            100,
            target_router,
        ),
    )
    .await;
    assert_eq!(fee_after, 100);
}

/// When both the specific-scope and default-scope domain standing PDAs hold
/// quotes, the consume cascade must consult the specific-scope PDA (because a
/// specific route is active) and ignore the default-scope quote.
#[tokio::test]
async fn test_cc_specific_scope_quote_shadows_default_scope_quote() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);
    let dest = 42u32;
    let recipient = H256::random();
    let target_router = H256::random();

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

    // Configure both routes with the same on-chain curve (irrelevant — we
    // assert the standing quote is served).
    let on_chain = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    for router in [DEFAULT_ROUTER, target_router] {
        process_tx(
            &mut banks_client,
            &payer,
            build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router, on_chain.clone()),
            &[],
        )
        .await
        .unwrap();
        process_tx(
            &mut banks_client,
            &payer,
            build_add_quote_signer_ix_with_route(
                &fee_key,
                &payer.pubkey(),
                signer_address,
                Some(instruction::RouteKey::CrossCollateral {
                    destination: dest,
                    target_router: router,
                }),
            ),
            &[],
        )
        .await
        .unwrap();
    }

    // Submit a default-scope standing quote (max_fee=777).
    let default_quote = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, recipient, DEFAULT_ROUTER),
        encode_linear_data(777, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    process_tx(
        &mut banks_client,
        &payer,
        build_submit_standing_ix_with_routes(
            &fee_key,
            &payer.pubkey(),
            &default_quote,
            dest,
            &DEFAULT_ROUTER,
            &[cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER)],
        ),
        &[],
    )
    .await
    .unwrap();

    // Submit a specific-scope standing quote (max_fee=333).
    let specific_quote = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, recipient, target_router),
        encode_linear_data(333, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    process_tx(
        &mut banks_client,
        &payer,
        build_submit_standing_ix_with_routes(
            &fee_key,
            &payer.pubkey(),
            &specific_quote,
            dest,
            &target_router,
            &[cc_route_pda_for(&fee_key, dest, &target_router)],
        ),
        &[],
    )
    .await
    .unwrap();

    // Both PDAs hold quotes. Specific route is active → specific wins.
    let fee = simulate_quote_fee(
        &mut banks_client,
        &payer,
        build_quote_fee_cc_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            recipient,
            100,
            target_router,
        ),
    )
    .await;
    assert_eq!(
        fee, 333,
        "specific scope quote must shadow default scope quote"
    );
}

#[tokio::test]
async fn test_cc_wildcard_submit_with_extra_route_pda_rejected() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);
    let dest = 42u32;
    let target_router = H256::random();

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

    process_tx(
        &mut banks_client,
        &payer,
        build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            target_router,
            FeeDataStrategy::Linear(FeeParams {
                max_fee: 100,
                half_amount: 50,
            }),
        ),
        &[],
    )
    .await
    .unwrap();

    let mut wildcard_signers = BTreeSet::new();
    wildcard_signers.insert(signer_address);
    process_tx(
        &mut banks_client,
        &payer,
        build_set_wildcard_signers_ix(&fee_key, &payer.pubkey(), wildcard_signers),
        &[],
    )
    .await
    .unwrap();

    let quote = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(WILDCARD_DOMAIN, H256::random(), target_router),
        encode_linear_data(777, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let result = process_tx(
        &mut banks_client,
        &payer,
        build_submit_standing_ix_with_routes(
            &fee_key,
            &payer.pubkey(),
            &quote,
            WILDCARD_DOMAIN,
            &target_router,
            &[cc_route_pda_for(&fee_key, dest, &target_router)],
        ),
        &[],
    )
    .await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_cc_prune_does_not_remove_domain_from_tracking() {
    let program_id = fee_program_id();
    let program_test = ProgramTest::new(
        "hyperlane_sealevel_fee",
        program_id,
        processor!(fee_process_instruction),
    );
    let mut ctx = program_test.start_with_context().await;
    let payer = ctx.payer.insecure_clone();
    let banks_client = &mut ctx.banks_client;

    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

    let fee_key = init_fee_account(
        banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        }),
    )
    .await;

    // Set up a CC route so QuoteFee can resolve the curve.
    let dest = 42u32;
    let router_a = H256::random();
    let router_b = H256::random();
    let route_strategy = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });

    let ix = build_set_cc_route_ix(
        &fee_key,
        &payer.pubkey(),
        dest,
        router_a,
        route_strategy.clone(),
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router_b, route_strategy);
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Add signer to both CC route PDAs.
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: router_a,
        }),
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: router_b,
        }),
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Submit standing quotes for two different routers on the same domain.
    let ctx_a = encode_cc_standing_context(dest, H256::zero(), router_a);
    let q_a = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        ctx_a,
        encode_linear_data(1000, 500),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let specific_pda_a = cc_route_pda_for(&fee_key, dest, &router_a);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &q_a,
        dest,
        &router_a,
        &[specific_pda_a],
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    let ctx_b = encode_cc_standing_context(dest, H256::zero(), router_b);
    let q_b = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        ctx_b,
        encode_linear_data(2000, 1000),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let specific_pda_b = cc_route_pda_for(&fee_key, dest, &router_b);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &q_b,
        dest,
        &router_b,
        &[specific_pda_b],
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Warp clock past expiry — both quotes have expiry=9999999999.
    let mut clock = banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = 99999999999;
    ctx.set_sysvar(&clock);
    let banks_client = &mut ctx.banks_client;

    // Prune router_a's standing PDA — it should close.
    let domain_le = dest.to_le_bytes();
    let (pda_a, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_key, &domain_le, router_a),
        &fee_program_id(),
    );
    let ix = Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::PruneExpiredQuotes {
            domain: dest,
            target_router: Some(router_a),
        },
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(fee_key, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(pda_a, false),
        ],
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Router_a's PDA should be closed.
    let account = banks_client.get_account(pda_a).await.unwrap();
    assert!(account.is_none() || account.unwrap().data.is_empty());

    // Pruning router_a must not affect router_b's standing PDA on the same domain.
    let (pda_b, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_key, &domain_le, router_b),
        &fee_program_id(),
    );
    let account_b = banks_client.get_account(pda_b).await.unwrap();
    assert!(
        account_b.is_some(),
        "router_b standing PDA was unexpectedly closed"
    );
    let account_b = account_b.unwrap();
    assert_eq!(account_b.owner, fee_program_id());
    assert!(!account_b.data.is_empty());

    // The domain itself must remain usable: a fresh standing quote on
    // (dest, router_a) can still be submitted after pruning router_a.
    let q_a_fresh = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, H256::zero(), router_a),
        encode_linear_data(1500, 750),
        encode_u48(99999999999),
        encode_u48(99999999999 + 1000),
    );
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &q_a_fresh,
        dest,
        &router_a,
        &[specific_pda_a],
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // The new PDA should now be initialized.
    let pda_a_after = banks_client.get_account(pda_a).await.unwrap();
    assert!(
        pda_a_after.is_some(),
        "fresh standing PDA for router_a was not created"
    );
    let pda_a_after = pda_a_after.unwrap();
    assert_eq!(pda_a_after.owner, fee_program_id());
    assert!(!pda_a_after.data.is_empty());
}

#[tokio::test]
async fn test_cc_standing_quote_consumed_in_quote_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

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
    let recipient = H256::random();
    let target_router = H256::random();

    // Configure CC route: Progressive max_fee=100, half_amount=50.
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

    // Add signer to CC route PDA (must exist first).
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Submit CC standing quote: Progressive max_fee=888, half_amount=1.
    let context = encode_cc_standing_context(dest, recipient, target_router);
    let data = encode_data(&FeeDataStrategy::Progressive(FeeParams {
        max_fee: 888,
        half_amount: 1,
    }));
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
    let specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &quote,
        dest,
        &target_router,
        &[specific_pda],
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // QuoteFee with CC standing quote.
    let amount = 200u64;
    let ix = build_quote_fee_cc_ix(
        &fee_key,
        &payer.pubkey(),
        dest,
        recipient,
        amount,
        target_router,
    );
    let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;

    // Standing params: Progressive max_fee=888, half_amount=1, amount=200.
    // 888 * 200^2 / (1^2 + 200^2) = 888 * 40000 / 40001 = 887.
    // On-chain route would give: 100 * 200^2 / (50^2 + 200^2) = 100*40000/42500 = 94.
    // Confirms standing was used.
    assert_eq!(fee, 887);
}

#[tokio::test]
async fn test_cc_quote_fee_uses_router_bound_standing_pda() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

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
    let recipient = H256::random();
    let router_a = H256::random();
    let router_b = H256::random();

    // CC routes for both routers — same curve type, same on-chain params.
    let route = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router_a, route.clone());
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router_b, route);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Add signer to both CC route PDAs.
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: router_a,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: router_b,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Standing for router_a: max_fee=777, half_amount=1.
    let sq_a = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, recipient, router_a),
        encode_linear_data(777, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let specific_pda_a = cc_route_pda_for(&fee_key, dest, &router_a);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &sq_a,
        dest,
        &router_a,
        &[specific_pda_a],
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Standing for router_b: max_fee=333, half_amount=1.
    let sq_b = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, recipient, router_b),
        encode_linear_data(333, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let specific_pda_b = cc_route_pda_for(&fee_key, dest, &router_b);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &sq_b,
        dest,
        &router_b,
        &[specific_pda_b],
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let amount = 100u64;

    // QuoteFee for router_a → should use 777/1: min(777, 100*777/2) = 777.
    let ix = build_quote_fee_cc_ix(&fee_key, &payer.pubkey(), dest, recipient, amount, router_a);
    let fee_a = simulate_quote_fee(&mut banks_client, &payer, ix).await;
    assert_eq!(fee_a, 777);

    // QuoteFee for router_b → should use 333/1: min(333, 100*333/2) = 333.
    let ix = build_quote_fee_cc_ix(&fee_key, &payer.pubkey(), dest, recipient, amount, router_b);
    let fee_b = simulate_quote_fee(&mut banks_client, &payer, ix).await;
    assert_eq!(fee_b, 333);
}

#[tokio::test]
async fn test_cc_quote_fee_wildcard_domain_fallback_is_router_scoped() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

    // Init with wildcard signers so wildcard-domain quotes can be submitted.
    let mut wildcard_signers = BTreeSet::new();
    wildcard_signers.insert(signer_address);
    let fee_key = init_fee_account(
        &mut banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig { wildcard_signers }),
    )
    .await;

    let dest = 42u32;
    let recipient = H256::random();
    let router_a = H256::random();
    let router_b = H256::random();

    // CC routes for both routers: on-chain Linear max_fee=100, half_amount=50.
    let route = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router_a, route.clone());
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router_b, route);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Wildcard-domain standing for router_a ONLY: max_fee=555, half_amount=1.
    // Auth comes from fee_data.wildcard_signers (no route PDAs needed).
    let sq = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(WILDCARD_DOMAIN, recipient, router_a),
        encode_linear_data(555, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &sq,
        WILDCARD_DOMAIN,
        &router_a,
        &[], // No route PDAs — wildcard auth from fee_data
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let amount = 100u64;

    // QuoteFee router_a → wildcard standing: min(555, 100*555/2) = 555.
    let ix = build_quote_fee_cc_ix(&fee_key, &payer.pubkey(), dest, recipient, amount, router_a);
    let fee_a = simulate_quote_fee(&mut banks_client, &payer, ix).await;
    assert_eq!(fee_a, 555);

    // QuoteFee router_b → no standing quote exists, falls to on-chain: min(100, 100*100/100) = 100.
    let ix = build_quote_fee_cc_ix(&fee_key, &payer.pubkey(), dest, recipient, amount, router_b);
    let fee_b = simulate_quote_fee(&mut banks_client, &payer, ix).await;
    assert_eq!(fee_b, 100);
}

#[tokio::test]
async fn test_cc_quote_fee_exact_recipient_beats_wildcard_recipient() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

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
    let exact_recipient = H256::random();
    let other_recipient = H256::random();

    let route = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, target_router, route);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Add signer to CC route PDA (must exist first).
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Submit exact-recipient standing: max_fee=888, half_amount=1.
    let sq_exact = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, exact_recipient, target_router),
        encode_linear_data(888, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &sq_exact,
        dest,
        &target_router,
        &[specific_pda],
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Submit wildcard-recipient standing (same PDA, different key): max_fee=444, half_amount=1.
    let sq_wildcard = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, WILDCARD_RECIPIENT, target_router),
        encode_linear_data(444, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &sq_wildcard,
        dest,
        &target_router,
        &[specific_pda],
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let amount = 100u64;

    // QuoteFee for exact_recipient → exact match: min(888, 100*888/2) = 888.
    let ix = build_quote_fee_cc_ix(
        &fee_key,
        &payer.pubkey(),
        dest,
        exact_recipient,
        amount,
        target_router,
    );
    let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
    assert_eq!(fee, 888);

    // QuoteFee for other_recipient → wildcard match: min(444, 100*444/2) = 444.
    let ix = build_quote_fee_cc_ix(
        &fee_key,
        &payer.pubkey(),
        dest,
        other_recipient,
        amount,
        target_router,
    );
    let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
    assert_eq!(fee, 444);
}

#[tokio::test]
async fn test_cc_prune_one_router_preserves_other_router_quote() {
    let program_id = fee_program_id();
    let program_test = ProgramTest::new(
        "hyperlane_sealevel_fee",
        program_id,
        processor!(fee_process_instruction),
    );
    let mut ctx = program_test.start_with_context().await;
    let payer = ctx.payer.insecure_clone();
    let banks_client = &mut ctx.banks_client;

    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

    let fee_key = init_fee_account(
        banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        }),
    )
    .await;

    let dest = 42u32;
    let recipient = H256::random();
    let router_a = H256::random();
    let router_b = H256::random();

    let route = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router_a, route.clone());
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();
    let ix = build_set_cc_route_ix(&fee_key, &payer.pubkey(), dest, router_b, route);
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Add signer to both CC route PDAs.
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: router_a,
        }),
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: router_b,
        }),
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Router_a standing: expires at 5000000000 (will be expired).
    let sq_a = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, recipient, router_a),
        encode_linear_data(777, 1),
        encode_u48(100),
        encode_u48(5000000000),
    );
    let specific_pda_a = cc_route_pda_for(&fee_key, dest, &router_a);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &sq_a,
        dest,
        &router_a,
        &[specific_pda_a],
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Router_b standing: expires at 9999999999 (will be live).
    let sq_b = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_cc_standing_context(dest, recipient, router_b),
        encode_linear_data(333, 1),
        encode_u48(100),
        encode_u48(9999999999),
    );
    let specific_pda_b = cc_route_pda_for(&fee_key, dest, &router_b);
    let ix = build_submit_standing_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &sq_b,
        dest,
        &router_b,
        &[specific_pda_b],
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Warp clock past router_a's expiry but before router_b's.
    let mut clock = banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = 6000000000;
    ctx.set_sysvar(&clock);
    let banks_client = &mut ctx.banks_client;

    // Prune router_a.
    let pda_a = cc_standing_quote_pda_for(&fee_key, dest, &router_a);
    let ix = Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::PruneExpiredQuotes {
            domain: dest,
            target_router: Some(router_a),
        },
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(fee_key, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(pda_a, false),
        ],
    );
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Router_a PDA closed.
    let account = banks_client.get_account(pda_a).await.unwrap();
    assert!(account.is_none() || account.unwrap().data.is_empty());

    // Router_b PDA still exists.
    let pda_b = cc_standing_quote_pda_for(&fee_key, dest, &router_b);
    let standing_b = fetch_standing_pda(banks_client, pda_b).await;
    assert_eq!(standing_b.quotes.len(), 1);
    assert_eq!(
        standing_b
            .quotes
            .get(&recipient)
            .unwrap()
            .fee_data
            .params()
            .max_fee,
        333
    );

    // QuoteFee for router_b still returns standing fee: min(333, 100*333/2) = 333.
    let ix = build_quote_fee_cc_ix(&fee_key, &payer.pubkey(), dest, recipient, 100, router_b);
    let fee = simulate_quote_fee(banks_client, &payer, ix).await;
    assert_eq!(fee, 333);
}

#[tokio::test]
async fn test_transient_pda_spoof_rejected() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

    let salt_a = H256::zero();
    let salt_b = H256::repeat_byte(0x01);

    // Fee account A.
    let fee_key_a = init_fee_account(
        &mut banks_client,
        &payer,
        salt_a,
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;
    let ix = build_add_quote_signer_ix(&fee_key_a, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Fee account B.
    let fee_key_b = init_fee_account(
        &mut banks_client,
        &payer,
        salt_b,
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;
    let ix = build_add_quote_signer_ix(&fee_key_b, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Create transient quote under fee account B.
    let dest = 42u32;
    let recipient = H256::zero();
    let amount = 100u64;
    let context = encode_context(dest, recipient, amount);
    let data = encode_linear_data(5000, 1);
    let issued_at = encode_u48(100);

    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key_b,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        context,
        data,
        issued_at,
    );
    let ix = build_submit_transient_ix(&fee_key_b, &payer.pubkey(), &quote);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Derive B's transient PDA.
    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda_b, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key_b, scoped_salt),
        &fee_program_id(),
    );

    // Try QuoteFee on fee account A with B's transient PDA → TransientPdaMismatch.
    let domain_quotes_pda = standing_quote_pda_for(&fee_key_a, dest);
    let wildcard_quotes_pda = standing_quote_pda_for(&fee_key_a, WILDCARD_DOMAIN);
    let quote_ix = Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
            destination_domain: dest,
            recipient,
            amount,
            target_router: H256::zero(),
        }),
        vec![
            AccountMeta::new_readonly(fee_key_a, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(transient_pda_b, false),
            AccountMeta::new_readonly(domain_quotes_pda, false),
            AccountMeta::new_readonly(wildcard_quotes_pda, false),
        ],
    );
    let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(FeeError::TransientPdaMismatch as u32),
        ),
    );

    // Try CloseTransientQuote on fee account A with B's transient PDA → should fail.
    let close_ix = Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::CloseTransientQuote,
        vec![
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(fee_key_a, false),
            AccountMeta::new(transient_pda_b, false),
            AccountMeta::new(payer.pubkey(), true),
        ],
    );
    let result = process_tx(&mut banks_client, &payer, close_ix, &[]).await;
    // CloseTransientQuote re-derives PDA from fee_account + scoped_salt.
    // Since fee_key_a != fee_key_b, derivation won't match.
    assert!(result.is_err());
}

#[tokio::test]
async fn test_standing_pda_recreated_after_prune() {
    let program_id = fee_program_id();
    let program_test = ProgramTest::new(
        "hyperlane_sealevel_fee",
        program_id,
        processor!(fee_process_instruction),
    );
    let mut ctx = program_test.start_with_context().await;
    let payer = ctx.payer.insecure_clone();
    let banks_client = &mut ctx.banks_client;

    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

    let fee_key = init_fee_account(
        banks_client,
        &payer,
        default_salt(),
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;
    let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    let dest = 42u32;
    let recipient = H256::random();

    // Submit standing quote with expiry=5000000000.
    let sq1 = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_standing_context(dest, recipient),
        encode_linear_data(1000, 500),
        encode_u48(100),
        encode_u48(5000000000),
    );
    let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &sq1, dest);
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // Verify PDA exists.
    let pda_key = standing_quote_pda_for(&fee_key, dest);
    let standing = fetch_standing_pda(banks_client, pda_key).await;
    assert_eq!(standing.quotes.len(), 1);

    // Warp clock past expiry and prune.
    let mut clock = banks_client
        .get_sysvar::<solana_program::clock::Clock>()
        .await
        .unwrap();
    clock.unix_timestamp = 6000000000;
    ctx.set_sysvar(&clock);
    let banks_client = &mut ctx.banks_client;

    let ix = build_prune_ix(&fee_key, &payer.pubkey(), dest);
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // PDA closed.
    let account = banks_client.get_account(pda_key).await.unwrap();
    assert!(account.is_none() || account.unwrap().data.is_empty());

    // Submit a new standing quote on the same domain — PDA should be recreated.
    let sq2 = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_standing_context(dest, recipient),
        encode_linear_data(2000, 1000),
        encode_u48(5500000000),
        encode_u48(9999999999),
    );
    let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &sq2, dest);
    process_tx(banks_client, &payer, ix, &[]).await.unwrap();

    // PDA recreated with new params.
    let standing = fetch_standing_pda(banks_client, pda_key).await;
    assert_eq!(standing.quotes.len(), 1);
    assert_eq!(
        standing
            .quotes
            .get(&recipient)
            .unwrap()
            .fee_data
            .params()
            .max_fee,
        2000
    );
}

#[tokio::test]
async fn test_cc_route_recreated_after_remove() {
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

    let pda = cc_route_pda_for(&fee_key, dest, &target_router);
    let route = fetch_cc_route(&mut banks_client, pda).await;
    assert_eq!(route.fee_data.params().max_fee, 100);

    let ix = build_remove_cc_route_ix(&fee_key, &payer.pubkey(), dest, target_router);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let account = banks_client.get_account(pda).await.unwrap();
    assert!(account.is_none() || account.unwrap().data.is_empty());

    let strategy2 = FeeDataStrategy::Regressive(FeeParams {
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

    let route = fetch_cc_route(&mut banks_client, pda).await;
    assert_eq!(route.fee_data, strategy2);
}
