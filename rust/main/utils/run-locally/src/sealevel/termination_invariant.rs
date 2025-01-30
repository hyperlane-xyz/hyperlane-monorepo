use std::path::Path;

use maplit::hashmap;

use crate::{
    config::Config,
    fetch_metric,
    invariants::{
        relayer_balance_check, relayer_termination_invariants_met,
        scraper_termination_invariants_met,
    },
    logging::log,
    sealevel::{solana::*, SOL_MESSAGES_EXPECTED, SOL_MESSAGES_WITH_NON_MATCHING_IGP},
    RELAYER_METRICS_PORT,
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
    let msg_processed_count = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_messages_processed_count",
        &hashmap! {},
    )?
    .iter()
    .sum::<u32>();

    let gas_payment_events_count = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payments"},
    )?
    .iter()
    .sum::<u32>();

    if !solana_termination_invariants_met(solana_cli_tools_path, solana_config_path) {
        log!("Solana termination invariants not met");
        return Ok(false);
    }

    if !relayer_termination_invariants_met(
        config,
        msg_processed_count,
        gas_payment_events_count,
        total_messages_expected,
        total_messages_dispatched,
    )? {
        return Ok(false);
    }

    if !scraper_termination_invariants_met(
        gas_payment_events_count,
        total_messages_dispatched,
        total_messages_expected,
    )? {
        return Ok(false);
    }

    let merkle_tree_max_sequence = fetch_metric(
        RELAYER_METRICS_PORT,
        "hyperlane_cursor_max_sequence",
        &hashmap! {"event_type" => "merkle_tree_insertion"},
    )?;
    // check for each origin that the highest tree index seen by the syncer == # of messages sent + # of double insertions
    // LHS: sum(merkle_tree_max_sequence) + len(merkle_tree_max_sequence) (each is index so we add 1 to each)
    // RHS: total_messages_expected + non_matching_igp_messages + (config.kathy_messages as u32 / 4) * 2 (double insertions)
    let non_zero_sequence_count =
        merkle_tree_max_sequence.iter().filter(|&x| *x > 0).count() as u32;
    assert_eq!(
        merkle_tree_max_sequence.iter().sum::<u32>() + non_zero_sequence_count,
        total_messages_expected + (config.kathy_messages as u32 / 4) * 2
    );

    if !relayer_balance_check(starting_relayer_balance)? {
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}
