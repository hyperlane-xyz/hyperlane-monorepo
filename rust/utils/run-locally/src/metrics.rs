use std::collections::HashMap;

use eyre::{eyre, Result};

pub fn fetch_metric(port: &str, metric: &str, labels: &HashMap<&str, &str>) -> Result<Vec<u32>> {
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
            Ok(l.rsplit_once(' ')
                .ok_or(eyre!("Unknown metric format"))?
                .1
                .parse::<u32>()?)
        })
        .collect()
}
