use std::path::Path;

use crate::config::Config;
use maplit::hashmap;

use crate::fetch_metric;
use crate::logging::log;
use crate::solana::solana_termination_invariants_met;

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
pub fn termination_invariants_met(
    config: &Config,
    solana_cli_tools_path: &Path,
    solana_config_path: &Path,
) -> eyre::Result<bool> {
    let eth_messages_expected = (config.kathy_messages / 2) as u32 * 2;
    let sol_messages_expected = 1;
    let total_messages_expected = eth_messages_expected + sol_messages_expected;

    let lengths = fetch_metric("9092", "hyperlane_submitter_queue_length", &hashmap! {})?;
    assert!(!lengths.is_empty(), "Could not find queue length metric");
    if lengths.iter().any(|n| *n != 0) {
        log!("Relayer queues not empty. Lengths: {:?}", lengths);
        return Ok(false);
    };

    // Also ensure the counter is as expected (total number of messages), summed
    // across all mailboxes.
    let msg_processed_count =
        fetch_metric("9092", "hyperlane_messages_processed_count", &hashmap! {})?
            .iter()
            .sum::<u32>();
    if msg_processed_count != total_messages_expected {
        log!(
            "Relayer has {} processed messages, expected {}",
            msg_processed_count,
            total_messages_expected
        );
        return Ok(false);
    }

    let gas_payment_events_count = fetch_metric(
        "9092",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payments"},
    )?
    .iter()
    .sum::<u32>();
    // TestSendReceiver randomly breaks gas payments up into
    // two. So we expect at least as many gas payments as messages.
    if gas_payment_events_count < total_messages_expected {
        log!(
            "Relayer has {} gas payment events, expected at least {}",
            gas_payment_events_count,
            total_messages_expected
        );
        return Ok(false);
    }

    if !solana_termination_invariants_met(solana_cli_tools_path, solana_config_path) {
        log!("Solana termination invariants not met");
        return Ok(false);
    }

    let dispatched_messages_scraped = fetch_metric(
        "9093",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_dispatch"},
    )?
    .iter()
    .sum::<u32>();
    if dispatched_messages_scraped != eth_messages_expected {
        log!(
            "Scraper has scraped {} dispatched messages, expected {}",
            dispatched_messages_scraped,
            eth_messages_expected
        );
        return Ok(false);
    }

    let gas_payments_scraped = fetch_metric(
        "9093",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    // The relayer and scraper should have the same number of gas payments.
    if gas_payments_scraped != gas_payment_events_count {
        log!(
            "Scraper has scraped {} gas payments, expected {}",
            gas_payments_scraped,
            eth_messages_expected
        );
        return Ok(false);
    }

    let delivered_messages_scraped = fetch_metric(
        "9093",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_delivery"},
    )?
    .iter()
    .sum::<u32>();
    if delivered_messages_scraped != eth_messages_expected {
        log!(
            "Scraper has scraped {} delivered messages, expected {}",
            delivered_messages_scraped,
            eth_messages_expected
        );
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}
