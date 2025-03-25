#![allow(dead_code)] // TODO: `rustc` 1.80.1 clippy issue

use maplit::hashmap;

use crate::fetch_metric;
use crate::invariants::provider_metrics_invariant_met;
use crate::logging::log;
use crate::metrics::agent_balance_sum;

pub fn termination_invariants_met(
    relayer_metrics_port: u32,
    scraper_metrics_port: u32,
    messages_expected: u32,
    starting_relayer_balance: f64,
) -> eyre::Result<bool> {
    let expected_gas_payments = messages_expected;
    let gas_payments_event_count = fetch_metric(
        &relayer_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    if gas_payments_event_count != expected_gas_payments {
        log!(
            "Relayer has indexed {} gas payments, expected {}",
            gas_payments_event_count,
            expected_gas_payments
        );
        return Ok(false);
    }

    let msg_processed_count = fetch_metric(
        &relayer_metrics_port.to_string(),
        "hyperlane_operations_processed_count",
        &hashmap! {"phase" => "confirmed"},
    )?
    .iter()
    .sum::<u32>();
    if msg_processed_count != messages_expected {
        log!(
            "Relayer confirmed {} submitted messages, expected {}",
            msg_processed_count,
            messages_expected
        );
        return Ok(false);
    }

    let ending_relayer_balance: f64 =
        agent_balance_sum(relayer_metrics_port).expect("Failed to get relayer agent balance");

    // Make sure the balance was correctly updated in the metrics.
    // Ideally, make sure that the difference is >= gas_per_tx * gas_cost, set here:
    // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/c2288eb31734ba1f2f997e2c6ecb30176427bc2c/rust/utils/run-locally/src/cosmos/cli.rs#L55
    // What's stopping this is that the format returned by the `uosmo` balance query is a surprisingly low number (0.000003999999995184)
    // but then maybe the gas_per_tx is just very low - how can we check that? (maybe by simulating said tx)
    if starting_relayer_balance <= ending_relayer_balance {
        log!(
            "Expected starting relayer balance to be greater than ending relayer balance, but got {} <= {}",
            starting_relayer_balance,
            ending_relayer_balance
        );
        return Ok(false);
    }

    let dispatched_messages_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_dispatch"},
    )?
    .iter()
    .sum::<u32>();
    if dispatched_messages_scraped != messages_expected {
        log!(
            "Scraper has scraped {} dispatched messages, expected {}",
            dispatched_messages_scraped,
            messages_expected
        );
        return Ok(false);
    }

    let gas_payments_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    if gas_payments_scraped != expected_gas_payments {
        log!(
            "Scraper has scraped {} gas payments, expected {}",
            gas_payments_scraped,
            expected_gas_payments
        );
        return Ok(false);
    }

    let delivered_messages_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_delivery"},
    )?
    .iter()
    .sum::<u32>();
    if delivered_messages_scraped != messages_expected {
        log!(
            "Scraper has scraped {} delivered messages, expected {}",
            delivered_messages_scraped,
            messages_expected
        );
        return Ok(false);
    }

    if !provider_metrics_invariant_met(
        &relayer_metrics_port.to_string(),
        messages_expected,
        &hashmap! {"chain" => "cosmostest99990", "connection" => "rpc", "status" => "success"},
        &hashmap! {"chain" => "cosmostest99990"},
    )? {
        return Ok(false);
    }

    if !provider_metrics_invariant_met(
        &relayer_metrics_port.to_string(),
        messages_expected,
        &hashmap! {"chain" => "cosmostest99990", "connection" => "grpc", "status" => "success"},
        &hashmap! {"chain" => "cosmostest99990"},
    )? {
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}
