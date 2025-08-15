use super::sim::Params;
use super::util::{som_to_kas, SOMPI_PER_KAS};
use rand_distr::Distribution;
use std::time::Duration;

#[allow(dead_code)]
pub fn do_demo_params() {
    demo_params(Params {
        time_limit: Duration::from_secs(60),
        budget: 200000 * SOMPI_PER_KAS,
        ops_per_minute: 90,
        simple_mode: false,
        min_value: hardcode::e2e::MIN_DEPOSIT_SOMPI,
        hub_fund_amount: 100000000000000,
        max_wait_for_cancel: Duration::from_secs(60),
    });
}

fn demo_params(params: Params) {
    let mut r = rand::rng();
    let mut elapsed = 0u128;
    let mut total_spend = 0;
    let mut total_ops = 0;
    while elapsed < params.time_limit.as_millis() {
        let value = params.distr_value().sample(&mut r) as u64;
        let time = params.distr_time().sample(&mut r) as u64;
        elapsed += time as u128;
        total_spend += value;
        total_ops += 1;
        println!(
            "elaspsed {}, time {}, value {}",
            elapsed,
            time,
            som_to_kas(value)
        );
    }
    println!(
        "total_spend: {}, total_ops: {}",
        som_to_kas(total_spend),
        total_ops
    );
}
