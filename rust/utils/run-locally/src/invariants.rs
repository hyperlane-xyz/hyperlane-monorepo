use std::fs::File;
use std::path::Path;

use crate::config::Config;
use crate::metrics::agent_balance_sum;
use crate::utils::get_matching_lines;
use maplit::hashmap;
use relayer::GAS_EXPENDITURE_LOG_MESSAGE;

use crate::logging::log;
use crate::solana::solana_termination_invariants_met;
use crate::{fetch_metric, AGENT_LOGGING_DIR, ZERO_MERKLE_INSERTION_KATHY_MESSAGES};

// This number should be even, so the messages can be split into two equal halves
// sent before and after the relayer spins up, to avoid rounding errors.
pub const SOL_MESSAGES_EXPECTED: u32 = 20;

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
pub fn termination_invariants_met(
    config: &Config,
    starting_relayer_balance: f64,
    solana_cli_tools_path: Option<&Path>,
    solana_config_path: Option<&Path>,
) -> eyre::Result<bool> {
    let eth_messages_expected = (config.kathy_messages / 2) as u32 * 2;
    let sol_messages_expected = if config.sealevel_enabled {
        SOL_MESSAGES_EXPECTED
    } else {
        0
    };
    let total_messages_expected = eth_messages_expected + sol_messages_expected;

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

    let log_file_path = AGENT_LOGGING_DIR.join("RLY-output.log");
    let relayer_logfile = File::open(log_file_path)?;
    let gas_expenditure_log_count =
        get_matching_lines(&relayer_logfile, GAS_EXPENDITURE_LOG_MESSAGE)
            .unwrap()
            .len();

    // Zero insertion messages don't reach `submit` stage where gas is spent, so we only expect these logs for the other messages.
    // TODO: Sometimes we find more logs than expected. This may either mean that gas is deducted twice for the same message due to a bug,
    // or that submitting the message transaction fails for some messages. Figure out which is the case and convert this check to
    // strict equality.
    // EDIT: Having had a quick look, it seems like there are some legitimate reverts happening in the confirm step
    // (`Transaction attempting to process message either reverted or was reorged`)
    // in which case more gas expenditure logs than messages are expected.
    assert!(
        gas_expenditure_log_count as u32 >= total_messages_expected,
        "Didn't record gas payment for all delivered messages"
    );

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

    if let Some((solana_cli_tools_path, solana_config_path)) =
        solana_cli_tools_path.zip(solana_config_path)
    {
        if !solana_termination_invariants_met(solana_cli_tools_path, solana_config_path) {
            log!("Solana termination invariants not met");
            return Ok(false);
        }
    }

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

    let ending_relayer_balance: f64 = agent_balance_sum(9092).unwrap();
    // Make sure the balance was correctly updated in the metrics.
    if starting_relayer_balance <= ending_relayer_balance {
        log!(
            "Expected starting relayer balance to be greater than ending relayer balance, but got {} <= {}",
            starting_relayer_balance,
            ending_relayer_balance
        );
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}
