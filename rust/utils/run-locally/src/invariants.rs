// use std::path::Path;

use crate::config::Config;
use maplit::hashmap;

use crate::logging::log;
use crate::{fetch_metric, ZERO_MERKLE_INSERTION_KATHY_MESSAGES};
// use crate::solana::solana_termination_invariants_met;

// This number should be even, so the messages can be split into two equal halves
// sent before and after the relayer spins up, to avoid rounding errors.
pub const SOL_MESSAGES_EXPECTED: u32 = 0;

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
pub fn termination_invariants_met(
    config: &Config,
    // solana_cli_tools_path: &Path,
    // solana_config_path: &Path,
) -> eyre::Result<bool> {
    let eth_messages_expected = (config.kathy_messages / 2) as u32 * 2;
    let total_messages_expected = eth_messages_expected + SOL_MESSAGES_EXPECTED;

    let lengths = fetch_metric("9092", "hyperlane_submitter_queue_length", &hashmap! {})?;
    assert!(!lengths.is_empty(), "Could not find queue length metric");
    if lengths.iter().sum::<u32>() != ZERO_MERKLE_INSERTION_KATHY_MESSAGES {
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

    let gas_payment_sealevel_events_count = fetch_metric(
        "9092",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {
                "data_type" => "gas_payments",
                "chain" => "sealeveltest",
        },
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

    // if !solana_termination_invariants_met(solana_cli_tools_path, solana_config_path) {
    //     log!("Solana termination invariants not met");
    //     return Ok(false);
    // }

    let dispatched_messages_scraped = fetch_metric(
        "9093",
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_dispatch"},
    )?
    .iter()
    .sum::<u32>();
    if dispatched_messages_scraped != eth_messages_expected + ZERO_MERKLE_INSERTION_KATHY_MESSAGES {
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
    // TODO: Sealevel gas payments are not yet included in the event count.
    // For now, treat as an exception in the invariants.
    let expected_gas_payments = gas_payment_events_count - gas_payment_sealevel_events_count;
    if gas_payments_scraped != expected_gas_payments {
        log!(
            "Scraper has scraped {} gas payments, expected {}",
            gas_payments_scraped,
            expected_gas_payments
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
