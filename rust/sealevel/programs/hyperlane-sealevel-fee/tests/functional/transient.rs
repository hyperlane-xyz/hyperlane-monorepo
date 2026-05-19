use crate::*;

#[tokio::test]
async fn test_submit_transient_quote() {
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

    // Add signer.
    let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Use a far-future timestamp so the quote hasn't expired.
    let issued_at = encode_u48(100);
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(42, H256::zero(), 1000),
        encode_linear_data(100, 50),
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
    let issued_at = encode_u48(100);
    let quote = make_signed_transient_quote(
        &wrong_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(42, H256::zero(), 1000),
        encode_linear_data(100, 50),
        issued_at,
    );

    let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
    let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteVerifyError::UnauthorizedSigner as u32),
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
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    // Leaf signers is Some(empty) — verify_signer short-circuits with
    // NoAuthorizedSigners before doing any signature work.
    let issued_at = encode_u48(100);
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(42, H256::zero(), 1000),
        encode_linear_data(100, 50),
        issued_at,
    );

    let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
    let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteVerifyError::NoAuthorizedSigners as u32),
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
            InstructionError::Custom(QuoteValidationError::InvalidExpiry as u32),
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
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let issued_at = encode_u48(100);
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(42, H256::zero(), 1000),
        encode_linear_data(100, 50),
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
            InstructionError::Custom(AccountError::ExtraneousAccount as u32),
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
        encode_context(42, H256::zero(), 1000),
        encode_linear_data(100, 50),
        issued_at,
    );

    let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
    let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::QuoteExpired as u32),
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
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Zero fee params (max_fee=0, half_amount=0).
    let issued_at = encode_u48(100);
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(42, H256::zero(), 1000),
        encode_linear_data(0, 0), // zero fees
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
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let issued_at = encode_u48(100);
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(42, H256::zero(), 1000),
        encode_linear_data(100, 50),
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

#[tokio::test]
async fn test_transient_issued_at_too_far_in_future_rejected() {
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

    // Clock is at 2, MAX_ISSUED_AT_SKEW = 300. issued_at = 400 > 2 + 300 → rejected.
    let context = encode_context(42, H256::zero(), 100);
    let data = encode_linear_data(1000, 500);
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        context,
        data,
        encode_u48(400),
    );

    let ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
    let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::IssuedAtTooFarInFuture as u32),
        ),
    );
}

#[tokio::test]
async fn test_standing_issued_at_too_far_in_future_rejected() {
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

    // Standing quote: issued_at = 400 > 2 + 300 → rejected.
    let quote = make_signed_standing_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_standing_context(42, H256::zero()),
        encode_linear_data(1000, 500),
        encode_u48(400),        // issued_at: too far in future
        encode_u48(9999999999), // expiry: far future (valid)
    );

    let ix = build_submit_standing_ix(&fee_key, &payer.pubkey(), &quote, 42);
    let result = process_tx(&mut banks_client, &payer, ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::IssuedAtTooFarInFuture as u32),
        ),
    );
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

    // Submit a transient quote with DIFFERENT params: max_fee=2000, half_amount=1000.
    let dest = 42u32;
    let recipient = H256::zero();
    let amount = 1000u64;
    let context = encode_context(dest, recipient, amount);
    let data = encode_linear_data(2000, 1000);
    let issued_at = encode_u48(100);

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

    // Simulate to verify the fee value.
    let sim_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        dest,
        recipient,
        amount,
    );
    let fee = simulate_quote_fee(&mut banks_client, &payer, sim_ix).await;

    // Transient params: Linear max_fee=2000, half_amount=1000, amount=1000.
    // min(2000, 1000*2000/(2*1000)) = min(2000, 1000) = 1000.
    // On-chain would give: min(100, 1000*100/(2*50)) = 100. Confirms transient was used.
    assert_eq!(fee, 1000);

    // Execute to actually close the PDA.
    let exec_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        dest,
        recipient,
        amount,
    );
    process_tx(&mut banks_client, &payer, exec_ix, &[])
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
    let data = encode_linear_data(1000, 500);
    let issued_at = encode_u48(100);

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
            InstructionError::Custom(QuoteValidationError::TransientContextMismatch as u32),
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
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let context = encode_context(42, H256::zero(), 500);
    let data = encode_linear_data(1000, 500);
    let issued_at = encode_u48(100);

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
            InstructionError::Custom(QuoteValidationError::TransientContextMismatch as u32),
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
        payer.pubkey(),
        default_leaf_fee_data(),
    )
    .await;

    let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let context = encode_context(42, H256::zero(), 500);
    let data = encode_linear_data(1000, 500);
    let issued_at = encode_u48(100);

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
            InstructionError::Custom(QuoteValidationError::TransientContextMismatch as u32),
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

    let ix = build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Submit transient with zero fee params (max_fee=0, half_amount=0).
    let dest = 42u32;
    let recipient = H256::zero();
    let amount = 1000u64;
    let context = encode_context(dest, recipient, amount);
    let data = encode_linear_data(0, 0); // zero fee
    let issued_at = encode_u48(100);

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

    // Simulate to verify the fee value.
    let sim_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        dest,
        recipient,
        amount,
    );
    let fee = simulate_quote_fee(&mut banks_client, &payer, sim_ix).await;

    // Transient params: max_fee=0, half_amount=0 → fee = 0.
    // On-chain would give: min(1000, 1000*1000/(2*500)) = 1000. Confirms transient was used.
    assert_eq!(fee, 0);

    // Execute to actually close the PDA.
    let exec_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        dest,
        recipient,
        amount,
    );
    process_tx(&mut banks_client, &payer, exec_ix, &[])
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
        payer.pubkey(),
        FeeData::Routing(RoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        }),
    )
    .await;

    // Configure route for domain 42.
    let route_strategy = FeeDataStrategy::Regressive(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    let ix = build_set_route_ix(&fee_key, &payer.pubkey(), 42, route_strategy);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Add signer to route PDA (must exist first).
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::Domain(42)),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    let dest = 42u32;
    let recipient = H256::zero();
    let amount = 100u64;
    let context = encode_context(dest, recipient, amount);
    let data = encode_data(&FeeDataStrategy::Regressive(FeeParams {
        max_fee: 2000,
        half_amount: 1000,
    }));
    let issued_at = encode_u48(100);

    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        context,
        data,
        issued_at,
    );

    let route_pda = route_pda_for(&fee_key, 42);
    let submit_ix =
        build_submit_transient_ix_with_routes(&fee_key, &payer.pubkey(), &quote, &[route_pda]);
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

    let build_ix = || {
        Instruction::new_with_borsh(
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
                AccountMeta::new_readonly(domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
                AccountMeta::new_readonly(route_pda, false),
            ],
        )
    };

    // Simulate to verify the fee value.
    let fee = simulate_quote_fee(&mut banks_client, &payer, build_ix()).await;

    // Transient params: Regressive max_fee=2000, half_amount=1000, amount=100.
    // 2000 * 100 / (1000 + 100) = 181.
    // On-chain route would give: 100 * 100 / (50 + 100) = 66. Confirms transient was used.
    assert_eq!(fee, 181);

    // Execute to actually close the PDA.
    process_tx(&mut banks_client, &payer, build_ix(), &[])
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
        payer.pubkey(),
        FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        }),
    )
    .await;

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

    // Submit transient with CC context (76 bytes).
    let context = encode_cc_context(dest, recipient, amount, target_router);
    let data = encode_data(&FeeDataStrategy::Progressive(FeeParams {
        max_fee: 3000,
        half_amount: 1500,
    }));
    let issued_at = encode_u48(100);

    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        context,
        data,
        issued_at,
    );

    let specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);
    let submit_ix =
        build_submit_transient_ix_with_routes(&fee_key, &payer.pubkey(), &quote, &[specific_pda]);
    process_tx(&mut banks_client, &payer, submit_ix, &[])
        .await
        .unwrap();

    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );

    // QuoteFee with CC accounts + transient.
    let specific_domain_quotes_pda = cc_standing_quote_pda_for(&fee_key, dest, &target_router);
    let default_domain_quotes_pda = cc_standing_quote_pda_for(&fee_key, dest, &DEFAULT_ROUTER);
    let wildcard_quotes_pda = cc_standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN, &target_router);
    let cc_specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);
    let cc_default_pda = cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER);

    let build_ix = || {
        Instruction::new_with_borsh(
            fee_program_id(),
            &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
                destination_domain: dest,
                recipient,
                amount,
                target_router,
            }),
            vec![
                AccountMeta::new_readonly(fee_key, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(transient_pda, false),
                AccountMeta::new_readonly(specific_domain_quotes_pda, false),
                AccountMeta::new_readonly(default_domain_quotes_pda, false),
                AccountMeta::new_readonly(wildcard_quotes_pda, false),
                AccountMeta::new_readonly(cc_specific_pda, false),
                AccountMeta::new_readonly(cc_default_pda, false),
            ],
        )
    };

    // Simulate to verify the fee value.
    let fee = simulate_quote_fee(&mut banks_client, &payer, build_ix()).await;

    // Transient params: Progressive max_fee=3000, half_amount=1500, amount=500.
    // 3000 * 500^2 / (1500^2 + 500^2) = 300.
    // On-chain route would give: 100 * 500^2 / (50^2 + 500^2) = 99. Confirms transient was used.
    assert_eq!(fee, 300);

    // Execute to actually close the PDA.
    process_tx(&mut banks_client, &payer, build_ix(), &[])
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
        payer.pubkey(),
        FeeData::CrossCollateralRouting(CrossCollateralRoutingFeeConfig {
            wildcard_signers: BTreeSet::new(),
        }),
    )
    .await;

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
        route_strategy.clone(),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Also set up a CC route for wrong_router so the transient submit can resolve it.
    let ix = build_set_cc_route_ix(
        &fee_key,
        &payer.pubkey(),
        dest,
        wrong_router,
        route_strategy,
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Add signer to wrong_router CC route PDA (quote context uses wrong_router).
    let ix = build_add_quote_signer_ix_with_route(
        &fee_key,
        &payer.pubkey(),
        signer_address,
        Some(instruction::RouteKey::CrossCollateral {
            destination: dest,
            target_router: wrong_router,
        }),
    );
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Submit transient with wrong target_router in context.
    let context = encode_cc_context(dest, H256::zero(), 100, wrong_router);
    let data = encode_linear_data(1000, 500);
    let issued_at = encode_u48(100);

    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        context,
        data,
        issued_at,
    );

    let wrong_specific_pda = cc_route_pda_for(&fee_key, dest, &wrong_router);
    let submit_ix = build_submit_transient_ix_with_routes(
        &fee_key,
        &payer.pubkey(),
        &quote,
        &[wrong_specific_pda],
    );
    process_tx(&mut banks_client, &payer, submit_ix, &[])
        .await
        .unwrap();

    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );

    // QuoteFee with correct target_router but quote has wrong_router → mismatch.
    // Use CC-shape standing PDAs since this is a CC fee account; otherwise the
    // test only happens to pass because transient validation trips first.
    let specific_domain_quotes_pda = cc_standing_quote_pda_for(&fee_key, dest, &target_router);
    let default_domain_quotes_pda = cc_standing_quote_pda_for(&fee_key, dest, &DEFAULT_ROUTER);
    let wildcard_quotes_pda = cc_standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN, &target_router);
    let cc_specific_pda = cc_route_pda_for(&fee_key, dest, &target_router);
    let cc_default_pda = cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER);

    let quote_ix = Instruction::new_with_borsh(
        fee_program_id(),
        &FeeInstruction::QuoteFee(hyperlane_sealevel_fee::instruction::QuoteFee {
            destination_domain: dest,
            recipient: H256::zero(),
            amount: 100,
            target_router, // correct router in instruction
        }),
        vec![
            AccountMeta::new_readonly(fee_key, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(transient_pda, false),
            AccountMeta::new_readonly(specific_domain_quotes_pda, false),
            AccountMeta::new_readonly(default_domain_quotes_pda, false),
            AccountMeta::new_readonly(wildcard_quotes_pda, false),
            AccountMeta::new_readonly(cc_specific_pda, false),
            AccountMeta::new_readonly(cc_default_pda, false),
        ],
    );
    let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::TransientContextMismatch as u32),
        ),
    );
}

/// A CC transient quote signed with `ctx.target_router == DEFAULT_ROUTER` would
/// be unconsumable: real QuoteFee callers always pass a concrete target_router
/// and the consume-time validation is strict on that field. The submit handler
/// rejects this shape early to prevent operator footguns / rent stranding.
#[tokio::test]
async fn test_cc_transient_default_router_target_rejected() {
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

    // Set up the DEFAULT_ROUTER CC route + signer so the route PDA exists and
    // signer resolution would otherwise succeed — proving the rejection comes
    // from the explicit transient-DEFAULT_ROUTER guard, not from missing state.
    process_tx(
        &mut banks_client,
        &payer,
        build_set_cc_route_ix(
            &fee_key,
            &payer.pubkey(),
            dest,
            DEFAULT_ROUTER,
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
            Some(instruction::RouteKey::CrossCollateral {
                destination: dest,
                target_router: DEFAULT_ROUTER,
            }),
        ),
        &[],
    )
    .await
    .unwrap();

    let context = encode_cc_context(dest, H256::zero(), 100, DEFAULT_ROUTER);
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        context,
        encode_linear_data(1000, 500),
        encode_u48(100),
    );

    let route_pda = cc_route_pda_for(&fee_key, dest, &DEFAULT_ROUTER);
    let submit_ix =
        build_submit_transient_ix_with_routes(&fee_key, &payer.pubkey(), &quote, &[route_pda]);
    let result = process_tx(&mut banks_client, &payer, submit_ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(FeeError::DefaultRouterNotAllowedForTransientQuote as u32),
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
    let data = encode_linear_data(1000, 500);
    let issued_at = encode_u48(100);

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
            InstructionError::Custom(QuoteValidationError::TransientPayerMismatch as u32),
        ),
    );
}

/// Routed wildcard-domain transient quote signed by `wildcard_signers` is
/// accepted at submit and consumable at QuoteFee for any concrete destination
/// whose route shares the on-chain curve variant.
#[tokio::test]
async fn test_routed_wildcard_domain_transient_consumed() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

    // Routing fee account with a wildcard signer set.
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

    // Configure a concrete route so QuoteFee has an on-chain curve to match.
    let dest = 42u32;
    let route_strategy = FeeDataStrategy::Linear(FeeParams {
        max_fee: 100,
        half_amount: 50,
    });
    let ix = build_set_route_ix(&fee_key, &payer.pubkey(), dest, route_strategy);
    process_tx(&mut banks_client, &payer, ix, &[])
        .await
        .unwrap();

    // Transient quote with WILDCARD_DOMAIN — covers any concrete destination
    // whose curve matches.
    let recipient = H256::zero();
    let amount = 1000u64;
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(WILDCARD_DOMAIN, recipient, amount),
        encode_linear_data(777, 1),
        encode_u48(100),
    );

    let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
    process_tx(&mut banks_client, &payer, submit_ix, &[])
        .await
        .unwrap();

    // QuoteFee against the concrete destination resolves the wildcard transient.
    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );
    let domain_le = dest.to_le_bytes();
    let (route_pda, _) = Pubkey::find_program_address(
        route_domain_pda_seeds!(fee_key, &domain_le),
        &fee_program_id(),
    );
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
            AccountMeta::new_readonly(standing_quote_pda_for(&fee_key, dest), false),
            AccountMeta::new_readonly(standing_quote_pda_for(&fee_key, WILDCARD_DOMAIN), false),
            AccountMeta::new_readonly(route_pda, false),
        ],
    );

    let fee = simulate_quote_fee(&mut banks_client, &payer, quote_ix).await;
    // Transient: Linear max_fee=777 half_amount=1 amount=1000 → min(777, 1000*777/2) = 777.
    assert_eq!(fee, 777);
}

/// Leaf wildcard-recipient transient is consumable for any recipient.
#[tokio::test]
async fn test_leaf_wildcard_recipient_transient_consumed() {
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
    process_tx(
        &mut banks_client,
        &payer,
        build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address),
        &[],
    )
    .await
    .unwrap();

    // Sign with WILDCARD_RECIPIENT but concrete destination + amount.
    let dest = 42u32;
    let amount = 500u64;
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(dest, WILDCARD_RECIPIENT, amount),
        encode_linear_data(333, 1),
        encode_u48(100),
    );

    process_tx(
        &mut banks_client,
        &payer,
        build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote),
        &[],
    )
    .await
    .unwrap();

    // Consume against an arbitrary concrete recipient — should still match.
    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );
    let arbitrary_recipient = H256::random();
    let quote_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        dest,
        arbitrary_recipient,
        amount,
    );

    let fee = simulate_quote_fee(&mut banks_client, &payer, quote_ix).await;
    // Linear max_fee=333 half_amount=1 amount=500 → min(333, 500*333/2) = 333.
    assert_eq!(fee, 333);
}

/// Leaf wildcard-amount transient is consumable for any amount.
#[tokio::test]
async fn test_leaf_wildcard_amount_transient_consumed() {
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
    process_tx(
        &mut banks_client,
        &payer,
        build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address),
        &[],
    )
    .await
    .unwrap();

    let dest = 42u32;
    let recipient = H256::zero();
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(dest, recipient, WILDCARD_AMOUNT),
        encode_linear_data(200, 1),
        encode_u48(100),
    );

    process_tx(
        &mut banks_client,
        &payer,
        build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote),
        &[],
    )
    .await
    .unwrap();

    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );
    // Consume against an arbitrary concrete amount.
    let arbitrary_amount = 7777u64;
    let quote_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        dest,
        recipient,
        arbitrary_amount,
    );

    let fee = simulate_quote_fee(&mut banks_client, &payer, quote_ix).await;
    assert_eq!(fee, 200);
}

/// Multiple wildcards on the same transient (recipient + amount) all skip equality.
#[tokio::test]
async fn test_leaf_multi_wildcard_transient_consumed() {
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
    process_tx(
        &mut banks_client,
        &payer,
        build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address),
        &[],
    )
    .await
    .unwrap();

    let dest = 42u32;
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(dest, WILDCARD_RECIPIENT, WILDCARD_AMOUNT),
        encode_linear_data(150, 1),
        encode_u48(100),
    );

    process_tx(
        &mut banks_client,
        &payer,
        build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote),
        &[],
    )
    .await
    .unwrap();

    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );
    let quote_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        dest,
        H256::random(),
        12345,
    );

    let fee = simulate_quote_fee(&mut banks_client, &payer, quote_ix).await;
    assert_eq!(fee, 150);
}

/// Concrete (non-wildcard) fields are still strict — mismatch produces
/// `TransientContextMismatch` even when other fields are wildcarded.
#[tokio::test]
async fn test_partial_wildcard_concrete_field_mismatch_rejected() {
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
    process_tx(
        &mut banks_client,
        &payer,
        build_add_quote_signer_ix(&fee_key, &payer.pubkey(), signer_address),
        &[],
    )
    .await
    .unwrap();

    // Concrete dest, wildcard recipient + amount.
    let dest = 42u32;
    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        encode_context(dest, WILDCARD_RECIPIENT, WILDCARD_AMOUNT),
        encode_linear_data(150, 1),
        encode_u48(100),
    );

    process_tx(
        &mut banks_client,
        &payer,
        build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote),
        &[],
    )
    .await
    .unwrap();

    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );
    // Consume against a different concrete destination → strict mismatch on
    // the only concrete field.
    let wrong_dest = 9001u32;
    let quote_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        wrong_dest,
        H256::random(),
        500,
    );
    let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(QuoteValidationError::TransientContextMismatch as u32),
        ),
    );
}

/// C-3: Transient quote with mismatched curve variant must be rejected at QuoteFee.
#[tokio::test]
async fn test_transient_curve_variant_mismatch_rejected() {
    let (mut banks_client, payer) = setup_client().await;
    let signing_key = SigningKey::random(&mut rand::thread_rng());
    let signer_address = eth_address(&signing_key);

    // On-chain uses Linear.
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

    // Submit transient quote with Regressive (mismatched variant).
    let dest = 42u32;
    let recipient = H256::zero();
    let amount = 1000u64;
    let context = encode_context(dest, recipient, amount);
    let data = encode_data(&FeeDataStrategy::Regressive(FeeParams {
        max_fee: 2000,
        half_amount: 1000,
    }));

    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        context,
        data,
        encode_u48(100),
    );
    let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
    process_tx(&mut banks_client, &payer, submit_ix, &[])
        .await
        .unwrap();

    // QuoteFee should fail with CurveVariantMismatch.
    let scoped_salt = quote.compute_scoped_salt(&payer.pubkey());
    let (transient_pda, _) = Pubkey::find_program_address(
        transient_quote_pda_seeds!(fee_key, scoped_salt),
        &fee_program_id(),
    );
    let quote_ix = build_quote_fee_with_transient_ix(
        &fee_key,
        &payer.pubkey(),
        &transient_pda,
        dest,
        recipient,
        amount,
    );
    let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(FeeError::CurveVariantMismatch as u32),
        ),
    );
}

/// M-18: Passing a read-only transient PDA to QuoteFee must fail.
#[tokio::test]
async fn test_readonly_transient_pda_rejected() {
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
    let amount = 1000u64;
    let context = encode_context(dest, recipient, amount);
    let data = encode_linear_data(2000, 1000);

    let quote = make_signed_transient_quote(
        &signing_key,
        &fee_key,
        LOCAL_DOMAIN,
        &payer.pubkey(),
        context,
        data,
        encode_u48(100),
    );
    let submit_ix = build_submit_transient_ix(&fee_key, &payer.pubkey(), &quote);
    process_tx(&mut banks_client, &payer, submit_ix, &[])
        .await
        .unwrap();

    // Build QuoteFee with transient PDA as read-only (not writable).
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
            AccountMeta::new_readonly(fee_key, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(transient_pda, false), // read-only — should fail
            AccountMeta::new_readonly(domain_quotes_pda, false),
            AccountMeta::new_readonly(wildcard_quotes_pda, false),
        ],
    );
    let result = process_tx(&mut banks_client, &payer, quote_ix, &[]).await;
    assert_tx_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidAccountData),
    );
}
