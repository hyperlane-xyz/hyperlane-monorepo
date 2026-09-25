use std::{
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use ethers::types::H256;
use eyre::{ensure, Result};
use hyperlane_core::{address_to_bytes, h512_to_bytes, LogMeta, H512};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait, Value};

use super::source::{Contracts, Event, EventData, Header};

#[derive(Debug, Clone)]
pub(super) struct State {
    pub indexed: u64,
    pub hash: H256,
    pub confirmed: u64,
    pub verified: Option<u64>,
    pub head: u64,
    pub halted: bool,
}

pub(super) struct Store {
    pub db: DatabaseConnection,
    pub domain: u32,
}

fn sql(query: impl Into<String>, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}
fn number(value: u64) -> Result<Value> {
    Ok(i64::try_from(value)?.into())
}
fn bytes(hash: H256) -> Value {
    hash.as_bytes().to_vec().into()
}
fn signed(value: u32) -> i32 {
    i32::from_ne_bytes(value.to_ne_bytes())
}

const EVENTS: [(&str, &str, &str); 4] = [
    (
        "raw_message_dispatch",
        "origin_domain",
        "origin_block_height",
    ),
    ("delivered_message", "domain", "block_number"),
    ("gas_payment", "domain", "block_number"),
    ("merkle_tree_insertion", "domain", "block_number"),
];

impl Store {
    pub async fn claim(&self, lease: Duration) -> Result<()> {
        let result = self.db.execute(sql(
            "UPDATE scraper_head SET writer_id=$2,writer_lease_until=clock_timestamp()+make_interval(secs=>$3) WHERE domain=$1 AND (writer_id=$2 OR writer_lease_until IS NULL OR writer_lease_until<clock_timestamp())",
            vec![self.domain(), writer_id().into(), lease.as_secs_f64().into()],
        )).await?;
        ensure!(
            result.rows_affected() == 1,
            "Another near-head writer owns this domain"
        );
        Ok(())
    }
    fn domain(&self) -> Value {
        signed(self.domain).into()
    }

    pub async fn state(&self) -> Result<Option<State>> {
        self.db.query_one(sql(
            "SELECT indexed_height,indexed_hash,confirmed_height,verified_height,head_height,halted FROM scraper_head WHERE domain=$1",
            vec![self.domain()],
        )).await?.map(|row| Ok(State {
            indexed: u64::try_from(row.try_get::<i64>("", "indexed_height")?)?,
            hash: H256::from_slice(&row.try_get::<Vec<u8>>("", "indexed_hash")?),
            confirmed: u64::try_from(row.try_get::<i64>("", "confirmed_height")?)?,
            verified: row
                .try_get::<Option<i64>>("", "verified_height")?
                .map(u64::try_from)
                .transpose()?,
            head: u64::try_from(row.try_get::<i64>("", "head_height")?)?,
            halted: row.try_get("", "halted")?,
        })).transpose()
    }

    /// Only empty domains can start automatically. Neither stored maxima nor the
    /// shared legacy cursor prove that all four streams completed a cutover.
    pub async fn anchor_height(&self, index_from: u32) -> Result<u64> {
        if let Some(row) = self
            .db
            .query_one(sql(
                "SELECT start_height FROM scraper_head WHERE domain=$1",
                vec![self.domain()],
            ))
            .await?
        {
            return Ok(u64::try_from(row.try_get::<i64>("", "start_height")?)?);
        }
        self.ensure_empty_history(&self.db).await?;
        Ok(u64::from(index_from.saturating_sub(1)))
    }

    async fn ensure_empty_history<C: ConnectionTrait>(&self, db: &C) -> Result<()> {
        let row = db.query_one(sql(
            "SELECT EXISTS(SELECT 1 FROM block WHERE domain=$1) OR EXISTS(SELECT 1 FROM scraper_checkpoint WHERE domain=$1) OR EXISTS(SELECT 1 FROM raw_message_dispatch WHERE origin_domain=$1) OR EXISTS(SELECT 1 FROM delivered_message WHERE domain=$1) OR EXISTS(SELECT 1 FROM gas_payment WHERE domain=$1) OR EXISTS(SELECT 1 FROM merkle_tree_insertion WHERE domain=$1) AS has_history",
            vec![self.domain()],
        )).await?.ok_or_else(|| eyre::eyre!("Missing legacy history check"))?;
        ensure!(
            !row.try_get::<bool>("", "has_history")?,
            "Existing legacy history requires a verified cutover for all four event streams; stop legacy writers and follow docs/scraper/near-head.md before initializing scraper_head"
        );
        Ok(())
    }

    pub async fn initialize(&self, anchor: &Header, contracts: &Contracts) -> Result<()> {
        let tx = self.db.begin().await?;
        tx.execute(sql(
            "SELECT pg_advisory_xact_lock($1)",
            vec![i64::from(self.domain).into()],
        ))
        .await?;
        let previous = tx.query_one(sql("SELECT start_height,mailbox,merkle_tree_hook,interchain_gas_paymaster FROM scraper_head WHERE domain=$1 FOR UPDATE", vec![self.domain()])).await?;
        if let Some(row) = previous {
            ensure!(
                row.try_get::<i64>("", "start_height")? == i64::try_from(anchor.height)?
                    && row.try_get::<Vec<u8>>("", "mailbox")?
                        == address_to_bytes(&contracts.mailbox)
                    && row.try_get::<Vec<u8>>("", "merkle_tree_hook")?
                        == address_to_bytes(&contracts.hook)
                    && row.try_get::<Vec<u8>>("", "interchain_gas_paymaster")?
                        == address_to_bytes(&contracts.paymaster),
                "Near-head boundary or contracts changed; restore the original configuration"
            );
        } else {
            // Recheck after RPC preflight: another writer may have stored history
            // since anchor selection. Existing domains require operator cutover.
            self.ensure_empty_history(&tx).await?;
            tx.execute(sql(
                "INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster) VALUES($1,$2,$2,$3,$2,$2,$4,$5,$6)",
                vec![self.domain(), number(anchor.height)?, bytes(anchor.hash), address_to_bytes(&contracts.mailbox).into(), address_to_bytes(&contracts.hook).into(), address_to_bytes(&contracts.paymaster).into()],
            )).await?;
            tx.execute(sql(
                "INSERT INTO scraper_checkpoint(domain,hash,height,timestamp) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC')",
                vec![self.domain(), bytes(anchor.hash), number(anchor.height)?, number(anchor.timestamp)?],
            )).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn validate_contracts(&self, contracts: &Contracts) -> Result<()> {
        let row = self
            .db
            .query_one(sql(
                "SELECT mailbox,merkle_tree_hook,interchain_gas_paymaster FROM scraper_head WHERE domain=$1",
                vec![self.domain()],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing near-head configuration"))?;
        ensure!(
            row.try_get::<Vec<u8>>("", "mailbox")? == address_to_bytes(&contracts.mailbox)
                && row.try_get::<Vec<u8>>("", "merkle_tree_hook")?
                    == address_to_bytes(&contracts.hook)
                && row.try_get::<Vec<u8>>("", "interchain_gas_paymaster")?
                    == address_to_bytes(&contracts.paymaster),
            "Near-head contracts changed; restore the original configuration"
        );
        Ok(())
    }

    pub async fn validate_checkpoints(&self) -> Result<()> {
        let row = self.db.query_one(sql(
            "SELECT EXISTS(SELECT 1 FROM scraper_checkpoint c WHERE c.domain=h.domain AND c.height=h.confirmed_height) AS confirmed_exists, EXISTS(SELECT 1 FROM scraper_checkpoint c WHERE c.domain=h.domain AND c.height=h.indexed_height AND c.hash=h.indexed_hash) AS indexed_matches, NOT EXISTS(SELECT 1 FROM scraper_checkpoint c WHERE c.domain=h.domain AND c.height>h.indexed_height) AS no_stale_suffix FROM scraper_head h WHERE h.domain=$1",
            vec![self.domain()],
        )).await?.ok_or_else(|| eyre::eyre!("Missing checkpoint validation"))?;
        ensure!(
            row.try_get::<bool>("", "confirmed_exists")?
                && row.try_get::<bool>("", "indexed_matches")?
                && row.try_get::<bool>("", "no_stale_suffix")?,
            "Near-head checkpoints are out of sync; stop old scraper writers and repair scraper_checkpoint before restarting"
        );
        Ok(())
    }

    pub async fn hash(&self, height: u64) -> Result<Option<H256>> {
        self.db
            .query_one(sql(
                "SELECT hash FROM scraper_checkpoint WHERE domain=$1 AND height=$2",
                vec![self.domain(), number(height)?],
            ))
            .await?
            .map(|row| Ok(H256::from_slice(&row.try_get::<Vec<u8>>("", "hash")?)))
            .transpose()
    }

    /// Next expected sequences for all four streams in durable history.
    pub async fn sequence_counts(&self) -> Result<[u32; 4]> {
        let row = self.db.query_one(sql(
            "SELECT coalesce((SELECT max(nonce::bigint & 4294967295)+1 FROM raw_message_dispatch WHERE origin_domain=$1 AND origin_mailbox=(SELECT mailbox FROM scraper_head WHERE domain=$1)),0) AS dispatches, coalesce((SELECT max(sequence)+1 FROM delivered_message WHERE domain=$1 AND destination_mailbox=(SELECT mailbox FROM scraper_head WHERE domain=$1)),0) AS deliveries, coalesce((SELECT max(sequence)+1 FROM gas_payment WHERE domain=$1 AND interchain_gas_paymaster=(SELECT interchain_gas_paymaster FROM scraper_head WHERE domain=$1)),0) AS payments, coalesce((SELECT max(leaf_index::bigint & 4294967295)+1 FROM merkle_tree_insertion WHERE domain=$1 AND merkle_tree_hook=(SELECT merkle_tree_hook FROM scraper_head WHERE domain=$1)),0) AS insertions",
            vec![self.domain()],
        )).await?.ok_or_else(|| eyre::eyre!("Missing sequence counts"))?;
        Ok([
            u32::try_from(row.try_get::<i64>("", "dispatches")?)?,
            u32::try_from(row.try_get::<i64>("", "deliveries")?)?,
            u32::try_from(row.try_get::<i64>("", "payments")?)?,
            u32::try_from(row.try_get::<i64>("", "insertions")?)?,
        ])
    }

    /// A range may contain empty blocks whose headers were never fetched.
    pub async fn checkpoint(&self, through: u64) -> Result<u64> {
        let row = self.db.query_one(sql(
            "SELECT height FROM scraper_checkpoint WHERE domain=$1 AND height<=$2 ORDER BY height DESC LIMIT 1",
            vec![self.domain(), number(through)?],
        )).await?.ok_or_else(|| eyre::eyre!("Missing retained checkpoint"))?;
        Ok(u64::try_from(row.try_get::<i64>("", "height")?)?)
    }

    /// Newest retained checkpoint that can advance the confirmed frontier.
    pub async fn checkpoint_between(&self, after: u64, through: u64) -> Result<Option<u64>> {
        let row = self.db.query_one(sql(
            "SELECT max(height) AS height FROM scraper_checkpoint WHERE domain=$1 AND height>$2 AND height<=$3",
            vec![self.domain(), number(after)?, number(through)?],
        )).await?.ok_or_else(|| eyre::eyre!("Missing checkpoint result"))?;
        row.try_get::<Option<i64>>("", "height")?
            .map(u64::try_from)
            .transpose()
            .map_err(Into::into)
    }

    pub async fn pause(&self, halt: bool) -> Result<()> {
        let result = self
            .db
            .execute(sql(
                "UPDATE scraper_head SET healthy=false,halted=halted OR $2 WHERE domain=$1 AND (writer_id IS NULL OR writer_id=$3)",
                vec![self.domain(), halt.into(), writer_id().into()],
            ))
            .await?;
        ensure!(
            result.rows_affected() == 1,
            "Another near-head writer owns this domain"
        );
        Ok(())
    }

    pub async fn observe(&self, expected: &State, ancestor: &Header, head: &Header) -> Result<()> {
        let tx = self.db.begin().await?;
        let row = tx.query_one(sql("SELECT indexed_hash,confirmed_height,halted,writer_id FROM scraper_head WHERE domain=$1 FOR UPDATE", vec![self.domain()])).await?.ok_or_else(|| eyre::eyre!("Missing head state"))?;
        ensure!(
            !row.try_get::<bool>("", "halted")?
                && row
                    .try_get::<Option<String>>("", "writer_id")?
                    .as_deref()
                    .is_none_or(|id| id == writer_id())
                && row.try_get::<Vec<u8>>("", "indexed_hash")? == expected.hash.as_bytes(),
            "Head state changed"
        );
        ensure!(
            i64::try_from(ancestor.height)? >= row.try_get::<i64>("", "confirmed_height")?,
            "Reorg crossed confirmed history"
        );
        if ancestor.hash != expected.hash {
            for (table, domain, height) in EVENTS {
                tx.execute(sql(
                    format!("DELETE FROM {table} WHERE {domain}=$1 AND {height}>$2"),
                    vec![self.domain(), number(ancestor.height)?],
                ))
                .await?;
            }
            // Provisional blocks have no enriched transactions. FK failures stop
            // rollback rather than deleting data owned by another writer.
            tx.execute(sql(
                "DELETE FROM block WHERE domain=$1 AND height>$2",
                vec![self.domain(), number(ancestor.height)?],
            ))
            .await?;
            tx.execute(sql(
                "DELETE FROM scraper_checkpoint WHERE domain=$1 AND height>$2",
                vec![self.domain(), number(ancestor.height)?],
            ))
            .await?;
        }
        tx.execute(sql("UPDATE scraper_head SET indexed_height=$2,indexed_hash=$3,verified_height=CASE WHEN verified_height IS NULL THEN NULL ELSE least(verified_height,$2) END,head_height=$4,healthy=true,updated_at=clock_timestamp() WHERE domain=$1", vec![self.domain(), number(ancestor.height)?, bytes(ancestor.hash), number(head.height)?])).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn append(
        &self,
        expected: &State,
        blocks: &[(Header, Vec<Event>)],
        verified_through: Option<u64>,
    ) -> Result<()> {
        let mut previous = expected.hash;
        let mut height = expected.indexed;
        let mut batches = std::collections::BTreeMap::<&str, Vec<Vec<Value>>>::new();
        for (header, events) in blocks {
            ensure!(
                header.height > height
                    && header.height <= expected.head
                    && (header.height.checked_sub(1) != Some(height)
                        || header.parent.is_zero()
                        || header.parent == previous),
                "Invalid range checkpoint order"
            );
            let header_row = vec![
                self.domain(),
                bytes(header.hash),
                number(header.height)?,
                number(header.timestamp)?,
            ];
            batches.entry("INSERT INTO scraper_checkpoint(domain,hash,height,timestamp) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC')").or_default().push(header_row.clone());
            if !events.is_empty() {
                batches.entry("INSERT INTO block(domain,hash,height,timestamp) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC')").or_default().push(header_row);
            }
            for event in events {
                ensure!(
                    event.block_number == header.height && event.block_hash == header.hash,
                    "Event disagrees with block header"
                );
                let (query, values) = event_row(signed(self.domain), header, event)?;
                batches.entry(query).or_default().push(values);
            }
            previous = header.hash;
            height = header.height;
        }
        let tx = self.db.begin().await?;
        let row = tx
            .query_one(sql(
                "SELECT indexed_hash,healthy,halted,writer_id FROM scraper_head WHERE domain=$1 FOR UPDATE",
                vec![self.domain()],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing head state"))?;
        ensure!(
            row.try_get::<bool>("", "healthy")?
                && !row.try_get::<bool>("", "halted")?
                && row
                    .try_get::<Option<String>>("", "writer_id")?
                    .as_deref()
                    .is_none_or(|id| id == writer_id())
                && row.try_get::<Vec<u8>>("", "indexed_hash")? == expected.hash.as_bytes(),
            "Head changed during log fetch"
        );
        for (query, rows) in batches {
            insert_batch(&tx, query, &rows).await?;
        }
        tx.execute(sql(
            "UPDATE scraper_head SET indexed_height=$2,indexed_hash=$3,verified_height=CASE WHEN $4::bigint IS NULL THEN verified_height ELSE greatest(coalesce(verified_height,confirmed_height),$4) END,updated_at=clock_timestamp() WHERE domain=$1",
            vec![
                self.domain(),
                number(height)?,
                bytes(previous),
                verified_through.map(i64::try_from).transpose()?.into(),
            ],
        ))
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Bound publication by event work, while allowing empty spans to advance at once.
    /// A single block can exceed the budget: its events must publish atomically.
    pub async fn confirmation_boundary(&self, after: u64, through: u64) -> Result<u64> {
        ensure!(after <= through, "Confirmation range regressed");
        // Each branch returns at most 1,001 rows via its domain/height range.
        // All branches use their domain/height range indexes.
        // Limit before UNION so the merge sorts at most 4,004 event heights;
        // counting the entire eligible backlog would defeat this work budget.
        let branches = EVENTS.iter().map(|(table, domain, height)| {
            format!("(SELECT {height} AS height FROM {table} WHERE {domain}=$1 AND {height}>$2 AND {height}<=$3 ORDER BY {height} LIMIT 1001)")
        }).collect::<Vec<_>>().join(" UNION ALL ");
        let row = self
            .db
            .query_one(sql(
                format!(
                    r#"
            WITH events AS (
                SELECT height FROM ({branches}) AS candidates ORDER BY height LIMIT 1001
            )
            SELECT CASE WHEN count(*)<=1000 THEN $3
                WHEN min(height)=max(height) THEN max(height)
                ELSE max(height)-1 END AS boundary FROM events
        "#
                ),
                vec![self.domain(), number(after)?, number(through)?],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing confirmation boundary"))?;
        Ok(u64::try_from(row.try_get::<i64>("", "boundary")?)?)
    }

    pub async fn confirm(
        &self,
        expected: &State,
        boundary: &Header,
        lease: Duration,
    ) -> Result<[u64; 4]> {
        let through = boundary.height;
        ensure!(
            through <= expected.indexed,
            "Cannot confirm unindexed events"
        );
        if through <= expected.confirmed {
            return Ok([0; 4]);
        }
        let after = i64::try_from(expected.confirmed)?;
        let count_projection = EVENTS
            .iter()
            .map(|(table, domain, height)| {
                format!("(SELECT count(*) FROM {table} WHERE {domain}=$1 AND {height}>$2 AND {height}<=$3) AS {table}")
            })
            .collect::<Vec<_>>()
            .join(",");
        let count_row = self
            .db
            .query_one(sql(
                format!("SELECT {count_projection}"),
                vec![self.domain(), after.into(), number(through)?],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing confirmation counts"))?;
        let mut counts = [0; 4];
        for (index, (table, _, _)) in EVENTS.iter().enumerate() {
            counts[index] = u64::try_from(count_row.try_get::<i64>("", table)?)?;
        }

        let tx = self.db.begin().await?;
        // Prepare bounded publication work before taking the chain's progress
        // lock. Any stale observation rolls the whole transaction back.
        insert_checkpoint(&tx, signed(self.domain), boundary).await?;
        tx.execute(sql(
            "SELECT assign_confirmed_gas_payment_cursors($1,$2,$3)",
            vec![self.domain(), after.into(), number(through)?],
        ))
        .await?;
        tx.execute(sql(
            "DELETE FROM scraper_checkpoint WHERE domain=$1 AND height<$2",
            vec![self.domain(), number(through)?],
        ))
        .await?;
        let row = tx.query_one(sql(
            "SELECT indexed_hash,head_height,confirmed_height,writer_id,healthy AND NOT halted AND updated_at>clock_timestamp()-make_interval(secs=>$2) AS ready FROM scraper_head WHERE domain=$1 FOR UPDATE",
            vec![self.domain(), lease.as_secs_f64().into()],
        )).await?.ok_or_else(|| eyre::eyre!("Missing head state"))?;
        ensure!(
            row.try_get::<bool>("", "ready")?
                && row
                    .try_get::<Option<String>>("", "writer_id")?
                    .as_deref()
                    .is_none_or(|id| id == writer_id())
                && row.try_get::<i64>("", "head_height")? >= i64::try_from(expected.head)?
                && row.try_get::<i64>("", "confirmed_height")? == after
                && row.try_get::<Vec<u8>>("", "indexed_hash")? == expected.hash.as_bytes(),
            "Confirmation observation changed or expired"
        );
        tx.execute(sql(
            "UPDATE scraper_head SET confirmed_height=$2 WHERE domain=$1",
            vec![self.domain(), number(through)?],
        ))
        .await?;
        tx.commit().await?;
        Ok(counts)
    }

    /// Keyset batches avoid one permanently unavailable receipt starving later rows.
    pub async fn unenriched(&self, table: &str, after: i64) -> Result<Vec<(i64, LogMeta)>> {
        let column = transaction_column(table)?;
        let rows = self.db.query_all(sql(format!("SELECT id,block_number,block_hash,transaction_hash FROM confirmed_{table} WHERE domain=$1 AND {column} IS NULL AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL AND id>$2 ORDER BY id LIMIT 100"), vec![self.domain(), after.into()])).await?;
        rows.into_iter()
            .map(|r| {
                Ok((
                    r.try_get("", "id")?,
                    LogMeta {
                        block_number: u64::try_from(r.try_get::<i64>("", "block_number")?)?,
                        block_hash: hyperlane_core::H256::from_slice(
                            &r.try_get::<Vec<u8>>("", "block_hash")?,
                        ),
                        transaction_id: hyperlane_core::bytes_to_h512(
                            &r.try_get::<Vec<u8>>("", "transaction_hash")?,
                        ),
                        // Receipt fetching only needs the transaction and block identity.
                        ..LogMeta::default()
                    },
                ))
            })
            .collect()
    }

    pub async fn enrich(&self, table: &str, after: i64, through: i64) -> Result<()> {
        let column = transaction_column(table)?;
        self.db.execute(sql(format!("UPDATE {table} e SET {column}=t.id FROM \"transaction\" t JOIN block b ON b.id=t.block_id WHERE e.domain=$1 AND e.id>$2 AND e.id<=$3 AND (e.block_number IS NULL OR e.block_number<=COALESCE((SELECT h.confirmed_height FROM scraper_head h WHERE h.domain=e.domain),9223372036854775807)) AND e.{column} IS NULL AND t.hash=e.transaction_hash AND b.domain=e.domain AND b.hash=e.block_hash"), vec![self.domain(), after.into(), through.into()])).await?;
        Ok(())
    }
}

fn writer_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("{}-{started}", std::process::id())
    })
}

fn transaction_column(table: &str) -> Result<&'static str> {
    match table {
        "gas_payment" => Ok("tx_id"),
        "delivered_message" => Ok("destination_tx_id"),
        _ => eyre::bail!("Unsupported enrichment table"),
    }
}

async fn insert_checkpoint<C: ConnectionTrait>(db: &C, domain: i32, h: &Header) -> Result<()> {
    db.execute(sql("INSERT INTO scraper_checkpoint(domain,hash,height,timestamp) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC') ON CONFLICT(domain,height) DO NOTHING", vec![domain.into(), bytes(h.hash), number(h.height)?, number(h.timestamp)?])).await?;
    Ok(())
}

fn event_row(domain: i32, h: &Header, e: &Event) -> Result<(&'static str, Vec<Value>)> {
    let address = address_to_bytes(&e.address);
    // Legacy dispatch schema requires a transaction hash. Other near-head event
    // tables allow NULL so an unavailable receipt identity creates no backlog.
    let transaction_hash = match (&e.data, &e.tx_hash) {
        (_, Some(hash)) => Some(h512_to_bytes(hash)),
        (EventData::Dispatch(_), None) => Some(h512_to_bytes(&H512::zero())),
        _ => None,
    };
    let meta = vec![
        domain.into(),
        bytes(h.hash),
        number(h.height)?,
        transaction_hash.into(),
        number(e.tx_index)?,
        number(e.log_index)?,
        address.into(),
    ];
    let (query, extra) = match &e.data {
        EventData::Dispatch(m) => (
            "INSERT INTO raw_message_dispatch(origin_domain,origin_block_hash,origin_block_height,origin_tx_hash,transaction_index,log_index,origin_mailbox,msg_id,destination_domain,nonce,sender,recipient,msg_body,message_version,time_updated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())",
            vec![m.id().as_bytes().to_vec().into(), signed(m.destination).into(), signed(m.nonce).into(), address_to_bytes(&m.sender).into(), address_to_bytes(&m.recipient).into(), m.body.clone().into(), i16::from(m.version).into()],
        ),
        EventData::Delivery(id) => (
            "INSERT INTO delivered_message(domain,block_hash,block_number,transaction_hash,transaction_index,log_index,destination_mailbox,msg_id,sequence,time_created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
            vec![id.as_bytes().to_vec().into(), e.sequence.map(i64::from).into()],
        ),
        EventData::Insertion { message_id, index } => (
            "INSERT INTO merkle_tree_insertion(domain,block_hash,block_number,transaction_hash,transaction_index,log_index,merkle_tree_hook,message_id,leaf_index) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            vec![message_id.as_bytes().to_vec().into(), signed(*index).into()],
        ),
        EventData::Gas { message_id, destination, gas, payment } => (
            "INSERT INTO gas_payment(domain,block_hash,block_number,transaction_hash,transaction_index,log_index,interchain_gas_paymaster,msg_id,destination,gas_amount,payment,origin,sequence,time_created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text::numeric,$11::text::numeric,$1,$12,now())",
            vec![message_id.as_bytes().to_vec().into(), signed(*destination).into(), gas.clone().into(), payment.clone().into(), e.sequence.map(i64::from).into()],
        ),
    };
    Ok((query, meta.into_iter().chain(extra).collect()))
}

// At most 14,000 parameters per statement, below PostgreSQL's 65,535 limit.
async fn insert_batch<C: ConnectionTrait>(
    db: &C,
    template: &str,
    rows: &[Vec<Value>],
) -> Result<()> {
    let (prefix, tuple) = template
        .split_once(" VALUES")
        .ok_or_else(|| eyre::eyre!("Invalid insert template"))?;
    for chunk in rows.chunks(1000) {
        let mut values = Vec::new();
        let mut tuples = Vec::new();
        for row in chunk {
            let mut parts = tuple.split('$');
            let mut shifted = parts.next().unwrap_or_default().to_owned();
            for part in parts {
                let digits = part.bytes().take_while(u8::is_ascii_digit).count();
                let index = part[..digits]
                    .parse::<usize>()?
                    .checked_add(values.len())
                    .ok_or_else(|| eyre::eyre!("Parameter index overflow"))?;
                shifted.push_str(&format!("${index}{}", &part[digits..]));
            }
            tuples.push(shifted);
            values.extend(row.iter().cloned());
        }
        let conflict = if prefix.starts_with("INSERT INTO block(") {
            " ON CONFLICT(hash) DO NOTHING"
        } else {
            ""
        };
        db.execute(sql(
            format!("{prefix} VALUES{}{conflict}", tuples.join(",")),
            values,
        ))
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
