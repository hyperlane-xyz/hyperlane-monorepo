use hyperlane_core::HyperlaneIdentifier;

use super::environment::MockEnvironment;

pub async fn check_intial_environment_state(
    env: &MockEnvironment,
) -> Result<u64, color_eyre::Report> {
    assert_eq!(0, env.origin_mbox_mock.outbound_nonce().await?);
    assert_eq!(
        0,
        env.destination_mbox_mock
            .inbound_unprocessed_nonce()
            .await?
    );

    let starting_block = env.get_block_number().await?;
    assert!(starting_block > 0);

    Ok(starting_block)
}

pub async fn dispatch_message_to_mailbox(env: &MockEnvironment) -> Result<(), color_eyre::Report> {
    // Dummy payload that is easy to spot visually either hex encoded or as raw bytes.
    let mut message: ethers::abi::Bytes = hex::decode("DEADC0FFEEC0DE").unwrap();
    message.extend_from_slice(b"Hello Hyperlane!");

    let recipient_address: HyperlaneIdentifier = env.recipient_address.into();

    env.origin_mbox_mock
        .dispatch(
            env.destination_domain,
            recipient_address.into(),
            message.into(),
        )
        .send()
        .await?
        .confirmations(1)
        .await?;

    Ok(())
}

pub async fn check_end_environment_state(
    env: &MockEnvironment,
    starting_block: u64,
) -> Result<u64, color_eyre::Report> {
    let ending_block = env.get_block_number().await?;
    assert!(ending_block > starting_block);

    assert!(env.origin_mbox_mock.outbound_nonce().await? > 0);
    assert!(
        env.destination_mbox_mock
            .inbound_unprocessed_nonce()
            .await?
            > 0
    );

    Ok(ending_block)
}
