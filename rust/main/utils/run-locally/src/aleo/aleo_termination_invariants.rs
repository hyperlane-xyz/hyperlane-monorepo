use hyperlane_core::SubmitterType;
use maplit::hashmap;

use crate::config::Config;
use crate::fetch_metric;
use crate::invariants::{
    relayer_termination_invariants_met, scraper_termination_invariants_met,
    RelayerTerminationInvariantParams, ScraperTerminationInvariantParams,
};
use crate::logging::log;
use crate::server::{fetch_relayer_gas_payment_event_count, fetch_relayer_message_processed_count};

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent for Radix.
pub fn aleo_termination_invariants_met(
    config: &Config,
    starting_relayer_balance: f64,
    scraper_metrics_port: u32,
    messages_expected: u32,
) -> eyre::Result<bool> {
    // Fetch metrics from the relayer
    let msg_processed_count = fetch_relayer_message_processed_count()?;
    let gas_payment_events_count = fetch_relayer_gas_payment_event_count()?;

    // Check relayer termination invariants using the shared function
    let relayer_params = RelayerTerminationInvariantParams {
        config,
        starting_relayer_balance,
        msg_processed_count,
        gas_payment_events_count,
        total_messages_expected: messages_expected,
        total_messages_dispatched: messages_expected,
        failed_message_count: 0, // Radix doesn't have failed messages in the same way
        submitter_queue_length_expected: 0, // Radix doesn't have zero merkle insertion messages
        non_matching_igp_message_count: 0,
        double_insertion_message_count: 0,
        skip_tx_id_indexing: true,
        submitter_type: SubmitterType::Classic,
    };

    if !relayer_termination_invariants_met(relayer_params)? {
        return Ok(false);
    }

    // Check scraper termination invariants using the shared function
    // For scraper, we need to fetch metrics from the scraper port
    let scraper_gas_payment_events_count = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();

    let scraper_params = ScraperTerminationInvariantParams {
        gas_payment_events_count: scraper_gas_payment_events_count,
        total_messages_dispatched: messages_expected,
        delivered_messages_scraped_expected: messages_expected,
    };

    if !scraper_termination_invariants_met(scraper_params)? {
        return Ok(false);
    }

    log!("Radix termination invariants have been met");
    Ok(true)
}
