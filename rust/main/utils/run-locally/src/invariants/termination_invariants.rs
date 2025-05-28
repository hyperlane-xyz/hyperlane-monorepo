use std::collections::HashMap;
use std::fs::File;

use maplit::hashmap;
use relayer::GAS_EXPENDITURE_LOG_MESSAGE;

use hyperlane_core::SubmitterType;

use crate::config::Config;
use crate::logging::log;
use crate::metrics::agent_balance_sum;
use crate::utils::get_matching_lines;
use crate::{fetch_metric, AGENT_LOGGING_DIR, RELAYER_METRICS_PORT, SCRAPER_METRICS_PORT};

#[derive(Clone)]
pub struct RelayerTerminationInvariantParams<'a> {
    pub config: &'a Config,
    pub starting_relayer_balance: f64,
    pub msg_processed_count: u32,
    pub msg_confirmed_count: u32,
    pub msg_confirmed_count_expected: u32,
    pub gas_payment_events_count: u32,
    pub total_messages_expected: u32,
    pub total_messages_dispatched: u32,
    pub failed_message_count: u32,
    pub submitter_queue_length_expected: u32,
    pub non_matching_igp_message_count: u32,
    pub double_insertion_message_count: u32,
    pub sealevel_tx_id_indexing: bool,
    pub submitter_type: SubmitterType,
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
        msg_confirmed_count,
        msg_confirmed_count_expected,
        gas_payment_events_count,
        total_messages_expected,
        total_messages_dispatched,
        failed_message_count,
        submitter_queue_length_expected,
        non_matching_igp_message_count,
        double_insertion_message_count,
        sealevel_tx_id_indexing,
        submitter_type,
    } = params.clone();

    log!("Checking relayer termination invariants");

    let lengths = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_submitter_queue_length",
        &hashmap! {},
    )?;
    if lengths.is_empty() {
        log!("No submitter queues found");
        return Ok(false);
    }
    if lengths.iter().sum::<u32>() != submitter_queue_length_expected {
        log!(
            "Relayer queues contain more messages than expected. Lengths: {:?}, expected {}",
            lengths,
            submitter_queue_length_expected
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

    log!(
        "Relayer message confirmed count {}, expected {}",
        msg_confirmed_count,
        msg_confirmed_count_expected
    );
    if msg_confirmed_count != msg_confirmed_count_expected {
        log!(
            "Relayer has {} confirmed messages, expected {}",
            msg_confirmed_count,
            msg_confirmed_count_expected
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
    // TODO: re-enable once the MessageProcessor IGP is integrated with the dispatcher
    // let gas_expenditure_log_count = *log_counts
    //     .get(&gas_expenditure_line_filter)
    //     .expect("Failed to get gas expenditure log count");
    // assert!(
    //     gas_expenditure_log_count >= total_messages_expected,
    //     "Didn't record gas payment for all delivered messages. Got {} gas payment logs, expected at least {}",
    //     gas_expenditure_log_count,
    //     total_messages_expected
    // );
    // // These tests check that we fixed https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3915, where some logs would not show up

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

    // Sealevel relayer does not require tx id indexing.
    // It performs sequenced indexing, that's why we don't expect any tx_id_logs
    let expected_tx_id_logs = if sealevel_tx_id_indexing {
        0
    } else {
        config.kathy_messages
    };
    // there are 3 txid-indexed events:
    // - relayer: merkle insertion and gas payment
    // - scraper: gas payment
    // some logs are emitted for multiple events, so requiring there to be at least
    // `config.kathy_messages` logs is a reasonable approximation, since all three of these events
    // are expected to be logged for each message.
    assert!(
        total_tx_id_log_count as u64 >= expected_tx_id_logs,
        "Didn't find as many tx id logs as expected. Found {} and expected {}",
        total_tx_id_log_count,
        expected_tx_id_logs
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

    let lhs = merkle_tree_max_sequence.iter().sum::<u32>() + non_zero_sequence_count;
    let rhs = total_messages_expected
        + non_matching_igp_message_count
        + double_insertion_message_count
        + failed_message_count;
    if lhs != rhs {
        log!(
            "highest tree index does not match messages sent. got {} expected {}",
            lhs,
            rhs
        );
        return Ok(false);
    }
    assert_eq!(lhs, rhs);

    let dropped_tasks: Vec<u32> = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_tokio_dropped_tasks",
        &hashmap! {"agent" => "relayer"},
    )?;

    assert_eq!(dropped_tasks.first().unwrap(), &0);

    if !relayer_balance_check(starting_relayer_balance)? {
        return Ok(false);
    }

    if matches!(submitter_type, SubmitterType::Lander)
        && !submitter_metrics_invariants_met(params, RELAYER_METRICS_PORT, &hashmap! {})?
    {
        log!("Submitter metrics invariants not met");
        return Ok(false);
    }

    Ok(true)
}

pub struct ScraperTerminationInvariantParams {
    pub gas_payment_events_count: u32,
    pub total_messages_dispatched: u32,
    pub delivered_messages_scraped_expected: u32,
}

/// returns false if invariants are not met
/// returns true if invariants are met
pub fn scraper_termination_invariants_met(
    params: ScraperTerminationInvariantParams,
) -> eyre::Result<bool> {
    let ScraperTerminationInvariantParams {
        gas_payment_events_count,
        total_messages_dispatched,
        delivered_messages_scraped_expected,
    } = params;

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

pub fn submitter_metrics_invariants_met(
    params: RelayerTerminationInvariantParams,
    relayer_port: &str,
    filter_hashmap: &HashMap<&str, &str>,
) -> eyre::Result<bool> {
    let finalized_transactions = fetch_metric(
        relayer_port,
        "hyperlane_lander_finalized_transactions",
        filter_hashmap,
    )?
    .iter()
    .sum::<u32>();

    let building_stage_queue_length = fetch_metric(
        relayer_port,
        "hyperlane_lander_building_stage_queue_length",
        filter_hashmap,
    )?
    .iter()
    .sum::<u32>();

    let inclusion_stage_pool_length = fetch_metric(
        relayer_port,
        "hyperlane_lander_inclusion_stage_pool_length",
        filter_hashmap,
    )?
    .iter()
    .sum::<u32>();
    let finality_stage_pool_length = fetch_metric(
        relayer_port,
        "hyperlane_lander_finality_stage_pool_length",
        filter_hashmap,
    )?
    .iter()
    .sum::<u32>();
    let dropped_payloads = fetch_metric(
        relayer_port,
        "hyperlane_lander_dropped_payloads",
        filter_hashmap,
    )?
    .iter()
    .sum::<u32>();
    let dropped_transactions = fetch_metric(
        relayer_port,
        "hyperlane_lander_dropped_transactions",
        filter_hashmap,
    )?
    .iter()
    .sum::<u32>();

    let transaction_submissions = fetch_metric(
        relayer_port,
        "hyperlane_lander_transaction_submissions",
        filter_hashmap,
    )?
    .iter()
    .sum::<u32>();

    if finalized_transactions < params.total_messages_expected {
        log!(
            "hyperlane_lander_finalized_transactions {} count, expected {}",
            finalized_transactions,
            params.total_messages_expected
        );
        return Ok(false);
    }
    if building_stage_queue_length != 0 {
        log!(
            "hyperlane_lander_building_stage_queue_length {} count, expected {}",
            building_stage_queue_length,
            0
        );
        return Ok(false);
    }
    if inclusion_stage_pool_length != 0 {
        log!(
            "hyperlane_lander_inclusion_stage_pool_length {} count, expected {}",
            inclusion_stage_pool_length,
            0
        );
        return Ok(false);
    }
    if finality_stage_pool_length != 0 {
        log!(
            "hyperlane_lander_finality_stage_pool_length {} count, expected {}",
            finality_stage_pool_length,
            0
        );
        return Ok(false);
    }
    if dropped_payloads != 0 {
        log!(
            "hyperlane_lander_dropped_payloads {} count, expected {}",
            dropped_payloads,
            0
        );
        return Ok(false);
    }
    if dropped_transactions != 0 {
        log!(
            "hyperlane_lander_dropped_transactions {} count, expected {}",
            dropped_transactions,
            0
        );
        return Ok(false);
    }

    // resubmissions are possible because it takes a while for the local
    // solana validator to report a tx hash as included once broadcast
    // but no more than 2 submissions are expected per message
    if transaction_submissions > 2 * params.total_messages_expected {
        log!(
            "hyperlane_lander_transaction_submissions {} count, expected {}",
            transaction_submissions,
            params.total_messages_expected
        );
        return Ok(false);
    }

    Ok(true)
}

#[allow(dead_code)]
pub fn provider_metrics_invariant_met(
    relayer_port: &str,
    expected_request_count: u32,
    filter_hashmap: &HashMap<&str, &str>,
    provider_filter_hashmap: &HashMap<&str, &str>,
) -> eyre::Result<bool> {
    let request_count = fetch_metric(relayer_port, "hyperlane_request_count", filter_hashmap)?
        .iter()
        .sum::<u32>();
    if request_count < expected_request_count {
        log!(
            "hyperlane_request_count {} count, expected {}",
            request_count,
            expected_request_count,
        );
        return Ok(false);
    }

    let provider_create_count = fetch_metric(
        relayer_port,
        "hyperlane_provider_create_count",
        provider_filter_hashmap,
    )?
    .iter()
    .sum::<u32>();
    log!("Provider created count: {}", provider_create_count);
    if provider_create_count < expected_request_count {
        log!(
            "hyperlane_provider_create_count only has {} count, expected at least {}",
            provider_create_count,
            expected_request_count
        );
        return Ok(false);
    }

    let metadata_build_hashmap: HashMap<&str, &str> = HashMap::new();

    let metadata_build_count = fetch_metric(
        relayer_port,
        "hyperlane_metadata_build_count",
        &metadata_build_hashmap,
    )?
    .iter()
    .sum::<u32>();
    if metadata_build_count < expected_request_count {
        log!(
            "hyperlane_metadata_build_count only has {} count, expected at least {}",
            metadata_build_count,
            expected_request_count
        );
        return Ok(false);
    }

    Ok(true)
}
