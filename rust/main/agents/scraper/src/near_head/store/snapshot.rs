//! Restore or rebuild a confirmed frontier on startup; extend it atomically at publication.
use eyre::{ensure, Result};
use futures::TryStreamExt;
use hyperlane_core::{accumulator::incremental::IncrementalMerkle, H256};
use sea_orm::sea_query::{Alias, OnConflict, Query};
use sea_orm::{
    ConnectionTrait, DatabaseTransaction, IsolationLevel, QueryResult, StreamTrait,
    TransactionTrait,
};

use super::{bytes, number, sql, Header, Store};

fn hash(row: &QueryResult, field: &str) -> Result<H256> {
    let bytes: Vec<u8> = row.try_get("", field)?;
    ensure!(bytes.len() == 32, "Invalid {field} in Merkle history");
    Ok(H256::from_slice(&bytes))
}

fn restore(row: &QueryResult) -> Result<Option<IncrementalMerkle>> {
    let mut tree = IncrementalMerkle::default();
    for (i, node) in tree.branch.iter_mut().enumerate() {
        *node = hash(row, &format!("branch_{i}"))?;
    }
    tree.count = usize::try_from(row.try_get::<i64>("", "leaf_count")?)?;
    Ok((tree.root() == hash(row, "root")?).then_some(tree))
}

fn ingest(tree: &mut IncrementalMerkle, row: &QueryResult, domain: u32) -> Result<()> {
    let index = row.try_get::<i32>("", "leaf_index")? as u32;
    ensure!(
        index != u32::MAX && index as usize == tree.count(),
        "Non-contiguous Merkle history for domain {domain}: expected {}, got {index}",
        tree.count()
    );
    tree.ingest(hash(row, "message_id")?);
    Ok(())
}

impl Store {
    pub(in crate::near_head) async fn prepare_snapshot(&self) -> Result<()> {
        // Both signed-index scans must see the same canonical history. Take
        // the head lock only when publishing, after the potentially long replay.
        let tx = self
            .db
            .begin_with_config(Some(IsolationLevel::RepeatableRead), None)
            .await?;
        let head = tx
            .query_one(sql(
                "SELECT confirmed_height,merkle_tree_hook,halted FROM scraper_head WHERE domain=$1",
                vec![self.domain()],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing Merkle snapshot head"))?;
        if head.try_get::<bool>("", "halted")? {
            self.lock_recovery_head(&tx).await?;
            self.discard_snapshot(&tx).await?;
        } else {
            let through = head.try_get::<i64>("", "confirmed_height")?;
            let hook = head.try_get::<Vec<u8>>("", "merkle_tree_hook")?;
            self.recover_snapshot(&tx, hook, through).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    // At REPEATABLE READ this fails if the row changed since we read it.
    // The chain supervisor retries setup; a losing rebuild never replaces a newer snapshot.
    async fn lock_recovery_head(&self, tx: &DatabaseTransaction) -> Result<()> {
        tx.query_one(sql(
            "SELECT domain FROM scraper_head WHERE domain=$1 FOR SHARE",
            vec![self.domain()],
        ))
        .await?
        .ok_or_else(|| eyre::eyre!("Missing Merkle snapshot head"))?;
        Ok(())
    }

    pub(super) async fn discard_snapshot(&self, tx: &DatabaseTransaction) -> Result<()> {
        tx.execute(sql(
            "DELETE FROM merkle_tree_snapshot WHERE domain=$1",
            vec![self.domain()],
        ))
        .await?;
        Ok(())
    }

    async fn recover_snapshot(
        &self,
        tx: &DatabaseTransaction,
        hook: Vec<u8>,
        through: i64,
    ) -> Result<()> {
        // Two index seeks find the unsigned tip, including indices stored as negative i32s.
        let row = tx.query_one(sql(
            "SELECT c.hash AS anchor,s.*,
               NOT EXISTS(SELECT 1 FROM merkle_tree_insertion WHERE domain=$1 AND merkle_tree_hook=$2 AND leaf_index=0)
               AND EXISTS(SELECT 1 FROM merkle_tree_insertion WHERE domain=$1 AND merkle_tree_hook=$2) AS missing_prefix
             FROM scraper_checkpoint c LEFT JOIN merkle_tree_snapshot s
               ON (s.domain,s.confirmed_height,s.block_hash)=(c.domain,c.height,c.hash)
               AND s.merkle_tree_hook=$2 AND s.leaf_count=1+COALESCE(
                  (SELECT leaf_index::bigint+4294967296 FROM merkle_tree_insertion
                   WHERE domain=$1 AND merkle_tree_hook=$2 AND block_number<=$3 AND leaf_index<0
                   ORDER BY leaf_index DESC LIMIT 1),
                  (SELECT leaf_index::bigint FROM merkle_tree_insertion
                   WHERE domain=$1 AND merkle_tree_hook=$2 AND block_number<=$3 AND leaf_index>=0
                   ORDER BY leaf_index DESC LIMIT 1), -1)
             WHERE c.domain=$1 AND c.height=$3",
            vec![self.domain(), hook.clone().into(), through.into()],
        )).await?.ok_or_else(|| eyre::eyre!("Missing confirmed Merkle checkpoint"))?;
        if row.try_get::<bool>("", "missing_prefix")? {
            self.lock_recovery_head(tx).await?;
            tracing::warn!(
                domain = self.domain,
                "Merkle history is missing leaf zero; skipping snapshot until next startup"
            );
            return self.discard_snapshot(tx).await;
        }
        if row.try_get::<Option<i32>>("", "domain")?.is_some() && restore(&row)?.is_some() {
            return Ok(());
        }
        let mut tree = IncrementalMerkle::default();
        // Streaming bounds bootstrap memory. Signed index halves preserve u32
        // order and allow the existing (domain, hook, leaf_index) index to serve replay.
        for (start, last) in [(0, i32::MAX), (i32::MIN, -1)] {
            let mut rows = tx
                .stream(sql(
                    "SELECT leaf_index,message_id FROM merkle_tree_insertion
                 WHERE domain=$1 AND merkle_tree_hook=$2 AND block_number<=$3
                   AND leaf_index BETWEEN $4 AND $5 ORDER BY leaf_index",
                    vec![
                        self.domain(),
                        hook.to_vec().into(),
                        through.into(),
                        start.into(),
                        last.into(),
                    ],
                ))
                .await?;
            while let Some(row) = rows.try_next().await? {
                ingest(&mut tree, &row, self.domain)?;
            }
        }
        self.lock_recovery_head(tx).await?;
        self.save_snapshot(
            tx,
            hook,
            through,
            &row.try_get::<Vec<u8>>("", "anchor")?,
            &tree,
        )
        .await
    }

    /// The caller already holds the head lock. Only read the newly confirmed
    /// height range, even when the domain has millions of historical leaves.
    pub(super) async fn advance_snapshot(
        &self,
        tx: &DatabaseTransaction,
        after: i64,
        boundary: &Header,
        has_insertions: bool,
    ) -> Result<()> {
        let scope = "scraper_head h JOIN scraper_checkpoint c ON (c.domain,c.height)=(h.domain,h.confirmed_height)
                      WHERE h.domain=$1 AND (s.domain,s.merkle_tree_hook,s.confirmed_height,s.block_hash)
                        =(h.domain,h.merkle_tree_hook,c.height,c.hash)";
        let missing = "Missing or stale Merkle snapshot; restart scraper to rebuild";
        if !has_insertions {
            let result = tx.execute(sql(format!("UPDATE merkle_tree_snapshot s SET confirmed_height=$2,block_hash=$3 FROM {scope}"),
                vec![self.domain(), number(boundary.height)?, bytes(boundary.hash)])).await?;
            ensure!(result.rows_affected() == 1, missing);
            return Ok(());
        }
        let row = tx
            .query_one(sql(
                format!("SELECT s.* FROM merkle_tree_snapshot s, {scope}"),
                vec![self.domain()],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!(missing))?;
        let mut tree = restore(&row)?.ok_or_else(|| {
            eyre::eyre!("Invalid Merkle snapshot root; restart scraper to rebuild")
        })?;
        let hook: Vec<u8> = row.try_get("", "merkle_tree_hook")?;
        let mut rows = tx
            .stream(sql(
                "SELECT leaf_index,message_id FROM merkle_tree_insertion
            WHERE domain=$1 AND merkle_tree_hook=$2 AND block_number>$3 AND block_number<=$4
            ORDER BY (leaf_index<0), leaf_index",
                vec![
                    self.domain(),
                    hook.clone().into(),
                    after.into(),
                    number(boundary.height)?,
                ],
            ))
            .await?;
        while let Some(row) = rows.try_next().await? {
            ingest(&mut tree, &row, self.domain)?;
        }
        drop(rows);
        self.save_snapshot(
            tx,
            hook,
            i64::try_from(boundary.height)?,
            boundary.hash.as_bytes(),
            &tree,
        )
        .await
    }

    async fn save_snapshot(
        &self,
        tx: &DatabaseTransaction,
        hook: Vec<u8>,
        through: i64,
        block_hash: &[u8],
        tree: &IncrementalMerkle,
    ) -> Result<()> {
        let mut columns: Vec<_> = [
            "merkle_tree_hook",
            "confirmed_height",
            "block_hash",
            "root",
            "leaf_count",
            "leaf_index",
        ]
        .into_iter()
        .map(Alias::new)
        .collect();
        let count = i64::try_from(tree.count())?;
        let mut values = vec![
            self.domain(),
            hook.into(),
            through.into(),
            block_hash.to_vec().into(),
            tree.root().as_bytes().to_vec().into(),
            count.into(),
            (count > 0).then(|| i64::from(tree.index())).into(),
        ];
        for (i, node) in tree.branch().iter().enumerate() {
            columns.push(Alias::new(format!("branch_{i}")));
            values.push(node.as_bytes().to_vec().into());
        }
        let domain = Alias::new("domain");
        let mut insert = Query::insert();
        insert
            .into_table(Alias::new("merkle_tree_snapshot"))
            .columns(std::iter::once(domain.clone()).chain(columns.iter().cloned()))
            .values(values.into_iter().map(Into::into))?
            .on_conflict(
                OnConflict::column(domain)
                    .update_columns(columns)
                    .to_owned(),
            );
        tx.execute(tx.get_database_backend().build(&insert)).await?;
        Ok(())
    }
}
