use std::path::Path;

use maplit::hashmap;

use crate::{
    config::Config,
    invariants::{
        relayer_termination_invariants_met, scraper_termination_invariants_met,
        RelayerTerminationInvariantParams,
    },
    logging::log,
    sealevel::{solana::*, SOL_MESSAGES_EXPECTED, SOL_MESSAGES_WITH_NON_MATCHING_IGP},
    server::{fetch_relayer_gas_payment_event_count, fetch_relayer_message_processed_count},
    {fetch_metric, RELAYER_METRICS_PORT},
};

/// Use the metrics to check if the relayer queues are empty and the expected
/// number of messages have been sent.
#[allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue
pub fn termination_invariants_met(
    config: &Config,
    starting_relayer_balance: f64,
    solana_cli_tools_path: &Path,
    solana_config_path: &Path,
) -> eyre::Result<bool> {
    let sol_messages_expected = SOL_MESSAGES_EXPECTED;
    let sol_messages_with_non_matching_igp = SOL_MESSAGES_WITH_NON_MATCHING_IGP;

    // this is total messages expected to be delivered
    let total_messages_expected = sol_messages_expected;
    let total_messages_dispatched = total_messages_expected + sol_messages_with_non_matching_igp;

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
        total_messages_dispatched,
        submitter_queue_length_expected: sol_messages_with_non_matching_igp,
        non_matching_igp_message_count: 0,
        double_insertion_message_count: sol_messages_with_non_matching_igp,
    };
    if !relayer_termination_invariants_met(params)? {
        return Ok(false);
    }

    if !solana_termination_invariants_met(solana_cli_tools_path, solana_config_path) {
        log!("Solana termination invariants not met");
        return Ok(false);
    }

    if !scraper_termination_invariants_met(
        gas_payment_events_count,
        total_messages_dispatched,
        total_messages_expected,
    )? {
        return Ok(false);
    }

    if !request_metric_invariant_met(total_messages_expected)? {
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}

pub fn request_metric_invariant_met(expected_request_count: u32) -> eyre::Result<bool> {
    let request_count = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_request_count",
        &hashmap! {"chain" => "sealeveltest1", "status" => "success"},
    )?
    .iter()
    .sum::<u32>();

    assert!(request_count > expected_request_count);
    Ok(true)
}
