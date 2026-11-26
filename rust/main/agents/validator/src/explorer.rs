//! Confirmed Merkle insertions from Explorer.
use std::time::Duration;

use eyre::{ensure, ContextCompat, Result};
use hyperlane_base::scraper_websocket::MerkleEventData;
use hyperlane_core::{address_to_bytes, MerkleTreeInsertion, H256};
use redact::Secret;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use url::Url;

const PAGE_SIZE: u32 = 1000;
const RESPONSE_LIMIT: usize = 512 * 1024;
const INSERTIONS: &str = "query Leaves($domain:bigint!,$hook:bytea!,$from:bigint!,$limit:Int!,$ttl:Int!) @cached(ttl:$ttl){merkle_tree_insertions(domain:$domain,merkle_tree_hook:$hook,from_index:$from,limit:$limit){insertions{domain merkle_tree_hook leaf_index message_id block_number}}}";

#[derive(Clone, Debug)]
pub(crate) struct Explorer {
    url: Secret<Url>,
    client: reqwest::Client,
    domain: u32,
    hook: H256,
}

impl Explorer {
    pub(crate) fn new(url: Secret<Url>, domain: u32, hook: H256) -> Result<Self> {
        Ok(Self {
            url,
            client: reqwest::Client::builder()
                .use_rustls_tls()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            domain,
            hook,
        })
    }

    async fn query<T: DeserializeOwned>(&self, query: &str, mut vars: Value) -> Result<T> {
        vars["domain"] = json!(self.domain);
        vars["hook"] = json!(format!("0x{}", hex::encode(address_to_bytes(&self.hook))));
        let mut response = self
            .client
            .post(self.url.expose_secret().clone())
            .json(&json!({"query":query,"variables":vars}))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(reqwest::Error::without_url)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(reqwest::Error::without_url)?
        {
            ensure!(
                bytes.len().saturating_add(chunk.len()) <= RESPONSE_LIMIT,
                "Oversized Explorer response"
            );
            bytes.extend_from_slice(&chunk);
        }
        #[derive(Deserialize)]
        struct Response<T> {
            data: Option<T>,
            errors: Option<Value>,
        }
        let result: Response<T> = serde_json::from_slice(&bytes)?;
        ensure!(result.errors.is_none(), "Explorer GraphQL returned errors");
        result.data.context("Missing Explorer GraphQL data")
    }

    pub(crate) async fn page(
        &self,
        start: u32,
        end: u32,
    ) -> Result<Vec<(MerkleTreeInsertion, u64)>> {
        #[derive(Deserialize)]
        struct Page {
            insertions: Vec<MerkleEventData>,
        }
        #[derive(Deserialize)]
        struct Data {
            merkle_tree_insertions: Page,
        }
        let remaining = end
            .checked_sub(start)
            .filter(|n| *n > 0)
            .context("Empty Explorer range")?;
        let limit = remaining.min(PAGE_SIZE);
        // Let a lagging replica's final page expire quickly at the handoff.
        let ttl = if remaining > PAGE_SIZE { 60 } else { 2 };
        let data: Data = self
            .query(INSERTIONS, json!({"from":start,"limit":limit,"ttl":ttl}))
            .await?;
        let rows = data.merkle_tree_insertions.insertions;
        ensure!(
            !rows.is_empty() && rows.len() <= limit as usize,
            "Explorer cannot cover requested insertion range"
        );
        rows.into_iter()
            .zip(start..end)
            .map(|(row, index)| row.decode(self.domain, self.hook, index))
            .collect()
    }
}

#[cfg(test)]
pub(crate) mod tests;
