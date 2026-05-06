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

mod submit_standing_quote {
    use super::*;

    #[tokio::test]
    async fn test_submit_standing_quote() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
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
        let context = encode_standing_context(dest, recipient);
        let data = encode_linear_data(2000, 1000);
        let issued_at = encode_u48(100);
        let expiry = encode_u48(9999999999);

        let quote = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data,
            issued_at,
            expiry,
        );

        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Verify domain PDA was created with the quote.
        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let standing = fetch_standing_pda(&mut banks_client, domain_pda).await;
        assert_eq!(standing.quotes.len(), 1);
        let value = standing.quotes.get(&recipient).unwrap();
        assert_eq!(value.fee_data.params().max_fee, 2000);
        assert_eq!(value.fee_data.params().half_amount, 1000);
        assert_eq!(value.issued_at, 100);
    }

    #[tokio::test]
    async fn test_replacement_with_newer_issued_at() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
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

        // First quote: issued_at=100, max_fee=1000.
        let context = encode_standing_context(dest, recipient);
        let data = encode_linear_data(1000, 500);
        let quote1 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context.clone(),
            data,
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote1, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Second quote: issued_at=200 (newer), max_fee=2000. Should replace.
        let data2 = encode_linear_data(2000, 1000);
        let quote2 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            data2,
            encode_u48(200),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote2, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let standing = fetch_standing_pda(&mut banks_client, domain_pda).await;
        assert_eq!(standing.quotes.len(), 1);
        let value = standing.quotes.get(&recipient).unwrap();
        assert_eq!(value.fee_data.params().max_fee, 2000);
        assert_eq!(value.issued_at, 200);
    }

    #[tokio::test]
    async fn test_stale_quote_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
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
        let context = encode_standing_context(dest, recipient);

        // First quote: issued_at=200.
        let quote1 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context.clone(),
            encode_linear_data(1000, 500),
            encode_u48(200),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote1, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Second quote: issued_at=100 (stale). Should be rejected.
        let quote2 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            encode_linear_data(2000, 1000),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote2, dest);
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(QuoteValidationError::StaleQuote as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_equal_issued_at_is_noop() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
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
        let context = encode_standing_context(dest, recipient);

        // First quote: issued_at=100, max_fee=1000.
        let quote1 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context.clone(),
            encode_linear_data(1000, 500),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote1, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Second quote: same issued_at=100 but max_fee=9999. Should be no-op.
        let quote2 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            encode_linear_data(9999, 5000),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote2, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Verify original value is unchanged.
        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let standing = fetch_standing_pda(&mut banks_client, domain_pda).await;
        let value = standing.quotes.get(&recipient).unwrap();
        assert_eq!(value.fee_data.params().max_fee, 1000); // not 9999
    }

    #[tokio::test]
    async fn test_non_wildcard_amount_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Context with specific amount (not wildcard).
        let mut context = Vec::with_capacity(44);
        context.extend_from_slice(&42u32.to_le_bytes());
        context.extend_from_slice(H256::zero().as_bytes());
        context.extend_from_slice(&1000u64.to_le_bytes()); // not u64::MAX

        let quote = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            context,
            encode_linear_data(1000, 500),
            encode_u48(100),
            encode_u48(9999999999),
        );

        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, 42);
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(FeeError::StandingQuoteAmountNotWildcard as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_multiple_recipients_per_domain() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let dest = 42u32;
        let recipient_a = H256::random();
        let recipient_b = H256::random();

        // Quote for recipient A.
        let quote_a = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, recipient_a),
            encode_linear_data(1000, 500),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote_a, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Quote for recipient B.
        let quote_b = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, recipient_b),
            encode_linear_data(2000, 1000),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote_b, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Verify both entries exist.
        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let standing = fetch_standing_pda(&mut banks_client, domain_pda).await;
        assert_eq!(standing.quotes.len(), 2);
        assert_eq!(
            standing
                .quotes
                .get(&recipient_a)
                .unwrap()
                .fee_data
                .params()
                .max_fee,
            1000
        );
        assert_eq!(
            standing
                .quotes
                .get(&recipient_b)
                .unwrap()
                .fee_data
                .params()
                .max_fee,
            2000
        );
    }

    #[tokio::test]
    async fn test_wildcard_recipient() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let dest = 42u32;
        let context =
            encode_standing_context(dest, hyperlane_sealevel_fee::accounts::WILDCARD_RECIPIENT);
        let data = encode_linear_data(3000, 1500);

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

        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let standing = fetch_standing_pda(&mut banks_client, domain_pda).await;
        assert!(standing
            .quotes
            .contains_key(&hyperlane_sealevel_fee::accounts::WILDCARD_RECIPIENT));
        assert_eq!(
            standing
                .quotes
                .get(&hyperlane_sealevel_fee::accounts::WILDCARD_RECIPIENT)
                .unwrap()
                .fee_data
                .params()
                .max_fee,
            3000
        );
    }

    #[tokio::test]
    async fn test_zero_fee_params_standing() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
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
        let context = encode_standing_context(dest, recipient);
        let data = encode_linear_data(0, 0); // zero fee

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

        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let standing = fetch_standing_pda(&mut banks_client, domain_pda).await;
        let value = standing.quotes.get(&recipient).unwrap();
        assert_eq!(value.fee_data.params().max_fee, 0);
        assert_eq!(value.fee_data.params().half_amount, 0);
    }

    #[tokio::test]
    async fn test_fully_wildcarded_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let context = encode_standing_context(
            hyperlane_sealevel_fee::accounts::WILDCARD_DOMAIN,
            hyperlane_sealevel_fee::accounts::WILDCARD_RECIPIENT,
        );
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

        let ix = build_submit_standing_ix(
            &fee_key,
            &payer.pubkey(),
            &quote,
            hyperlane_sealevel_fee::accounts::WILDCARD_DOMAIN,
        );
        let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(QuoteValidationError::FullyWildcardedQuote as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_routing_submit_spoofed_route_pda_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);
        let dest = 42u32;
        let recipient = H256::random();

        let fee_key_a = init_fee_account(
            &mut banks_client,
            &payer,
            H256::zero(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;
        let fee_key_b = init_fee_account(
            &mut banks_client,
            &payer,
            H256::repeat_byte(1),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        let strategy = FeeDataStrategy::Linear(FeeParams {
            max_fee: 1000,
            half_amount: 500,
        });
        process_tx(
            &mut banks_client,
            &payer,
            build_set_route_ix(&fee_key_a, &payer.pubkey(), dest, strategy.clone()),
            &[],
        )
        .await
        .unwrap();
        process_tx(
            &mut banks_client,
            &payer,
            build_set_route_ix(&fee_key_b, &payer.pubkey(), dest, strategy),
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
                Some(instruction::RouteKey::Domain(dest)),
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
            encode_standing_context(dest, recipient),
            encode_linear_data(777, 1),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let spoofed_route_pda = route_pda_for(&fee_key_b, dest);
        let result = process_tx(
            &mut banks_client,
            &payer,
            build_submit_standing_ix_with_routes(
                &fee_key_a,
                &payer.pubkey(),
                &quote,
                dest,
                &H256::zero(),
                &[spoofed_route_pda],
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
    async fn test_routing_wildcard_submit_with_extra_route_pda_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);
        let dest = 42u32;
        let recipient = H256::random();

        let mut wildcard_signers = BTreeSet::new();
        wildcard_signers.insert(signer_address);
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig { wildcard_signers }),
        )
        .await;

        process_tx(
            &mut banks_client,
            &payer,
            build_set_route_ix(
                &fee_key,
                &payer.pubkey(),
                dest,
                FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
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
            encode_standing_context(WILDCARD_DOMAIN, recipient),
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
                &H256::zero(),
                &[route_pda_for(&fee_key, dest)],
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
    async fn test_routing_exact_does_not_accept_wildcard_signer_only() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);
        let dest = 42u32;

        let mut wildcard_signers = BTreeSet::new();
        wildcard_signers.insert(signer_address);
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig { wildcard_signers }),
        )
        .await;

        process_tx(
            &mut banks_client,
            &payer,
            build_set_route_ix(
                &fee_key,
                &payer.pubkey(),
                dest,
                FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
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
            encode_standing_context(dest, H256::random()),
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
                &H256::zero(),
                &[route_pda_for(&fee_key, dest)],
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
    async fn test_routing_wildcard_does_not_accept_exact_signer_only() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);
        let dest = 42u32;

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

        process_tx(
            &mut banks_client,
            &payer,
            build_set_route_ix(
                &fee_key,
                &payer.pubkey(),
                dest,
                FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
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
                Some(instruction::RouteKey::Domain(dest)),
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
            encode_standing_context(WILDCARD_DOMAIN, H256::random()),
            encode_linear_data(777, 1),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let result = process_tx(
            &mut banks_client,
            &payer,
            build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, WILDCARD_DOMAIN),
            &[],
        )
        .await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(QuoteVerifyError::UnauthorizedSigner as u32),
            ),
        );
    }
}

mod quote_fee_standing {
    use super::*;

    async fn setup_with_standing(
        banks_client: &mut BanksClient,
        payer: &Keypair,
        signing_key: &SigningKey,
        dest: u32,
        recipient: H256,
        quoted_max_fee: u64,
        quoted_half_amount: u64,
    ) -> Pubkey {
        let signer_address = eth_address(signing_key);
        // On-chain Leaf: Linear with max_fee=100, half_amount=50.
        let fee_key = init_fee_account(
            banks_client,
            payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(banks_client, payer, ix, &[]).await.unwrap();

        let quote = make_signed_standing_quote(
            signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, recipient),
            encode_linear_data(quoted_max_fee, quoted_half_amount),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, dest);
        process_tx(banks_client, payer, ix, &[]).await.unwrap();

        fee_key
    }

    #[tokio::test]
    async fn test_standing_specific_match_fee_value() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());

        let dest = 42u32;
        let recipient = H256::random();
        // Standing: Linear with max_fee=2000, half_amount=1000.
        let fee_key = setup_with_standing(
            &mut banks_client,
            &payer,
            &signing_key,
            dest,
            recipient,
            2000,
            1000,
        )
        .await;

        // QuoteFee for amount=1000 → Linear: min(2000, 1000*2000/(2*1000)) = min(2000,1000) = 1000
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, recipient, 1000);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 1000);
    }

    #[tokio::test]
    async fn test_no_standing_falls_to_onchain_fee_value() {
        let (mut banks_client, payer) = setup_client().await;

        // On-chain Leaf: Linear max_fee=100, half_amount=50.
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
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        // amount=50 → Linear: min(100, 50*100/(2*50)) = min(100, 50) = 50
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), 42, H256::zero(), 50);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 50);
    }

    #[tokio::test]
    async fn test_standing_wildcard_recipient_fee_value() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());

        let dest = 42u32;
        // Standing with wildcard recipient: max_fee=5000, half_amount=2500.
        let fee_key = setup_with_standing(
            &mut banks_client,
            &payer,
            &signing_key,
            dest,
            WILDCARD_RECIPIENT,
            5000,
            2500,
        )
        .await;

        // Any recipient should match wildcard. amount=2500 → min(5000, 2500*5000/5000) = 2500
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, H256::random(), 2500);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 2500);
    }

    #[tokio::test]
    async fn test_specific_takes_priority_over_wildcard_fee_value() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let dest = 42u32;
        let specific_recipient = H256::random();

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
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Wildcard recipient: max_fee=10000.
        let q1 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, WILDCARD_RECIPIENT),
            encode_linear_data(10000, 5000),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &q1, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Specific recipient: max_fee=200.
        let q2 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, specific_recipient),
            encode_linear_data(200, 100),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &q2, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // amount=100 → specific: min(200, 100*200/200) = 100 (not wildcard: min(10000,...))
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, specific_recipient, 100);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 100);
    }

    #[tokio::test]
    async fn test_min_issued_at_skips_stale_falls_to_onchain() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());

        let dest = 42u32;
        let recipient = H256::zero();

        // Standing: max_fee=9999 (high). On-chain: max_fee=100, half_amount=50.
        let fee_key = setup_with_standing(
            &mut banks_client,
            &payer,
            &signing_key,
            dest,
            recipient,
            9999,
            5000,
        )
        .await;

        // Bump min_issued_at past the standing quote's issued_at (100).
        let ix = build_set_min_issued_at_ix(&fee_key, &payer.pubkey(), 200);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // amount=50 → should fall to on-chain: min(100, 50*100/100) = 50
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, recipient, 50);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 50);
    }

    #[tokio::test]
    async fn test_standing_zero_fee_value() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());

        let dest = 42u32;
        let recipient = H256::zero();

        // Standing with zero fee. On-chain has non-zero (100/50).
        let fee_key = setup_with_standing(
            &mut banks_client,
            &payer,
            &signing_key,
            dest,
            recipient,
            0,
            0,
        )
        .await;

        // Should use standing zero fee, not on-chain 100/50.
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, recipient, 50);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 0);
    }

    #[tokio::test]
    async fn test_wildcard_domain_match_fee_value() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

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
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let recipient = H256::random();
        let quote = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(WILDCARD_DOMAIN, recipient),
            encode_linear_data(8000, 4000),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, WILDCARD_DOMAIN);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // amount=4000 → Linear: min(8000, 4000*8000/8000) = 4000
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), 99, recipient, 4000);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 4000);
    }

    #[tokio::test]
    async fn test_domain_standing_takes_priority_over_wildcard_domain() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let dest = 42u32;
        let recipient = H256::random();

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
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Domain-specific standing: max_fee=777, half_amount=1 → fee = 777 for amount=100.
        let q_domain = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, recipient),
            encode_linear_data(777, 1),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &q_domain, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Wildcard domain standing: max_fee=333, half_amount=1 → fee = 333 for amount=100.
        let q_wildcard = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(WILDCARD_DOMAIN, recipient),
            encode_linear_data(333, 1),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &q_wildcard, WILDCARD_DOMAIN);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // amount=100 → domain standing: 777, wildcard standing: 333, on-chain: 100.
        // Domain-specific must win.
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, recipient, 100);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 777);
    }

    #[tokio::test]
    async fn test_transient_takes_priority_over_standing() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let dest = 42u32;
        let recipient = H256::zero();
        let amount = 100u64;

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
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Standing: max_fee=333, half_amount=1 → fee = min(333, 100*333/2) = 333.
        let sq = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, recipient),
            encode_linear_data(333, 1),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &sq, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Transient: max_fee=777, half_amount=1 → fee = min(777, 100*777/2) = 777.
        let mut transient_ctx = Vec::with_capacity(44);
        transient_ctx.extend_from_slice(&dest.to_le_bytes());
        transient_ctx.extend_from_slice(recipient.as_bytes());
        transient_ctx.extend_from_slice(&amount.to_le_bytes());

        let tq = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            transient_ctx,
            encode_linear_data(777, 1),
            encode_u48(100),
        );

        let scoped_salt = tq.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );
        let submit_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SubmitQuote(tq),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(transient_pda, false),
            ],
        );
        process_tx(&mut banks_client, &payer, submit_ix, &[])
            .await
            .unwrap();

        // QuoteFee with transient → transient wins (777/1), not standing (333/1).
        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let wildcard_pda = standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN);
        let quote_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient,
                amount,
                target_router: H256::zero(),
            }),
            vec![
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(transient_pda, false),
                AccountMeta::new_readonly(domain_pda, false),
                AccountMeta::new_readonly(wildcard_pda, false),
            ],
        );
        let fee = simulate_quote_fee(&mut banks_client, &payer, quote_ix).await;
        // Transient: Linear max_fee=777, half_amount=1, amount=100 → min(777, 100*777/2) = 777.
        // Standing would give: min(333, 100*333/2) = 333.
        // On-chain would give: min(100, 100*100/100) = 100.
        // All three values are distinct, confirming transient was used.
        assert_eq!(fee, 777);
    }

    #[tokio::test]
    async fn test_spoofed_standing_pda_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let dest = 42u32;
        let recipient = H256::zero();

        // Create fee account A with on-chain max_fee=100.
        let salt_a = H256::zero();
        let fee_key_a = init_fee_account(
            &mut banks_client,
            &payer,
            salt_a,
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key_a, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Create fee account B with a standing quote (max_fee=1, very cheap).
        let salt_b = H256::random();
        let fee_key_b = init_fee_account(
            &mut banks_client,
            &payer,
            salt_b,
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 10000,
                    half_amount: 5000,
                }),
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key_b, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit cheap standing quote on fee_key_b.
        let quote_b = make_signed_standing_quote(
            &signing_key,
            &fee_key_b,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, recipient),
            encode_linear_data(1, 1), // very cheap
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key_b, &payer.pubkey(), &quote_b, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Try to use fee_key_b's standing PDA when querying fee_key_a.
        let spoofed_domain_pda = standing_quote_pda_for(&fee_key_b, dest);
        let wildcard_pda = standing_quote_pda_for(&fee_key_a, WILDCARD_DOMAIN);

        let quote_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient,
                amount: 50,
                target_router: H256::zero(),
            }),
            vec![
                AccountMeta::new_readonly(fee_key_a, false), // querying A
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(spoofed_domain_pda, false), // B's PDA!
                AccountMeta::new_readonly(wildcard_pda, false),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
        // Should fail because B's PDA doesn't match A's expected domain standing
        // PDA derivation. The dispatcher then treats slot 2 as a transient slot
        // and rejects it because the account is initialized as a standing PDA
        // (wrong discriminator).
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(
                    hyperlane_sealevel_fee::error::Error::InvalidTransientSlot as u32,
                ),
            ),
        );
    }

    #[tokio::test]
    async fn test_spoofed_routing_route_pda_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let dest = 42u32;
        let recipient = H256::random();

        let fee_key_a = init_fee_account(
            &mut banks_client,
            &payer,
            H256::zero(),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;
        let fee_key_b = init_fee_account(
            &mut banks_client,
            &payer,
            H256::repeat_byte(1),
            payer.pubkey(),
            FeeData::Routing(RoutingFeeConfig {
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
            build_set_route_ix(&fee_key_a, &payer.pubkey(), dest, strategy.clone()),
            &[],
        )
        .await
        .unwrap();
        process_tx(
            &mut banks_client,
            &payer,
            build_set_route_ix(&fee_key_b, &payer.pubkey(), dest, strategy),
            &[],
        )
        .await
        .unwrap();

        let domain_quotes_pda = standing_quote_pda_for(&fee_key_a, dest);
        let wildcard_quotes_pda = standing_quote_pda_for(&fee_key_a, WILDCARD_DOMAIN);
        let spoofed_route_pda = route_pda_for(&fee_key_b, dest);

        let quote_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient,
                amount: 100,
                target_router: H256::zero(),
            }),
            vec![
                AccountMeta::new_readonly(fee_key_a, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
                AccountMeta::new_readonly(spoofed_route_pda, false),
            ],
        );
        let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }

    #[tokio::test]
    async fn test_routing_wildcard_submit_and_quote_fee_works() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);
        let dest = 42u32;
        let recipient = H256::random();

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

        process_tx(
            &mut banks_client,
            &payer,
            build_set_route_ix(
                &fee_key,
                &payer.pubkey(),
                dest,
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
            encode_standing_context(WILDCARD_DOMAIN, recipient),
            encode_linear_data(777, 1),
            encode_u48(100),
            encode_u48(9999999999),
        );
        process_tx(
            &mut banks_client,
            &payer,
            build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, WILDCARD_DOMAIN),
            &[],
        )
        .await
        .unwrap();

        let ix = build_quote_fee_routing_ix(&fee_key, &payer.pubkey(), dest, recipient, 100);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, 777);
    }

    #[tokio::test]
    async fn test_expired_standing_falls_to_onchain() {
        // Standing quote exists but is expired → QuoteFee skips it, uses on-chain params.
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

        let dest = 42u32;
        let recipient = H256::random();

        // On-chain Leaf: Linear max_fee=100, half_amount=50.
        let fee_key = init_fee_account(
            banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            FeeData::Leaf(LeafFeeConfig {
                strategy: FeeDataStrategy::Linear(FeeParams {
                    max_fee: 100,
                    half_amount: 50,
                }),
                signers: Some(BTreeSet::new()),
            }),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(banks_client, &payer, ix, &[]).await.unwrap();

        // Standing quote: max_fee=9999, expiry=5000000000.
        let sq = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, recipient),
            encode_linear_data(9999, 5000),
            encode_u48(100),
            encode_u48(5000000000),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &sq, dest);
        process_tx(banks_client, &payer, ix, &[]).await.unwrap();

        // Warp clock past expiry.
        let mut clock = banks_client
            .get_sysvar::<solana_program::clock::Clock>()
            .await
            .unwrap();
        clock.unix_timestamp = 6000000000;
        ctx.set_sysvar(&clock);
        let banks_client = &mut ctx.banks_client;

        // QuoteFee: standing is expired → falls to on-chain.
        // On-chain: Linear max_fee=100, half_amount=50, amount=50.
        // min(100, 50*100/(2*50)) = min(100, 50) = 50.
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, recipient, 50);
        let fee = simulate_quote_fee(banks_client, &payer, ix).await;
        assert_eq!(fee, 50);
    }

    /// Regression: standing quotes remain usable even after the signer set is removed.
    /// QuoteFee does not check signers — only SubmitQuote does.
    /// Revocation is via min_issued_at, not signer config changes.
    #[tokio::test]
    async fn test_standing_quote_survives_signer_removal() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let dest = 42u32;
        let recipient = H256::zero();

        // Setup Leaf fee account with standing quote (max_fee=9999, half_amount=5000).
        let fee_key = setup_with_standing(
            &mut banks_client,
            &payer,
            &signing_key,
            dest,
            recipient,
            9999,
            5000,
        )
        .await;

        // Verify standing quote is used.
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, recipient, 5000);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        // Standing: regressive-like params → fee should come from standing quote, not on-chain.
        assert!(fee > 0);
        let fee_before = fee;

        // Remove the signer. FeeAccount.signers becomes Some(empty set).
        let ix = build_remove_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();
        let acct = fetch_fee_account(&mut banks_client, fee_key).await;
        assert!(leaf_signers(&acct).as_ref().unwrap().is_empty());

        // Standing quote still works — QuoteFee doesn't check signers.
        let ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, recipient, 5000);
        let fee = simulate_quote_fee(&mut banks_client, &payer, ix).await;
        assert_eq!(fee, fee_before);
    }
}

mod close_transient_quote {
    use super::*;

    async fn setup_and_submit_transient(
        banks_client: &mut BanksClient,
        payer: &Keypair,
    ) -> (Pubkey, Pubkey) {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            banks_client,
            payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(banks_client, payer, ix, &[]).await.unwrap();

        let quote = make_signed_transient_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_context(42, H256::zero(), 1000),
            encode_linear_data(100, 50),
            encode_u48(100),
        );

        let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
        let (transient_pda, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_key, scoped_salt),
            &fee_program_id(),
        );

        let submit_ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::SubmitQuote(quote),
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(transient_pda, false),
            ],
        );
        process_tx(banks_client, payer, submit_ix, &[])
            .await
            .unwrap();

        (fee_key, transient_pda)
    }

    #[tokio::test]
    async fn test_close_by_payer() {
        let (mut banks_client, payer) = setup_client().await;
        let (fee_key, transient_pda) = setup_and_submit_transient(&mut banks_client, &payer).await;

        let ix = build_close_transient_ix(&fee_key, &transient_pda, &payer.pubkey());
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let account = banks_client.get_account(transient_pda).await.unwrap();
        assert!(account.is_none() || account.unwrap().data.is_empty());
    }

    #[tokio::test]
    async fn test_close_by_wrong_payer_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let (fee_key, transient_pda) = setup_and_submit_transient(&mut banks_client, &payer).await;

        let wrong_payer = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &wrong_payer).await;

        let ix = build_close_transient_ix(&fee_key, &transient_pda, &wrong_payer.pubkey());
        let result = process_tx(&mut banks_client, &wrong_payer, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(
                0,
                InstructionError::Custom(QuoteValidationError::TransientPayerMismatch as u32),
            ),
        );
    }

    #[tokio::test]
    async fn test_extraneous_account_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let (fee_key, transient_pda) = setup_and_submit_transient(&mut banks_client, &payer).await;

        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::CloseTransientQuote,
            vec![
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(transient_pda, false),
                AccountMeta::new(payer.pubkey(), true),
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

mod prune_expired_quotes {
    use super::*;

    async fn setup_fee_with_signer(
        banks_client: &mut BanksClient,
        payer: &Keypair,
        signing_key: &SigningKey,
    ) -> Pubkey {
        let signer_address = eth_address(signing_key);
        let fee_key = init_fee_account(
            banks_client,
            payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;
        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(banks_client, payer, ix, &[]).await.unwrap();
        fee_key
    }

    #[tokio::test]
    async fn test_prune_all_expired_closes_pda() {
        // Use ProgramTestContext to manipulate the clock.
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
        let fee_key = setup_fee_with_signer(banks_client, &payer, &signing_key).await;

        let dest = 42u32;
        // Submit with expiry=9999999999 (valid now, will be expired after clock warp).
        let quote = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, H256::zero()),
            encode_linear_data(1000, 500),
            encode_u48(100),
            encode_u48(9999999999),
        );
        process_tx(
            banks_client,
            &payer,
            build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, dest),
            &[],
        )
        .await
        .unwrap();

        // Warp clock past expiry.
        let mut clock = banks_client
            .get_sysvar::<solana_program::clock::Clock>()
            .await
            .unwrap();
        clock.unix_timestamp = 99999999999;
        ctx.set_sysvar(&clock);

        let banks_client = &mut ctx.banks_client;

        let ix = build_prune_ix(&fee_key, &payer.pubkey(), dest);
        process_tx(banks_client, &payer, ix, &[]).await.unwrap();

        // PDA should be closed.
        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let account = banks_client.get_account(domain_pda).await.unwrap();
        assert!(account.is_none() || account.unwrap().data.is_empty());
    }

    #[tokio::test]
    async fn test_prune_keeps_non_expired_entries() {
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
        let fee_key = setup_fee_with_signer(banks_client, &payer, &signing_key).await;

        let dest = 42u32;
        let expired_recipient = H256::random();
        let valid_recipient = H256::random();

        // Submit entry that will expire at 50000000000 (before warp target).
        let q1 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, expired_recipient),
            encode_linear_data(1000, 500),
            encode_u48(100),
            encode_u48(50000000000),
        );
        process_tx(
            banks_client,
            &payer,
            build_submit_standing_ix(&fee_key, &payer.pubkey(), &q1, dest),
            &[],
        )
        .await
        .unwrap();

        // Submit entry that won't expire until 200000000000 (after warp target).
        let q2 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, valid_recipient),
            encode_linear_data(2000, 1000),
            encode_u48(100),
            encode_u48(200000000000),
        );
        process_tx(
            banks_client,
            &payer,
            build_submit_standing_ix(&fee_key, &payer.pubkey(), &q2, dest),
            &[],
        )
        .await
        .unwrap();

        // Warp clock past first entry's expiry but before second's.
        let mut clock = banks_client
            .get_sysvar::<solana_program::clock::Clock>()
            .await
            .unwrap();
        clock.unix_timestamp = 99999999999;
        ctx.set_sysvar(&clock);
        let banks_client = &mut ctx.banks_client;

        // Prune.
        let ix = build_prune_ix(&fee_key, &payer.pubkey(), dest);
        process_tx(banks_client, &payer, ix, &[]).await.unwrap();

        // PDA should still exist with only the valid entry.
        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let standing = fetch_standing_pda(banks_client, domain_pda).await;
        assert_eq!(standing.quotes.len(), 1);
        assert!(!standing.quotes.contains_key(&expired_recipient));
        assert!(standing.quotes.contains_key(&valid_recipient));
    }

    #[tokio::test]
    async fn test_prune_nonexistent_domain_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_prune_ix(&fee_key, &payer.pubkey(), 99);
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
    async fn test_prune_non_owner_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let fee_key = setup_fee_with_signer(&mut banks_client, &payer, &signing_key).await;

        let dest = 42u32;
        let quote = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, H256::zero()),
            encode_linear_data(1000, 500),
            encode_u48(100),
            encode_u48(9999999999),
        );
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        let non_owner = Keypair::new();
        fund_keypair(&mut banks_client, &payer, &non_owner).await;

        let ix = build_prune_ix(&fee_key, &non_owner.pubkey(), dest);
        let result = process_tx(&mut banks_client, &non_owner, ix, &[]).await;
        assert_tx_error(
            result,
            TransactionError::InstructionError(0, InstructionError::InvalidArgument),
        );
    }

    #[tokio::test]
    async fn test_prune_removes_quotes_below_min_issued_at() {
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
        let fee_key = setup_fee_with_signer(banks_client, &payer, &signing_key).await;

        let dest = 42u32;
        let stale_recipient = H256::random();
        let fresh_recipient = H256::random();

        // Submit quote with issued_at=100 (will be below min_issued_at).
        let q1 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, stale_recipient),
            encode_linear_data(1000, 500),
            encode_u48(100),
            encode_u48(9999999999),
        );
        process_tx(
            banks_client,
            &payer,
            build_submit_standing_ix(&fee_key, &payer.pubkey(), &q1, dest),
            &[],
        )
        .await
        .unwrap();

        // Submit quote with issued_at=300 (will be above min_issued_at).
        let q2 = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, fresh_recipient),
            encode_linear_data(2000, 1000),
            encode_u48(300),
            encode_u48(9999999999),
        );
        process_tx(
            banks_client,
            &payer,
            build_submit_standing_ix(&fee_key, &payer.pubkey(), &q2, dest),
            &[],
        )
        .await
        .unwrap();

        // Warp clock so min_issued_at=200 can be set.
        let mut clock = banks_client
            .get_sysvar::<solana_program::clock::Clock>()
            .await
            .unwrap();
        clock.unix_timestamp = 400;
        ctx.set_sysvar(&clock);
        let banks_client = &mut ctx.banks_client;

        // Set min_issued_at=200.
        let ix = build_set_min_issued_at_ix(&fee_key, &payer.pubkey(), 200);
        process_tx(banks_client, &payer, ix, &[]).await.unwrap();

        // Prune — only the stale entry (issued_at=100) should be removed.
        let ix = build_prune_ix(&fee_key, &payer.pubkey(), dest);
        process_tx(banks_client, &payer, ix, &[]).await.unwrap();

        // PDA should still exist with only the fresh entry.
        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let standing = fetch_standing_pda(banks_client, domain_pda).await;
        assert_eq!(standing.quotes.len(), 1);
        assert!(!standing.quotes.contains_key(&stale_recipient));
        assert!(standing.quotes.contains_key(&fresh_recipient));
    }

    #[tokio::test]
    async fn test_extraneous_account_rejected() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let fee_key = setup_fee_with_signer(&mut banks_client, &payer, &signing_key).await;

        let dest = 42u32;
        let quote = make_signed_standing_quote(
            &signing_key,
            &fee_key,
            LOCAL_DOMAIN,
            &payer.pubkey(),
            encode_standing_context(dest, H256::zero()),
            encode_linear_data(1000, 500),
            encode_u48(100),
            encode_u48(9999999999),
        );
        process_tx(
            &mut banks_client,
            &payer,
            build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, dest),
            &[],
        )
        .await
        .unwrap();

        let domain_pda = standing_quote_pda_for(&fee_key, dest);
        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::PruneExpiredQuotes {
                domain: dest,
                target_router: None,
            },
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(domain_pda, false),
                AccountMeta::new_readonly(Pubkey::new_unique(), false),
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

    #[tokio::test]
    async fn test_prune_none_on_cc_account_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let _fee_key = setup_fee_with_signer(&mut banks_client, &payer, &signing_key).await;

        // Re-init as CC. We need a fresh CC fee account.
        // setup_fee_with_signer creates Leaf. Create a separate CC one.
        let cc_fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            H256::random(), // different salt
            payer.pubkey(),
            FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
                wildcard_signers: BTreeSet::new(),
            }),
        )
        .await;

        // Prune with None on CC account → mode mismatch (CC requires Some).
        let domain_le = 42u32.to_le_bytes();
        let (domain_pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(cc_fee_key, &domain_le),
            &fee_program_id(),
        );
        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::PruneExpiredQuotes {
                domain: 42,
                target_router: None,
            },
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(cc_fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(domain_pda, false),
            ],
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
    async fn test_prune_some_on_leaf_account_fails() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_key = init_fee_account(
            &mut banks_client,
            &payer,
            default_salt(),
            payer.pubkey(),
            default_leaf_fee_data(),
        )
        .await;

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit a valid Leaf standing quote first so the domain PDA exists.
        let context = encode_standing_context(42, H256::zero());
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
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, 42);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Prune with Some(router) on Leaf account → mode mismatch (Leaf requires None).
        let random_router = H256::random();
        let domain_le = 42u32.to_le_bytes();
        let (wrong_pda, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(fee_key, &domain_le, random_router),
            &fee_program_id(),
        );
        let ix = Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::PruneExpiredQuotes {
                domain: 42,
                target_router: Some(random_router),
            },
            vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(wrong_pda, false),
            ],
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

    /// C-3: Standing quote with mismatched curve variant is skipped, falls through to on-chain.
    #[tokio::test]
    async fn test_standing_curve_variant_mismatch_falls_through_to_onchain() {
        let (mut banks_client, payer) = setup_client().await;
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        // On-chain uses Progressive with max_fee=100, half_amount=50.
        let fee_key = init_fee_account(
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

        let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // Submit standing quote with Linear (mismatched variant).
        let dest = 42u32;
        let recipient = H256::zero();
        let context = encode_standing_context(dest, recipient);
        let data = encode_linear_data(9999, 5000);

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
        let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, dest);
        process_tx(&mut banks_client, &payer, ix, &[])
            .await
            .unwrap();

        // QuoteFee should skip the mismatched standing quote and use on-chain Progressive.
        let amount = 1000u64;
        let quote_ix = build_quote_fee_leaf_ix(&fee_key, &payer.pubkey(), dest, recipient, amount);
        let fee = simulate_quote_fee(&mut banks_client, &payer, quote_ix).await;

        // Progressive: fee = max_fee * amount^2 / (half_amount^2 + amount^2)
        // = 100 * 1_000_000 / (2_500 + 1_000_000) = 100_000_000 / 1_002_500 = 99
        assert_eq!(
            fee, 99,
            "should use on-chain Progressive, not standing Linear"
        );
    }
}
