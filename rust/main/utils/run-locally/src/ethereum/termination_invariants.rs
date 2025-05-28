use hyperlane_core::SubmitterType;
use maplit::hashmap;

use crate::config::Config;
use crate::invariants::{
    provider_metrics_invariant_met, relayer_termination_invariants_met,
    scraper_termination_invariants_met, RelayerTerminationInvariantParams,
    ScraperTerminationInvariantParams,
};
use crate::logging::log;
use crate::server::{
    fetch_relayer_gas_payment_event_count, fetch_relayer_message_confirmed_count,
    fetch_relayer_message_processed_count,
};
use crate::{FAILED_MESSAGE_COUNT, RELAYER_METRICS_PORT, ZERO_MERKLE_INSERTION_KATHY_MESSAGES};

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
#[allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue
pub fn termination_invariants_met(
    config: &Config,
    starting_relayer_balance: f64,
    submitter_type: SubmitterType,
) -> eyre::Result<bool> {
    let eth_messages_expected = (config.kathy_messages / 2) as u32 * 2;

    // this is total messages expected to be delivered
    let total_messages_expected = eth_messages_expected;

    // Also ensure the counter is as expected (total number of messages), summed
    // across all mailboxes.
    let msg_processed_count = fetch_relayer_message_processed_count()?;
    let gas_payment_events_count = fetch_relayer_gas_payment_event_count()?;

    let msg_confirmed_count = fetch_relayer_message_confirmed_count()?;

    let params = RelayerTerminationInvariantParams {
        config,
        starting_relayer_balance,
        msg_processed_count,
        msg_confirmed_count,
        msg_confirmed_count_expected: eth_messages_expected,
        gas_payment_events_count,
        total_messages_expected,
        total_messages_dispatched: total_messages_expected,
        failed_message_count: FAILED_MESSAGE_COUNT,
        submitter_queue_length_expected: ZERO_MERKLE_INSERTION_KATHY_MESSAGES
            + FAILED_MESSAGE_COUNT,
        non_matching_igp_message_count: 0,
        double_insertion_message_count: (config.kathy_messages as u32 / 4) * 2,
        sealevel_tx_id_indexing: false,
        submitter_type,
    };
    if !relayer_termination_invariants_met(params)? {
        return Ok(false);
    }

    let params = ScraperTerminationInvariantParams {
        gas_payment_events_count,
        total_messages_dispatched: total_messages_expected
            + ZERO_MERKLE_INSERTION_KATHY_MESSAGES
            + FAILED_MESSAGE_COUNT,
        delivered_messages_scraped_expected: total_messages_expected,
    };

    if !scraper_termination_invariants_met(params)? {
        return Ok(false);
    }

    if !provider_metrics_invariant_met(
        RELAYER_METRICS_PORT,
        total_messages_expected,
        &hashmap! {"chain" => "test1", "status" => "success"},
        &hashmap! {"chain" => "test1"},
    )? {
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}
