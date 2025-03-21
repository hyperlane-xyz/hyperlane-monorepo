use maplit::hashmap;

use crate::config::Config;
use crate::invariants::{
    provider_metrics_invariant_met, relayer_termination_invariants_met,
    scraper_termination_invariants_met, RelayerTerminationInvariantParams,
};
use crate::logging::log;
use crate::server::{fetch_relayer_gas_payment_event_count, fetch_relayer_message_processed_count};
use crate::{RELAYER_METRICS_PORT, ZERO_MERKLE_INSERTION_KATHY_MESSAGES};

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
