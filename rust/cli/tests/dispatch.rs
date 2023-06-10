use cli::mock::environment::MockEnvironment;
use cli::mock::helpers;
use cli::{action::dispatch, core};
use color_eyre::Result;
use ethers::providers::Middleware;

#[tokio::test]
async fn test_message_dispatch() -> Result<()> {
    let env = MockEnvironment::new().await?;

    let starting_block = helpers::check_intial_environment_state(&env).await?;

    let message = b"Hello Hyperlane!";

    let (provider, chain_id) = core::get_provider(env.rpc_url.clone()).await?;
    let sender_wallet = core::get_wallet(env.sender_key, chain_id)?;
    let client = core::get_client(provider, sender_wallet.clone());

    dispatch(
        client,
        env.mailbox_address,
        env.destination_domain,
        env.recipient_address,
        message.to_vec(),
        false,
    )
    .await?;

    let ending_block = helpers::check_end_environment_state(&env, starting_block).await?;

    // TODO: Check message appears in logs.
    check_logs_contain_dispatched_message(env, starting_block, ending_block).await?;

    Ok(())
}

/// Check mock environment behaviour. Also demos how to use the mock environment.
#[tokio::test]
async fn test_operation_of_mock_environment() -> Result<()> {
    let env = MockEnvironment::new().await?;

    let starting_block = helpers::check_intial_environment_state(&env).await?;
    helpers::dispatch_message_to_mailbox(&env).await?;
    let ending_block = helpers::check_end_environment_state(&env, starting_block).await?;

    check_logs_contain_dispatched_message(env, starting_block, ending_block).await?;

    Ok(())
}

pub async fn check_logs_contain_dispatched_message(
    env: MockEnvironment,
    starting_block: u64,
    ending_block: u64,
) -> Result<(), color_eyre::Report> {
    let event = env.origin_mbox_mock.dispatch_filter();

    let filter = event
        .filter
        .from_block(starting_block)
        .to_block(ending_block);
    let logs = env.origin_mbox_mock.client().get_logs(&filter).await?;
    assert_eq!(1, logs.len());

    Ok(())
}
