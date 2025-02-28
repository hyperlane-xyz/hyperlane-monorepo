use std::fs::File;

use crate::config::Config;
use crate::metrics::agent_balance_sum;
use crate::server::{fetch_relayer_gas_payment_event_count, fetch_relayer_message_processed_count};
use crate::utils::get_matching_lines;
use maplit::hashmap;
use relayer::GAS_EXPENDITURE_LOG_MESSAGE;

use crate::logging::log;
use crate::{
    fetch_metric, AGENT_LOGGING_DIR, RELAYER_METRICS_PORT, SCRAPER_METRICS_PORT,
    ZERO_MERKLE_INSERTION_KATHY_MESSAGES,
};

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
#[allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue
pub fn termination_invariants_met(
    config: &Config,
    starting_relayer_balance: f64,
) -> eyre::Result<bool> {
    let eth_messages_expected = (config.kathy_messages / 2) as u32 * 2;

    // this is total messages expected to be delivered
    let total_messages_expected = eth_messages_expected;

    // Also ensure the counter is as expected (total number of messages), summed
    // across all mailboxes.
    let msg_processed_count = fetch_relayer_message_processed_count()?;
    let gas_payment_events_count = fetch_relayer_gas_payment_event_count()?;

    let params = RelayerTerminationInvariantParams {
        config,
        starting_relayer_balance,
        msg_processed_count,
        gas_payment_events_count,
        total_messages_expected,
        total_messages_dispatched: total_messages_expected,
        submitter_queue_length_expected: ZERO_MERKLE_INSERTION_KATHY_MESSAGES,
        non_matching_igp_message_count: 0,
        double_insertion_message_count: (config.kathy_messages as u32 / 4) * 2,
    };
    if !relayer_termination_invariants_met(params)? {
        return Ok(false);
    }

    if !scraper_termination_invariants_met(
        gas_payment_events_count,
        total_messages_expected + ZERO_MERKLE_INSERTION_KATHY_MESSAGES,
        total_messages_expected,
    )? {
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}

pub struct RelayerTerminationInvariantParams<'a> {
    pub config: &'a Config,
    pub starting_relayer_balance: f64,
    pub msg_processed_count: u32,
    pub gas_payment_events_count: u32,
    pub total_messages_expected: u32,
    pub total_messages_dispatched: u32,
    pub submitter_queue_length_expected: u32,
    pub non_matching_igp_message_count: u32,
    pub double_insertion_message_count: u32,
}

/// returns false if invariants are not met
/// returns true if invariants are met
pub fn relayer_termination_invariants_met(
    params: RelayerTerminationInvariantParams,
) -> eyre::Result<bool> {
    let RelayerTerminationInvariantParams {
        config,
        starting_relayer_balance,
        msg_processed_count,
        gas_payment_events_count,
        total_messages_expected,
        total_messages_dispatched,
        submitter_queue_length_expected,
        non_matching_igp_message_count,
        double_insertion_message_count,
    } = params;

    log!("Checking relayer termination invariants");

    let lengths = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_submitter_queue_length",
        &hashmap! {},
    )?;
    assert!(!lengths.is_empty(), "Could not find queue length metric");
    if lengths.iter().sum::<u32>() != submitter_queue_length_expected {
        log!(
            "Relayer queues contain more messages than the zero-merkle-insertion ones. Lengths: {:?}",
            lengths
        );
        return Ok(false);
    };

    if msg_processed_count != total_messages_expected {
        log!(
            "Relayer has {} processed messages, expected {}",
            msg_processed_count,
            total_messages_expected
        );
        return Ok(false);
    }

    let log_file_path = AGENT_LOGGING_DIR.join("RLY-output.log");
    const STORING_NEW_MESSAGE_LOG_MESSAGE: &str = "Storing new message in db";
    const LOOKING_FOR_EVENTS_LOG_MESSAGE: &str = "Looking for events in index range";
    const HYPER_INCOMING_BODY_LOG_MESSAGE: &str = "incoming body completed";

    const TX_ID_INDEXING_LOG_MESSAGE: &str = "Found log(s) for tx id";

    let relayer_logfile = File::open(log_file_path)?;

    let storing_new_msg_line_filter = vec![STORING_NEW_MESSAGE_LOG_MESSAGE];
    let looking_for_events_line_filter = vec![LOOKING_FOR_EVENTS_LOG_MESSAGE];
    let gas_expenditure_line_filter = vec![GAS_EXPENDITURE_LOG_MESSAGE];
    let hyper_incoming_body_line_filter = vec![HYPER_INCOMING_BODY_LOG_MESSAGE];
    let tx_id_indexing_line_filter = vec![TX_ID_INDEXING_LOG_MESSAGE];
    let invariant_logs = vec![
        storing_new_msg_line_filter.clone(),
        looking_for_events_line_filter.clone(),
        gas_expenditure_line_filter.clone(),
        hyper_incoming_body_line_filter.clone(),
        tx_id_indexing_line_filter.clone(),
    ];
    let log_counts = get_matching_lines(&relayer_logfile, invariant_logs);

    // Zero insertion messages don't reach `submit` stage where gas is spent, so we only expect these logs for the other messages.
    // TODO: Sometimes we find more logs than expected. This may either mean that gas is deducted twice for the same message due to a bug,
    // or that submitting the message transaction fails for some messages. Figure out which is the case and convert this check to
    // strict equality.
    // EDIT: Having had a quick look, it seems like there are some legitimate reverts happening in the confirm step
    // (`Transaction attempting to process message either reverted or was reorged`)
    // in which case more gas expenditure logs than messages are expected.
    let gas_expenditure_log_count = *log_counts
        .get(&gas_expenditure_line_filter)
        .expect("Failed to get gas expenditure log count");
    assert!(
        gas_expenditure_log_count >= total_messages_expected,
        "Didn't record gas payment for all delivered messages. Got {} gas payment logs, expected at least {}",
        gas_expenditure_log_count,
        total_messages_expected
    );
    // These tests check that we fixed https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3915, where some logs would not show up

    let storing_new_msg_log_count = *log_counts
        .get(&storing_new_msg_line_filter)
        .expect("Failed to get storing new msg log count");
    assert!(
        storing_new_msg_log_count > 0,
        "Didn't find any logs about storing messages in db"
    );
    let looking_for_events_log_count = *log_counts
        .get(&looking_for_events_line_filter)
        .expect("Failed to get looking for events log count");
    assert!(
        looking_for_events_log_count > 0,
        "Didn't find any logs about looking for events in index range"
    );
    let total_tx_id_log_count = *log_counts
        .get(&tx_id_indexing_line_filter)
        .expect("Failed to get tx id indexing log count");
    assert!(
        // there are 3 txid-indexed events:
        // - relayer: merkle insertion and gas payment
        // - scraper: gas payment
        // some logs are emitted for multiple events, so requiring there to be at least
        // `config.kathy_messages` logs is a reasonable approximation, since all three of these events
        // are expected to be logged for each message.
        total_tx_id_log_count as u64 >= config.kathy_messages,
        "Didn't find as many tx id logs as expected. Found {} and expected {}",
        total_tx_id_log_count,
        config.kathy_messages
    );
    assert!(
        !log_counts.contains_key(&hyper_incoming_body_line_filter),
        "Verbose logs not expected at the log level set in e2e"
    );

    // TestSendReceiver randomly breaks gas payments up into
    // two. So we expect at least as many gas payments as messages.
    if gas_payment_events_count < total_messages_dispatched {
        log!(
            "Relayer has {} gas payment events, expected at least {}",
            gas_payment_events_count,
            total_messages_dispatched
        );
        return Ok(false);
    }

    let merkle_tree_max_sequence = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_cursor_max_sequence",
        &hashmap! {"event_type" => "merkle_tree_insertion"},
    )?;
    // check for each origin that the highest tree index seen by the syncer == # of messages sent + # of double insertions
    // LHS: sum(merkle_tree_max_sequence) + len(merkle_tree_max_sequence) (each is index so we add 1 to each)
    // RHS: total_messages_expected + non_matching_igp_messages + double_insertion_message_count
    let non_zero_sequence_count =
        merkle_tree_max_sequence.iter().filter(|&x| *x > 0).count() as u32;
    assert_eq!(
        merkle_tree_max_sequence.iter().sum::<u32>() + non_zero_sequence_count,
        total_messages_expected + non_matching_igp_message_count + double_insertion_message_count,
    );

    let dropped_tasks = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_tokio_dropped_tasks",
        &hashmap! {"agent" => "relayer"},
    )?;

    assert_eq!(dropped_tasks.first().unwrap(), 0);

    if !relayer_balance_check(starting_relayer_balance)? {
        return Ok(false);
    }

    Ok(true)
}

/// returns false if invariants are not met
/// returns true if invariants are met
pub fn scraper_termination_invariants_met(
    gas_payment_events_count: u32,
    total_messages_dispatched: u32,
    delivered_messages_scraped_expected: u32,
) -> eyre::Result<bool> {
    log!("Checking scraper termination invariants");

    let dispatched_messages_scraped = fetch_metric(
        SCRAPER_METRICS_PORT,
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_dispatch"},
    )?
    .iter()
    .sum::<u32>();
    if dispatched_messages_scraped != total_messages_dispatched {
        log!(
            "Scraper has scraped {} dispatched messages, expected {}",
            dispatched_messages_scraped,
            total_messages_dispatched,
        );
        return Ok(false);
    }

    let gas_payments_scraped = fetch_metric(
        SCRAPER_METRICS_PORT,
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    if gas_payments_scraped != gas_payment_events_count {
        log!(
            "Scraper has scraped {} gas payments, expected {}",
            gas_payments_scraped,
            gas_payment_events_count
        );
        return Ok(false);
    }

    let delivered_messages_scraped = fetch_metric(
        SCRAPER_METRICS_PORT,
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_delivery"},
    )?
    .iter()
    .sum::<u32>();
    if delivered_messages_scraped != delivered_messages_scraped_expected {
        log!(
            "Scraper has scraped {} delivered messages, expected {}",
            delivered_messages_scraped,
            delivered_messages_scraped_expected,
        );
        return Ok(false);
    }

    Ok(true)
}

pub fn relayer_balance_check(starting_relayer_balance: f64) -> eyre::Result<bool> {
    let ending_relayer_balance: f64 =
        agent_balance_sum(9092).expect("Failed to get relayer agent balance");
    // Make sure the balance was correctly updated in the metrics.
    if starting_relayer_balance <= ending_relayer_balance {
        log!(
            "Expected starting relayer balance to be greater than ending relayer balance, but got {} <= {}",
            starting_relayer_balance,
            ending_relayer_balance
        );
        return Ok(false);
    }
    Ok(true)
}
