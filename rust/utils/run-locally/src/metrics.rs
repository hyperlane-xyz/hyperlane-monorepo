use std::{collections::HashMap, error::Error as StdError, str::FromStr};

use eyre::{eyre, ErrReport, Result};
use maplit::hashmap;

/// Fetch a prometheus format metric, filtering by labels.
pub fn fetch_metric<T, E>(port: &str, metric: &str, labels: &HashMap<&str, &str>) -> Result<Vec<T>>
where
    T: FromStr<Err = E>,
    E: Into<ErrReport> + StdError + Send + Sync + 'static,
{
    let resp = ureq::get(&format!("http://127.0.0.1:{}/metrics", port));
    resp.call()?
        .into_string()?
        .lines()
        .filter(|l| l.starts_with(metric))
        .filter(|l| {
            labels
                .iter()
                // Do no check for the closing quotation mark when matching, to allow for
                // only matching a label value prefix.
                .all(|(k, v)| l.contains(&format!("{k}=\"{v}")))
        })
        .map(|l| {
            let value = l.rsplit_once(' ').ok_or(eyre!("Unknown metric format"))?.1;
            Ok(value.parse::<T>()?)
        })
        .collect()
}

pub fn agent_balance_sum(metrics_port: u32) -> eyre::Result<f64> {
    let balance = fetch_metric(
        &metrics_port.to_string(),
        "hyperlane_wallet_balance",
        &hashmap! {},
    )?
    .iter()
    .sum();
    Ok(balance)
}
