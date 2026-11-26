//! Untrusted Explorer input. Only configured RPC checkpoints can authenticate a frontier.
use std::time::Duration;

use eyre::{ensure, ContextCompat, Result};
use hyperlane_base::scraper_websocket::{
    parse_address, parse_hash, MerkleEventData, StringOrNumber,
};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, address_to_bytes, CheckpointAtBlock,
    MerkleTreeInsertion, H256,
};
use redact::Secret;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use url::Url;

const PAGE_SIZE: u32 = 1000;
const RESPONSE_LIMIT: usize = 512 * 1024;
const SNAPSHOT: &str = "query Frontier($domain:bigint!,$hook:bytea!){merkle_tree_snapshot(domain:$domain,merkle_tree_hook:$hook){domain merkle_tree_hook confirmed_height leaf_count branch root}}";
const INSERTIONS: &str = "query Leaves($domain:bigint!,$hook:bytea!,$from:bigint!,$limit:Int!,$ttl:Int!) @cached(ttl:$ttl){merkle_tree_insertions(domain:$domain,merkle_tree_hook:$hook,from_index:$from,limit:$limit){insertions{domain merkle_tree_hook leaf_index message_id block_number}}}";

#[derive(Clone, Debug)]
pub(crate) struct Explorer {
    url: Secret<Url>,
    client: reqwest::Client,
    domain: u32,
    hook: H256,
}

pub(crate) struct VerifiedStart {
    previous_tree: IncrementalMerkle,
    last_insertion: (MerkleTreeInsertion, u64),
}

impl VerifiedStart {
    /// The signing worker reads this leaf from RocksDB even if the socket is offline.
    pub(crate) fn resume(
        self,
        db: &hyperlane_base::db::HyperlaneRocksDB,
    ) -> Result<IncrementalMerkle> {
        let (leaf, height) = self.last_insertion;
        let existing = db.store_tree_insertion_if_absent(&leaf, height)?;
        if existing.is_some_and(|row| row != leaf) {
            db.store_tree_insertion(&leaf, height)?;
        }
        Ok(self.previous_tree)
    }
}

#[derive(Deserialize)]
struct Snapshot {
    domain: StringOrNumber,
    merkle_tree_hook: String,
    confirmed_height: StringOrNumber,
    leaf_count: StringOrNumber,
    branch: [String; 32],
    root: String,
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

    pub(crate) async fn snapshot(&self) -> Result<Option<(IncrementalMerkle, u64)>> {
        #[derive(Deserialize)]
        struct Data {
            merkle_tree_snapshot: Option<Snapshot>,
        }
        let data: Data = self.query(SNAPSHOT, json!({})).await?;
        let Some(row) = data.merkle_tree_snapshot else {
            return Ok(None);
        };
        ensure!(
            row.domain.as_u32("domain")? == self.domain
                && parse_address(&row.merkle_tree_hook)? == self.hook,
            "Unexpected Explorer snapshot scope"
        );
        let mut tree = IncrementalMerkle {
            count: row.leaf_count.as_u32("leaf count")? as usize,
            ..Default::default()
        };
        for (branch, value) in tree.branch.iter_mut().zip(row.branch) {
            *branch = parse_hash(&value)?;
        }
        ensure!(
            tree.root() == parse_hash(&row.root)?,
            "Invalid Explorer frontier root"
        );
        Ok(Some((
            tree,
            row.confirmed_height.as_u64("confirmed height")?,
        )))
    }

    /// Return the frontier immediately before the snapshot's last leaf. Re-ingesting
    /// that leaf authenticates its message ID too, allowing the ordinary submitter
    /// to publish the tip on a quiet chain without waiting for another insertion.
    pub(crate) async fn verified_start(
        &self,
        mut tree: IncrementalMerkle,
        votes: &[CheckpointAtBlock],
        required: usize,
    ) -> Result<VerifiedStart> {
        let index = tree.index();
        let expected_root = tree.root();
        tree.count = index as usize;
        let start = tree.clone();
        let votes: Vec<_> = votes
            .iter()
            .filter(|v| {
                v.mailbox_domain == self.domain
                    && v.merkle_tree_hook_address == self.hook
                    && (index..u32::MAX).contains(&v.index)
            })
            .collect();
        ensure!(
            votes.len() >= required,
            "Insufficient finalized RPC checkpoints at snapshot index"
        );
        let end = votes
            .iter()
            .map(|v| v.index)
            .max()
            .and_then(|i| i.checked_add(1))
            .context("Invalid RPC checkpoint index")?;
        let mut next = index;
        let mut matching = 0usize;
        let mut last_insertion = None;
        while next < end {
            for (leaf, height) in self.page(next, end).await? {
                tree.ingest(leaf.message_id());
                next = u32::try_from(tree.count())?;
                if leaf.index() == index {
                    ensure!(
                        tree.root() == expected_root,
                        "Snapshot does not authenticate its last leaf"
                    );
                    last_insertion = Some((leaf, height));
                }
                if votes.iter().any(|v| v.index == leaf.index()) {
                    let root = tree.root();
                    matching = matching.saturating_add(
                        votes
                            .iter()
                            .filter(|v| v.index == leaf.index() && v.root == root)
                            .count(),
                    );
                    if matching >= required {
                        return Ok(VerifiedStart {
                            previous_tree: start,
                            last_insertion: last_insertion.context("Missing snapshot insertion")?,
                        });
                    }
                }
            }
        }
        eyre::bail!("Explorer frontier disagrees with finalized RPC checkpoints")
    }
}

#[cfg(test)]
pub(crate) mod tests;
