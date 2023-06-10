use cli::mock::{environment::MockEnvironment, helpers};
use color_eyre::Result;
use ethers::{
    prelude::k256::{elliptic_curve::SecretKey, Secp256k1},
    providers::Middleware,
    signers::{LocalWallet, Signer},
};
use hyperlane_core::{H160, H256};

#[tokio::test]
async fn test_log_item_matching() -> Result<()> {
    let env = MockEnvironment::new().await?;

    let starting_block = helpers::check_intial_environment_state(&env).await?;
    helpers::dispatch_message_to_mailbox(&env).await?;
    helpers::dispatch_message_to_mailbox(&env).await?;
    helpers::dispatch_message_to_mailbox(&env).await?;
    let ending_block = helpers::check_end_environment_state(&env, starting_block).await?;

    // println!("{env:#?}");

    // let wallet: LocalWallet = env.sender_key.into();
    let secret = SecretKey::<Secp256k1>::from_slice(env.sender_key.as_bytes())?;
    let wallet: LocalWallet = secret.into();
    let address = wallet.address();

    check_dispatched_message_match(
        &env,
        starting_block,
        ending_block,
        Some(vec![address.into(), env.recipient_address.into()]),
        Some(vec![env.recipient_address.into()]),
        Some(vec![H256::from_low_u64_be(env.destination_domain.into())]),
    )
    .await?;

    // println!(
    //     "{:?}:{:?}:{}:{:?}",
    //     env.origin_domain, address, env.destination_domain, &env.recipient_address
    // );

    assert!(false);

    Ok(())
}

async fn check_dispatched_message_match(
    env: &MockEnvironment,
    starting_block: u64,
    ending_block: u64,
    senders: Option<Vec<H256>>,
    recievers: Option<Vec<H256>>,
    chains: Option<Vec<H256>>,
) -> Result<(), color_eyre::Report> {
    let event = env.origin_mbox_mock.dispatch_filter();

    let mut filter = event
        .filter
        .from_block(starting_block)
        .to_block(ending_block);

    if let Some(senders) = senders {
        if !senders.is_empty() {
            filter = filter.topic1(senders);
        }
    };

    if let Some(chains) = chains {
        if !chains.is_empty() {
            filter = filter.topic2(chains);
        }
    };

    if let Some(recievers) = recievers {
        if !recievers.is_empty() {
            filter = filter.topic3(recievers);
        }
    };

    let logs = env.origin_mbox_mock.client().get_logs(&filter).await?;

    for log in &logs {
        // println!("{:#?}", log);
        let block = if let Some(block) = log.block_number {
            block.to_string()
        } else {
            "None".to_string()
        };

        let tx = if let Some(tx) = log.transaction_hash {
            format!("{tx:#?}")
        } else {
            "None".to_string()
        };

        let sender: H160 = log.topics[1].into();
        let recipient: H160 = log.topics[3].into();

        println!("Block {block}, tx {tx}");
        println!("  {sender:#?} -> {recipient:#?}");
        println!("  {}", log.data);
    }
    // println!("{:#?}", logs);

    // assert_eq!(1, logs.len());

    Ok(())
}
