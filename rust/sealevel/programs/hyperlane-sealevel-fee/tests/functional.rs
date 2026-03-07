//! Functional tests for the fee program.
//! Tests CPI-based operations (PDA creation) that cannot be done in unit tests.

use hyperlane_core::H256;
use hyperlane_sealevel_fee::{
    accounts::{FeeAccount, FeeAccountData, FeeData, RouteDomainData},
    fee::compute_fee,
    fee_route_pda_seeds,
    instruction::{
        init_fee_instruction, quote_fee_instruction, remove_route_instruction,
        set_beneficiary_instruction, set_route_instruction, transfer_ownership_instruction,
        update_fee_data_instruction,
    },
    processor::process_instruction as fee_process_instruction,
};
use hyperlane_test_utils::{
    assert_transaction_error, new_funded_keypair, process_instruction as process_instruction_helper,
};
use solana_program::{instruction::AccountMeta, pubkey, pubkey::Pubkey};
use solana_program_test::*;
use solana_sdk::{
    instruction::InstructionError,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

const ONE_SOL_IN_LAMPORTS: u64 = 1_000_000_000;

fn fee_program_id() -> Pubkey {
    pubkey!("FEEaJQp2jSHEkM5njByhKfK7fZoz3kJpk4MaJoYBe1t5")
}

fn setup_program_test() -> ProgramTest {
    let program_id = fee_program_id();
    ProgramTest::new(
        "hyperlane_sealevel_fee",
        program_id,
        processor!(fee_process_instruction),
    )
}

async fn setup_client() -> (BanksClient, Keypair) {
    let program_test = setup_program_test();
    let (banks_client, payer, _recent_blockhash) = program_test.start().await;
    (banks_client, payer)
}

/// Helper: init a fee account with the given fee_data.
async fn init_fee(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    salt: H256,
    beneficiary: Pubkey,
    fee_data: FeeData,
) -> Result<Pubkey, BanksClientError> {
    let ixn = init_fee_instruction(
        fee_program_id(),
        payer.pubkey(),
        salt,
        beneficiary,
        fee_data,
    )
    .unwrap();
    let fee_key = ixn.accounts[1].pubkey;
    process_instruction_helper(banks_client, ixn, payer, &[payer]).await?;
    Ok(fee_key)
}

/// Helper: fetch and deserialize a fee account.
async fn fetch_fee_account(banks_client: &mut BanksClient, fee_key: &Pubkey) -> FeeAccount {
    let data = banks_client
        .get_account(*fee_key)
        .await
        .unwrap()
        .unwrap()
        .data;
    FeeAccountData::fetch(&mut &data[..])
        .unwrap()
        .into_inner()
        .data
}

// ---- Init tests ----

#[tokio::test]
async fn test_init_linear_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let salt = H256::zero();
    let fee_data = FeeData::Linear {
        max_fee: 1_000_000,
        half_amount: 500_000,
    };
    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        fee_data.clone(),
    )
    .await
    .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.header.owner, Some(payer.pubkey()));
    assert_eq!(fee_account.header.beneficiary, payer.pubkey());
    assert_eq!(fee_account.fee_data, fee_data);
}

#[tokio::test]
async fn test_init_regressive_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let salt = H256::from_low_u64_be(1);
    let fee_data = FeeData::Regressive {
        max_fee: 2_000_000,
        half_amount: 1_000_000,
    };
    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        fee_data.clone(),
    )
    .await
    .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.fee_data, fee_data);
}

#[tokio::test]
async fn test_init_progressive_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let salt = H256::from_low_u64_be(2);
    let fee_data = FeeData::Progressive {
        max_fee: 5_000_000,
        half_amount: 2_500_000,
    };
    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        fee_data.clone(),
    )
    .await
    .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.fee_data, fee_data);
}

#[tokio::test]
async fn test_init_routing_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let salt = H256::from_low_u64_be(3);
    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.fee_data, FeeData::Routing);
}

#[tokio::test]
async fn test_init_errors_if_called_twice() {
    let (mut banks_client, payer) = setup_client().await;
    let salt = H256::zero();
    let fee_data = FeeData::Linear {
        max_fee: 100,
        half_amount: 50,
    };
    init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        fee_data.clone(),
    )
    .await
    .unwrap();

    let new_payer = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let result = init_fee(
        &mut banks_client,
        &new_payer,
        salt,
        new_payer.pubkey(),
        fee_data,
    )
    .await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::Custom(6)), // AlreadyInitialized
    );
}

#[tokio::test]
async fn test_different_salts_create_different_accounts() {
    let (mut banks_client, payer) = setup_client().await;
    let fee_data = FeeData::Linear {
        max_fee: 100,
        half_amount: 50,
    };
    let key1 = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        fee_data.clone(),
    )
    .await
    .unwrap();
    let key2 = init_fee(
        &mut banks_client,
        &payer,
        H256::from_low_u64_be(1),
        payer.pubkey(),
        fee_data,
    )
    .await
    .unwrap();
    assert_ne!(key1, key2);
}

// ---- SetRoute / RemoveRoute tests ----

#[tokio::test]
async fn test_set_route() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    // Init a routing fee account
    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    // Set route for domain 42 with inlined Linear fee
    let domain = 42u32;
    let route_fee_data = FeeData::Linear {
        max_fee: 1_000_000,
        half_amount: 500_000,
    };
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        domain,
        route_fee_data.clone(),
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Verify route PDA was created
    let (route_pda, _) =
        Pubkey::find_program_address(fee_route_pda_seeds!(fee_key, domain), &program_id);
    let route_data = banks_client
        .get_account(route_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let route = RouteDomainData::fetch(&mut &route_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(route.fee_data, route_fee_data);
}

#[tokio::test]
async fn test_set_route_errors_if_not_routing_type() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    // Init a linear fee account (not routing)
    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        42,
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .unwrap();
    let result = process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::Custom(0)), // NotRoutingFee
    );
}

#[tokio::test]
async fn test_set_route_errors_if_nested_routing() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    let ixn =
        set_route_instruction(program_id, payer.pubkey(), fee_key, 42, FeeData::Routing).unwrap();
    let result = process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::Custom(8)), // NestedRoutingNotSupported
    );
}

#[tokio::test]
async fn test_set_route_errors_if_not_owner() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let ixn = set_route_instruction(
        program_id,
        non_owner.pubkey(),
        fee_key,
        42,
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .unwrap();
    let result =
        process_instruction_helper(&mut banks_client, ixn, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_remove_route() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    let domain = 42u32;

    // Set route
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        domain,
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Remove route
    let ixn = remove_route_instruction(program_id, payer.pubkey(), fee_key, domain).unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Verify route PDA is gone (zeroed)
    let (route_pda, _) =
        Pubkey::find_program_address(fee_route_pda_seeds!(fee_key, domain), &program_id);
    let route_account = banks_client.get_account(route_pda).await.unwrap();
    // Account should be zeroed or gone
    match route_account {
        None => {} // Account was reclaimed
        Some(acct) => {
            assert!(acct.data.iter().all(|b| *b == 0));
        }
    }
}

// ---- UpdateFeeData tests ----

#[tokio::test]
async fn test_update_fee_data() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let new_fee_data = FeeData::Regressive {
        max_fee: 999,
        half_amount: 123,
    };
    let ixn =
        update_fee_data_instruction(program_id, payer.pubkey(), fee_key, new_fee_data.clone())
            .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.fee_data, new_fee_data);
}

#[tokio::test]
async fn test_update_fee_data_errors_if_not_owner() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let ixn = update_fee_data_instruction(
        program_id,
        non_owner.pubkey(),
        fee_key,
        FeeData::Linear {
            max_fee: 999,
            half_amount: 1,
        },
    )
    .unwrap();
    let result =
        process_instruction_helper(&mut banks_client, ixn, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

// ---- TransferOwnership tests ----

#[tokio::test]
async fn test_transfer_ownership() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let new_owner = Pubkey::new_unique();
    let ixn = transfer_ownership_instruction(program_id, payer.pubkey(), fee_key, Some(new_owner))
        .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.header.owner, Some(new_owner));
}

#[tokio::test]
async fn test_transfer_ownership_to_none() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let ixn = transfer_ownership_instruction(program_id, payer.pubkey(), fee_key, None).unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.header.owner, None);
}

#[tokio::test]
async fn test_transfer_ownership_errors_if_not_owner() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let ixn = transfer_ownership_instruction(
        program_id,
        non_owner.pubkey(),
        fee_key,
        Some(non_owner.pubkey()),
    )
    .unwrap();
    let result =
        process_instruction_helper(&mut banks_client, ixn, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

// ---- QuoteFee tests ----

#[tokio::test]
async fn test_quote_linear_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();
    let max_fee = 1_000_000u64;
    let half_amount = 500_000u64;

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee,
            half_amount,
        },
    )
    .await
    .unwrap();

    let amount = 500_000u64;
    let expected = compute_fee(
        &FeeData::Linear {
            max_fee,
            half_amount,
        },
        amount,
    )
    .unwrap();

    let ixn = quote_fee_instruction(program_id, fee_key, 0, amount, vec![]).unwrap();

    // Simulate to get return data
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(
            solana_sdk::message::Message::new_with_blockhash(
                &[ixn],
                Some(&payer.pubkey()),
                &recent_blockhash,
            ),
        ))
        .await
        .unwrap();

    assert!(simulation.result.unwrap().is_ok());
    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let fee = u64::from_le_bytes(return_data[..8].try_into().unwrap());
    assert_eq!(fee, expected);
    assert!(fee > 0);
}

#[tokio::test]
async fn test_quote_regressive_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let salt = H256::zero();
    let max_fee = 2_000_000u64;
    let half_amount = 1_000_000u64;

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Regressive {
            max_fee,
            half_amount,
        },
    )
    .await
    .unwrap();

    let amount = 1_000_000u64;
    let expected = compute_fee(
        &FeeData::Regressive {
            max_fee,
            half_amount,
        },
        amount,
    )
    .unwrap();

    let ixn = quote_fee_instruction(fee_program_id(), fee_key, 0, amount, vec![]).unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(
            solana_sdk::message::Message::new_with_blockhash(
                &[ixn],
                Some(&payer.pubkey()),
                &recent_blockhash,
            ),
        ))
        .await
        .unwrap();

    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let fee = u64::from_le_bytes(return_data[..8].try_into().unwrap());
    assert_eq!(fee, expected);
    // Regressive at half_amount should be max_fee/2
    assert_eq!(fee, max_fee / 2);
}

#[tokio::test]
async fn test_quote_progressive_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let salt = H256::zero();
    let max_fee = 5_000_000u64;
    let half_amount = 1_000_000u64;

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Progressive {
            max_fee,
            half_amount,
        },
    )
    .await
    .unwrap();

    let amount = 1_000_000u64;
    let expected = compute_fee(
        &FeeData::Progressive {
            max_fee,
            half_amount,
        },
        amount,
    )
    .unwrap();

    let ixn = quote_fee_instruction(fee_program_id(), fee_key, 0, amount, vec![]).unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(
            solana_sdk::message::Message::new_with_blockhash(
                &[ixn],
                Some(&payer.pubkey()),
                &recent_blockhash,
            ),
        ))
        .await
        .unwrap();

    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let fee = u64::from_le_bytes(return_data[..8].try_into().unwrap());
    assert_eq!(fee, expected);
    // Progressive at half_amount should be max_fee/2
    assert_eq!(fee, max_fee / 2);
}

#[tokio::test]
async fn test_quote_zero_amount_returns_zero_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 1_000_000,
            half_amount: 500_000,
        },
    )
    .await
    .unwrap();

    let ixn = quote_fee_instruction(fee_program_id(), fee_key, 0, 0, vec![]).unwrap();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(
            solana_sdk::message::Message::new_with_blockhash(
                &[ixn],
                Some(&payer.pubkey()),
                &recent_blockhash,
            ),
        ))
        .await
        .unwrap();

    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let fee = u64::from_le_bytes(return_data[..8].try_into().unwrap());
    assert_eq!(fee, 0);
}

#[tokio::test]
async fn test_quote_routing_fee() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    // Create routing fee account
    let routing_salt = H256::zero();
    let routing_fee_key = init_fee(
        &mut banks_client,
        &payer,
        routing_salt,
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    // Set route for domain 42 with inlined Linear fee
    let domain = 42u32;
    let max_fee = 1_000_000u64;
    let half_amount = 500_000u64;
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        routing_fee_key,
        domain,
        FeeData::Linear {
            max_fee,
            half_amount,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Quote: only need route PDA as additional account
    let (route_pda, _) =
        Pubkey::find_program_address(fee_route_pda_seeds!(routing_fee_key, domain), &program_id);

    let amount = 500_000u64;
    let ixn = quote_fee_instruction(
        program_id,
        routing_fee_key,
        domain,
        amount,
        vec![AccountMeta::new_readonly(route_pda, false)],
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(
            solana_sdk::message::Message::new_with_blockhash(
                &[ixn],
                Some(&payer.pubkey()),
                &recent_blockhash,
            ),
        ))
        .await
        .unwrap();

    assert!(simulation.result.unwrap().is_ok());
    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let fee = u64::from_le_bytes(return_data[..8].try_into().unwrap());
    let expected = compute_fee(
        &FeeData::Linear {
            max_fee,
            half_amount,
        },
        amount,
    )
    .unwrap();
    assert_eq!(fee, expected);
    assert!(fee > 0);
}

#[tokio::test]
async fn test_quote_routing_fee_unset_domain_returns_zero() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let routing_salt = H256::zero();
    let routing_fee_key = init_fee(
        &mut banks_client,
        &payer,
        routing_salt,
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    // Query for domain 99 which has no route set.
    // The route PDA will be uninitialized.
    let domain = 99u32;
    let (route_pda, _) =
        Pubkey::find_program_address(fee_route_pda_seeds!(routing_fee_key, domain), &program_id);

    let ixn = quote_fee_instruction(
        program_id,
        routing_fee_key,
        domain,
        500_000,
        vec![AccountMeta::new_readonly(route_pda, false)],
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(
            solana_sdk::message::Message::new_with_blockhash(
                &[ixn],
                Some(&payer.pubkey()),
                &recent_blockhash,
            ),
        ))
        .await
        .unwrap();

    assert!(simulation.result.unwrap().is_ok());
    let return_data = simulation
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;
    let fee = u64::from_le_bytes(return_data[..8].try_into().unwrap());
    assert_eq!(fee, 0);
}

// ---- Update route (overwrite) ----

#[tokio::test]
async fn test_set_route_overwrites_existing() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let routing_fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    let domain = 42u32;
    let first_fee_data = FeeData::Linear {
        max_fee: 100,
        half_amount: 50,
    };
    let second_fee_data = FeeData::Regressive {
        max_fee: 200,
        half_amount: 100,
    };

    // Set first route
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        routing_fee_key,
        domain,
        first_fee_data,
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Overwrite with second route
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        routing_fee_key,
        domain,
        second_fee_data.clone(),
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Verify updated
    let (route_pda, _) =
        Pubkey::find_program_address(fee_route_pda_seeds!(routing_fee_key, domain), &program_id);
    let route_data = banks_client
        .get_account(route_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let route = RouteDomainData::fetch(&mut &route_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(route.fee_data, second_fee_data);
}

// ---- Remove then recreate route ----

#[tokio::test]
async fn test_remove_route_then_recreate() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let routing_fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    let domain = 42u32;

    // Set route
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        routing_fee_key,
        domain,
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Remove route
    let ixn =
        remove_route_instruction(program_id, payer.pubkey(), routing_fee_key, domain).unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Re-create route for the same domain with different fee data
    let new_fee_data = FeeData::Regressive {
        max_fee: 200,
        half_amount: 100,
    };
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        routing_fee_key,
        domain,
        new_fee_data.clone(),
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Verify the re-created route has the new fee data
    let (route_pda, _) =
        Pubkey::find_program_address(fee_route_pda_seeds!(routing_fee_key, domain), &program_id);
    let route_data = banks_client
        .get_account(route_pda)
        .await
        .unwrap()
        .unwrap()
        .data;
    let route = RouteDomainData::fetch(&mut &route_data[..])
        .unwrap()
        .into_inner();
    assert_eq!(route.fee_data, new_fee_data);
}

// ---- RemoveRoute error cases ----

#[tokio::test]
async fn test_remove_route_errors_if_not_owner() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    let domain = 42u32;
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        domain,
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    // Build remove instruction manually with non_owner as signer
    let ixn = remove_route_instruction(program_id, non_owner.pubkey(), fee_key, domain).unwrap();
    let result =
        process_instruction_helper(&mut banks_client, ixn, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

#[tokio::test]
async fn test_remove_route_errors_if_not_routing_type() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    // Init a linear fee account (not routing)
    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let ixn = remove_route_instruction(program_id, payer.pubkey(), fee_key, 42).unwrap();
    let result = process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::Custom(0)), // NotRoutingFee
    );
}

// ---- Ownership lockout tests ----

#[tokio::test]
async fn test_old_owner_locked_out_after_transfer() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    // Transfer to a new owner
    let new_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let ixn = transfer_ownership_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        Some(new_owner.pubkey()),
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Old owner tries to update fee data — should fail
    let ixn = update_fee_data_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        FeeData::Regressive {
            max_fee: 999,
            half_amount: 1,
        },
    )
    .unwrap();
    let result = process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );

    // New owner can update fee data
    let ixn = update_fee_data_instruction(
        program_id,
        new_owner.pubkey(),
        fee_key,
        FeeData::Regressive {
            max_fee: 999,
            half_amount: 1,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &new_owner, &[&new_owner])
        .await
        .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(
        fee_account.fee_data,
        FeeData::Regressive {
            max_fee: 999,
            half_amount: 1,
        }
    );
}

#[tokio::test]
async fn test_renounced_ownership_is_immutable() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    // Renounce ownership
    let ixn = transfer_ownership_instruction(program_id, payer.pubkey(), fee_key, None).unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Try to update fee data — should fail (no owner)
    let ixn = update_fee_data_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        FeeData::Regressive {
            max_fee: 999,
            half_amount: 1,
        },
    )
    .unwrap();
    let result = process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );

    // Try to transfer ownership back — should also fail
    let ixn =
        transfer_ownership_instruction(program_id, payer.pubkey(), fee_key, Some(payer.pubkey()))
            .unwrap();
    let result = process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

// ---- UpdateFeeData with realloc ----

#[tokio::test]
async fn test_update_fee_data_with_size_change() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    // Init as Linear (has max_fee + half_amount = 16 bytes of variant data)
    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    // Update to Routing (0 bytes of variant data — smaller)
    let ixn =
        update_fee_data_instruction(program_id, payer.pubkey(), fee_key, FeeData::Routing).unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.fee_data, FeeData::Routing);

    // Update from Routing back to Progressive (larger)
    let ixn = update_fee_data_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        FeeData::Progressive {
            max_fee: 500,
            half_amount: 250,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(
        fee_account.fee_data,
        FeeData::Progressive {
            max_fee: 500,
            half_amount: 250,
        }
    );
}

// ---- QuoteFee routing error cases ----

#[tokio::test]
async fn test_quote_routing_fee_wrong_route_pda() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let routing_fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    // Set route for domain 42
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        routing_fee_key,
        42,
        FeeData::Linear {
            max_fee: 1000,
            half_amount: 500,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Quote with wrong route PDA (derive for domain 99 instead of 42)
    let (wrong_route_pda, _) =
        Pubkey::find_program_address(fee_route_pda_seeds!(routing_fee_key, 99u32), &program_id);

    let ixn = quote_fee_instruction(
        program_id,
        routing_fee_key,
        42, // asking for domain 42 but passing domain 99's PDA
        500_000,
        vec![AccountMeta::new_readonly(wrong_route_pda, false)],
    )
    .unwrap();

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let simulation = banks_client
        .simulate_transaction(Transaction::new_unsigned(
            solana_sdk::message::Message::new_with_blockhash(
                &[ixn],
                Some(&payer.pubkey()),
                &recent_blockhash,
            ),
        ))
        .await
        .unwrap();

    // Should fail with InvalidRouteDomainPda (Custom(5))
    let result = simulation.result.unwrap();
    assert!(result.is_err());
}

// ---- SetBeneficiary tests ----

#[tokio::test]
async fn test_set_beneficiary() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    // Verify initial beneficiary
    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.header.beneficiary, payer.pubkey());

    // Set new beneficiary
    let new_beneficiary = Pubkey::new_unique();
    let ixn =
        set_beneficiary_instruction(program_id, payer.pubkey(), fee_key, new_beneficiary).unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    // Verify updated beneficiary
    let fee_account = fetch_fee_account(&mut banks_client, &fee_key).await;
    assert_eq!(fee_account.header.beneficiary, new_beneficiary);
}

#[tokio::test]
async fn test_set_beneficiary_errors_if_not_owner() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();
    let salt = H256::zero();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        salt,
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let non_owner = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;
    let new_beneficiary = Pubkey::new_unique();
    let ixn = set_beneficiary_instruction(program_id, non_owner.pubkey(), fee_key, new_beneficiary)
        .unwrap();
    let result =
        process_instruction_helper(&mut banks_client, ixn, &non_owner, &[&non_owner]).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::InvalidArgument),
    );
}

// ---- Owner-not-signer tests ----
// These verify that passing the correct owner pubkey but NOT as a signer fails
// with MissingRequiredSignature (as opposed to InvalidArgument for wrong owner).

/// Helper: build an instruction with the owner account as non-signer.
/// Uses the instruction builder, then flips `is_signer` to false on the owner account.
fn make_owner_non_signer(
    mut ixn: solana_program::instruction::Instruction,
    owner: &Pubkey,
) -> solana_program::instruction::Instruction {
    for meta in ixn.accounts.iter_mut() {
        if &meta.pubkey == owner {
            meta.is_signer = false;
        }
    }
    ixn
}

#[tokio::test]
async fn test_set_route_errors_if_owner_not_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    let other = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    // Build instruction with correct owner but flip is_signer to false
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        42,
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .unwrap();
    let ixn = make_owner_non_signer(ixn, &payer.pubkey());

    // Sign with `other` as payer only
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&other.pubkey()),
        &[&other],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_remove_route_errors_if_owner_not_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Routing,
    )
    .await
    .unwrap();

    // Set a route first
    let ixn = set_route_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        42,
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .unwrap();
    process_instruction_helper(&mut banks_client, ixn, &payer, &[&payer])
        .await
        .unwrap();

    let other = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    let ixn = remove_route_instruction(program_id, payer.pubkey(), fee_key, 42).unwrap();
    let ixn = make_owner_non_signer(ixn, &payer.pubkey());

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&other.pubkey()),
        &[&other],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_update_fee_data_errors_if_owner_not_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let other = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    let ixn = update_fee_data_instruction(
        program_id,
        payer.pubkey(),
        fee_key,
        FeeData::Regressive {
            max_fee: 999,
            half_amount: 1,
        },
    )
    .unwrap();
    let ixn = make_owner_non_signer(ixn, &payer.pubkey());

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&other.pubkey()),
        &[&other],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_set_beneficiary_errors_if_owner_not_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let other = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    let ixn =
        set_beneficiary_instruction(program_id, payer.pubkey(), fee_key, Pubkey::new_unique())
            .unwrap();
    let ixn = make_owner_non_signer(ixn, &payer.pubkey());

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&other.pubkey()),
        &[&other],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}

#[tokio::test]
async fn test_transfer_ownership_errors_if_owner_not_signer() {
    let (mut banks_client, payer) = setup_client().await;
    let program_id = fee_program_id();

    let fee_key = init_fee(
        &mut banks_client,
        &payer,
        H256::zero(),
        payer.pubkey(),
        FeeData::Linear {
            max_fee: 100,
            half_amount: 50,
        },
    )
    .await
    .unwrap();

    let other = new_funded_keypair(&mut banks_client, &payer, ONE_SOL_IN_LAMPORTS).await;

    let ixn =
        transfer_ownership_instruction(program_id, payer.pubkey(), fee_key, Some(other.pubkey()))
            .unwrap();
    let ixn = make_owner_non_signer(ixn, &payer.pubkey());

    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[ixn],
        Some(&other.pubkey()),
        &[&other],
        recent_blockhash,
    );
    let result = banks_client.process_transaction(transaction).await;
    assert_transaction_error(
        result,
        TransactionError::InstructionError(0, InstructionError::MissingRequiredSignature),
    );
}
