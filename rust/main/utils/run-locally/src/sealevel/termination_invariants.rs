use std::{collections::HashMap, path::Path};

use hyperlane_core::SubmitterType;
use maplit::hashmap;

use crate::{
    config::Config,
    fetch_metric,
    invariants::{
        provider_metrics_invariant_met, relayer_termination_invariants_met,
        scraper_termination_invariants_met, RelayerTerminationInvariantParams,
        ScraperTerminationInvariantParams,
    },
    logging::log,
    sealevel::{solana::*, SOL_MESSAGES_EXPECTED, SOL_MESSAGES_WITH_NON_MATCHING_IGP},
    server::{fetch_relayer_gas_payment_event_count, fetch_relayer_message_processed_count},
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
    submitter_type: SubmitterType,
) -> eyre::Result<bool> {
    log!("Checking sealevel termination invariants");
    let sol_messages_expected = SOL_MESSAGES_EXPECTED;
    let sol_messages_with_non_matching_igp = SOL_MESSAGES_WITH_NON_MATCHING_IGP;

    // this is total messages expected to be delivered
    let total_messages_expected = sol_messages_expected;
    let total_messages_dispatched = total_messages_expected + sol_messages_with_non_matching_igp;

    // Also ensure the counter is as expected (total number of messages), summed
    // across all mailboxes.
    let msg_processed_count = fetch_relayer_message_processed_count()?;
    let gas_payment_events_count = fetch_relayer_gas_payment_event_count()?;

    let relayer_invariant_params = RelayerTerminationInvariantParams {
        config,
        starting_relayer_balance,
        msg_processed_count,
        gas_payment_events_count,
        total_messages_expected,
        total_messages_dispatched,
        failed_message_count: 0,
        submitter_queue_length_expected: sol_messages_with_non_matching_igp,
        non_matching_igp_message_count: 0,
        double_insertion_message_count: sol_messages_with_non_matching_igp,
        sealevel_tx_id_indexing: true,
    };
    if !relayer_termination_invariants_met(relayer_invariant_params.clone())? {
        log!("Relayer termination invariants not met");
        return Ok(false);
    }

    if !solana_termination_invariants_met(solana_cli_tools_path, solana_config_path) {
        log!("Solana termination invariants not met");
        return Ok(false);
    }

    let params = ScraperTerminationInvariantParams {
        gas_payment_events_count,
        total_messages_dispatched,
        delivered_messages_scraped_expected: total_messages_expected,
    };

    if !scraper_termination_invariants_met(params)? {
        log!("Scraper termination invariants not met");
        return Ok(false);
    }

    if !provider_metrics_invariant_met(
        RELAYER_METRICS_PORT,
        total_messages_expected,
        &hashmap! {"chain" => "sealeveltest2", "connection" => "rpc", "status" => "success"},
        &hashmap! {"chain" => "sealeveltest2"},
    )? {
        log!("Provider metrics invariants not met");
        return Ok(false);
    }

    if matches!(submitter_type, SubmitterType::Lander)
        && !submitter_metrics_invariants_met(
            relayer_invariant_params,
            RELAYER_METRICS_PORT,
            &hashmap! {"destination" => "sealeveltest2"},
        )?
    {
        log!("Submitter metrics invariants not met");
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}

fn submitter_metrics_invariants_met(
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

    Ok(true)
}

#[cfg(test)]
mod tests {
    use maplit::hashmap;

    #[test]
    fn submitter_metrics_are_correct() {
        let relayer_metrics_port = 9092;
        let filter_hashmap = hashmap! {
            "destination" => "sealeveltest2",
        };
        let params = super::RelayerTerminationInvariantParams {
            total_messages_expected: 10,
            // the rest are not used
            config: &crate::config::Config::load(),
            starting_relayer_balance: 0.0,
            msg_processed_count: 0,
            gas_payment_events_count: 0,
            total_messages_dispatched: 0,
            failed_message_count: 0,
            submitter_queue_length_expected: 0,
            non_matching_igp_message_count: 0,
            double_insertion_message_count: 0,
            sealevel_tx_id_indexing: true,
        };
        assert_eq!(
            super::submitter_metrics_invariants_met(
                params,
                &relayer_metrics_port.to_string(),
                &filter_hashmap
            )
            .unwrap(),
            true
        );
    }
}
