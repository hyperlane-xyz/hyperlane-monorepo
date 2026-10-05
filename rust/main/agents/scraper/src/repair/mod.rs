//! Explicit rollback of halted published history. Consumers are repaired separately.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Write,
    path::Path,
    time::Duration,
};

use ethers::{
    providers::Middleware,
    types::{BlockNumber, TransactionRequest, H160, H256, U256},
    utils::keccak256,
};
use eyre::{ensure, eyre, Result};
use sea_orm::{
    AccessMode, ConnectionTrait, DatabaseConnection, DbBackend, IsolationLevel, Statement,
    TransactionTrait, Value as SqlValue,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// Selection and deletion order matters: dependent rows precede their parents.
// These SQL fragments are constants, never supplied by the plan file.
const TRANSACTIONS: &str = "SELECT t.id FROM \"transaction\" t JOIN block b ON b.id=t.block_id WHERE b.domain=$1 AND b.height>$2";
const DISPATCHES: &str =
    "SELECT msg_id FROM raw_message_dispatch WHERE origin_domain=$1 AND origin_block_height>$2";

fn scopes() -> Vec<(&'static str, String, &'static str)> {
    vec![
        ("gas_payment_stream_cursor", format!("gas_payment_id IN (SELECT id FROM gas_payment WHERE domain=$1 AND (block_number>$2 OR tx_id IN ({TRANSACTIONS})))"), "gas_payment_id"),
        ("message", format!("origin=$1 AND (msg_id IN ({DISPATCHES}) OR origin_tx_id IN ({TRANSACTIONS}))"), "id"),
        ("delivered_message", format!("domain=$1 AND (block_number>$2 OR destination_tx_id IN ({TRANSACTIONS}))"), "id"),
        ("gas_payment", format!("domain=$1 AND (block_number>$2 OR tx_id IN ({TRANSACTIONS}))"), "id"),
        ("merkle_tree_insertion", "domain=$1 AND block_number>$2".into(), "id"),
        ("raw_message_dispatch", "origin_domain=$1 AND origin_block_height>$2".into(), "id"),
        ("transaction", format!("id IN ({TRANSACTIONS})"), "id"),
        ("block", "domain=$1 AND height>$2".into(), "id"),
        ("cursor", "domain=$1 AND height>$2".into(), "id"),
        ("scraper_checkpoint", "domain=$1 AND $2>=0".into(), "height"),
        // Archive and compare these, but never rewind/reuse allocated stream cursors.
        ("gas_payment_stream_head", "domain=$1 AND $2>=0".into(), "interchain_gas_paymaster"),
    ]
}

const LOCKS: &str = "LOCK TABLE scraper_head, raw_message_dispatch, message, delivered_message, gas_payment, merkle_tree_insertion, \"transaction\", block, cursor, scraper_checkpoint, gas_payment_stream_cursor, gas_payment_stream_head IN SHARE ROW EXCLUSIVE MODE";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Header {
    height: i64,
    hash: H256,
    timestamp: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Inventory {
    rows: usize,
    digest: H256,
    message_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Plan {
    version: u32,
    domain: u32,
    chain_id: U256,
    database: String,
    head: Value,
    ancestor: Header,
    observed_head: Header,
    max_rewind: u64,
    max_rows: usize,
    rewind_blocks: i64,
    confirmed_rewind_blocks: i64,
    affected: BTreeMap<String, Inventory>,
    consumer_recovery: String,
}

type Rows = BTreeMap<String, Vec<String>>;

fn sql(query: impl Into<String>, values: Vec<SqlValue>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

// Domains are stored as signed 32-bit bit patterns throughout the scraper schema.
fn domain_value(domain: u32) -> SqlValue {
    i32::from_ne_bytes(domain.to_ne_bytes()).into()
}

fn params(domain: u32, height: i64) -> Vec<SqlValue> {
    vec![domain_value(domain), height.into()]
}

fn integer(value: &Value, field: &str) -> Result<i64> {
    value[field]
        .as_i64()
        .ok_or_else(|| eyre!("Missing integer {field}"))
}

async fn head(db: &impl ConnectionTrait, domain: u32) -> Result<Value> {
    let row = db.query_one(sql("SELECT to_jsonb(h) - 'writer_id' - 'writer_lease_until' - 'updated_at' AS data FROM scraper_head h WHERE domain=$1", vec![domain_value(domain)])).await?
        .ok_or_else(|| eyre!("No saved near-head state for domain {domain}"))?;
    let value: Value = row.try_get("", "data")?;
    ensure!(
        value["halted"] == true,
        "Repair requires a persistently halted domain"
    );
    Ok(value)
}

async fn database_name(db: &impl ConnectionTrait) -> Result<String> {
    Ok(db
        .query_one(sql("SELECT current_database() AS name", vec![]))
        .await?
        .ok_or_else(|| eyre!("Missing database name"))?
        .try_get("", "name")?)
}

async fn rpc_header(rpc: &impl Middleware, number: BlockNumber) -> Result<Header> {
    let block = tokio::time::timeout(Duration::from_secs(30), rpc.get_block(number))
        .await?
        .map_err(|_| eyre!("RPC block lookup failed"))?
        .ok_or_else(|| eyre!("RPC block missing"))?;
    Ok(Header {
        height: i64::try_from(
            block
                .number
                .ok_or_else(|| eyre!("Block number missing"))?
                .as_u64(),
        )?,
        hash: block.hash.ok_or_else(|| eyre!("Block hash missing"))?,
        timestamp: i64::try_from(block.timestamp.as_u128())?,
    })
}

async fn at(rpc: &impl Middleware, height: i64) -> Result<Header> {
    let header = rpc_header(rpc, u64::try_from(height)?.into()).await?;
    ensure!(
        header.height == height,
        "RPC returned a different block height"
    );
    Ok(header)
}

async fn chain_id(rpc: &impl Middleware) -> Result<U256> {
    tokio::time::timeout(Duration::from_secs(30), rpc.get_chainid())
        .await?
        .map_err(|_| eyre!("RPC chain ID lookup failed"))
}

async fn verify_domain(rpc: &impl Middleware, head: &Value, domain: u32, hash: H256) -> Result<()> {
    let address = head["mailbox"]
        .as_str()
        .and_then(|s| s.strip_prefix("\\x"))
        .ok_or_else(|| eyre!("Invalid saved mailbox"))?;
    let call = TransactionRequest::new()
        .to(address.parse::<H160>()?)
        .data(ethers::utils::id("localDomain()")[..4].to_vec())
        .into();
    let result = tokio::time::timeout(Duration::from_secs(30), rpc.call(&call, Some(hash.into())))
        .await?
        .map_err(|_| eyre!("RPC mailbox localDomain lookup failed"))?;
    ensure!(
        result.len() == 32 && U256::from_big_endian(&result) == U256::from(domain),
        "RPC mailbox domain does not match repair domain"
    );
    Ok(())
}

async fn verify_chain(rpc: &impl Middleware, plan: &Plan) -> Result<()> {
    ensure!(
        chain_id(rpc).await? == plan.chain_id,
        "RPC chain ID changed"
    );
    ensure!(
        at(rpc, plan.ancestor.height).await? == plan.ancestor,
        "Repair ancestor changed; inspect again"
    );
    ensure!(
        at(rpc, plan.observed_head.height).await? == plan.observed_head,
        "Observed chain changed; inspect again"
    );
    verify_domain(rpc, &plan.head, plan.domain, plan.observed_head.hash).await
}

async fn snapshot(
    db: &impl ConnectionTrait,
    domain: u32,
    height: i64,
    max_rows: usize,
) -> Result<Rows> {
    ensure!(max_rows > 0, "max-rows must be positive");
    // Height-less legacy/CCR rows need transaction provenance to locate them.
    // An unlocated event could be orphaned; never silently retain it.
    let unknown = db.query_one(sql(
        "SELECT EXISTS(SELECT 1 FROM delivered_message WHERE domain=$1 AND block_number IS NULL AND destination_tx_id IS NULL) OR EXISTS(SELECT 1 FROM gas_payment WHERE domain=$1 AND block_number IS NULL AND tx_id IS NULL) OR EXISTS(SELECT 1 FROM message m WHERE origin=$1 AND origin_tx_id IS NULL AND NOT EXISTS(SELECT 1 FROM raw_message_dispatch r WHERE r.origin_domain=m.origin AND r.msg_id=m.msg_id)) AS unknown",
        vec![domain_value(domain)])).await?.ok_or_else(|| eyre!("Missing provenance check"))?;
    ensure!(
        !unknown.try_get::<bool>("", "unknown")?,
        "Unlocated legacy events/messages require a provenance audit before repair"
    );
    let mut snapshot = Rows::new();
    let mut remaining = max_rows;
    for (table, predicate, order) in scopes() {
        let limit = i64::try_from(remaining)?
            .checked_add(1)
            .ok_or_else(|| eyre!("Row limit overflow"))?;
        let mut values = params(domain, height);
        values.push(limit.into());
        // Text roundtrip preserves arbitrary-precision numeric database values in
        // the archive (JSON numbers would otherwise lose payment precision).
        let rows = db.query_all(sql(format!("SELECT row_to_json(r)::text AS data FROM (SELECT * FROM \"{table}\" WHERE {predicate} ORDER BY {order} LIMIT $3) r"), values)).await?;
        ensure!(
            rows.len() <= remaining,
            "Repair exceeds max-rows; inspect with a reviewed larger bound"
        );
        remaining = remaining
            .checked_sub(rows.len())
            .ok_or_else(|| eyre!("Row limit exceeded"))?;
        let rows = rows
            .into_iter()
            .map(|r| Ok(r.try_get::<String>("", "data")?))
            .collect::<Result<Vec<_>>>()?;
        if table == "cursor" {
            for row in &rows {
                let cursor: Value = serde_json::from_str(row)?;
                ensure!(
                    matches!(cursor["event_type"].as_str(), Some("" | "ccr_swap")),
                    "Unsupported cursor kind in rewind range"
                );
            }
        }
        snapshot.insert(table.to_owned(), rows);
    }
    Ok(snapshot)
}

fn inventory(rows: &Rows) -> Result<BTreeMap<String, Inventory>> {
    rows.iter()
        .map(|(table, rows)| {
            let mut message_ids = BTreeSet::new();
            for row in rows {
                let value: Value = serde_json::from_str(row)?;
                if let Some(id) = value["msg_id"]
                    .as_str()
                    .or_else(|| value["message_id"].as_str())
                {
                    message_ids.insert(id.to_owned());
                }
            }
            Ok((
                table.clone(),
                Inventory {
                    rows: rows.len(),
                    digest: H256::from(keccak256(serde_json::to_vec(rows)?)),
                    message_ids: message_ids.into_iter().collect(),
                },
            ))
        })
        .collect()
}

pub(super) async fn inspect(
    db: &DatabaseConnection,
    rpc: &impl Middleware,
    domain: u32,
    max_rewind: u64,
    max_rows: usize,
) -> Result<Plan> {
    ensure!(max_rewind > 0, "max-rewind must be positive");
    let tx = db
        .begin_with_config(
            Some(IsolationLevel::RepeatableRead),
            Some(AccessMode::ReadOnly),
        )
        .await?;
    tx.execute_unprepared("SET LOCAL statement_timeout='60s'")
        .await?;
    let head = head(&tx, domain).await?;
    let indexed = integer(&head, "indexed_height")?;
    let confirmed = integer(&head, "confirmed_height")?;
    let lower =
        integer(&head, "start_height")?.max(indexed.saturating_sub(i64::try_from(max_rewind)?));
    let observed_head = rpc_header(rpc, BlockNumber::Latest).await?;
    ensure!(
        observed_head.height >= indexed,
        "RPC is behind saved progress"
    );
    let candidates = tx.query_all(sql(
        "SELECT height,hash FROM (SELECT height,hash FROM scraper_checkpoint WHERE domain=$1 AND height BETWEEN $2 AND $3 UNION SELECT height,hash FROM block WHERE domain=$1 AND height BETWEEN $2 AND $3) c ORDER BY height DESC",
        vec![domain_value(domain), lower.into(), confirmed.into()])).await?;
    let mut ancestor = None;
    for row in candidates {
        let height: i64 = row.try_get("", "height")?;
        let canonical = at(rpc, height).await?;
        let hash: Vec<u8> = row.try_get("", "hash")?;
        if hash == canonical.hash.as_bytes() {
            ancestor = Some(canonical);
            break;
        }
    }
    let ancestor = ancestor.ok_or_else(|| eyre!("No retained canonical ancestor inside max-rewind/start-height bounds; restore/audit older history"))?;
    verify_anchor(&tx, domain, &ancestor).await?;
    let rows = snapshot(&tx, domain, ancestor.height, max_rows).await?;
    let plan = Plan {
        version: 1, domain, chain_id: chain_id(rpc).await?, database: database_name(&tx).await?, head,
        rewind_blocks: indexed.checked_sub(ancestor.height).ok_or_else(|| eyre!("Invalid rewind"))?,
        confirmed_rewind_blocks: confirmed.checked_sub(ancestor.height).ok_or_else(|| eyre!("Invalid confirmed rewind"))?,
        ancestor, observed_head, max_rewind, max_rows, affected: inventory(&rows)?,
        consumer_recovery: "Pause affected consumers. Reconcile dispatch/Merkle state and gas accounting, reset affected caches/cursors, then replay. Database repair cannot retract executed transactions. Keep gas stream cursor allocation monotonic.".into(),
    };
    verify_chain(rpc, &plan).await?;
    tx.commit().await?;
    Ok(plan)
}

async fn verify_anchor(db: &impl ConnectionTrait, domain: u32, anchor: &Header) -> Result<()> {
    let rows = db.query_all(sql("SELECT hash FROM scraper_checkpoint WHERE domain=$1 AND height=$2 UNION SELECT hash FROM block WHERE domain=$1 AND height=$2", params(domain, anchor.height))).await?;
    ensure!(!rows.is_empty(), "Ancestor is no longer retained");
    for row in rows {
        ensure!(
            row.try_get::<Vec<u8>>("", "hash")? == anchor.hash.as_bytes(),
            "Stored ancestor hashes disagree"
        );
    }
    Ok(())
}

/// Never overwrite a plan/archive. Sync data and directory before database writes.
pub(super) fn write_new(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub(super) async fn apply(
    db: &DatabaseConnection,
    rpc: &impl Middleware,
    plan: &Plan,
    archive: &Path,
    writer_roles: &[String],
    recovery_reference: &str,
) -> Result<()> {
    ensure!(plan.version == 1, "Unsupported repair plan version");
    ensure!(
        !writer_roles.is_empty() && writer_roles.iter().all(|r| !r.trim().is_empty()),
        "List every scraper writer role"
    );
    ensure!(
        !recovery_reference.trim().is_empty(),
        "Record the consumer recovery procedure before applying"
    );
    ensure!(
        plan.ancestor.height >= integer(&plan.head, "start_height")?
            && plan.ancestor.height <= integer(&plan.head, "confirmed_height")?,
        "Ancestor outside saved history"
    );
    let depth = integer(&plan.head, "indexed_height")?
        .checked_sub(plan.ancestor.height)
        .ok_or_else(|| eyre!("Invalid rewind depth"))?;
    ensure!(
        u64::try_from(depth)? <= plan.max_rewind,
        "Rewind exceeds planned bound"
    );
    verify_chain(rpc, plan).await?;
    let tx = db.begin().await?;
    tx.execute_unprepared("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'; SET LOCAL idle_in_transaction_session_timeout='120s'").await?;
    tx.execute_unprepared(LOCKS).await?;
    for role in writer_roles {
        let row = tx.query_one(sql("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()) AS active, EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1) AS known", vec![role.clone().into()])).await?.ok_or_else(|| eyre!("Missing writer check"))?;
        ensure!(
            row.try_get::<bool>("", "known")?,
            "Unknown writer role: {role}"
        );
        ensure!(
            !row.try_get::<bool>("", "active")?,
            "Writer connections still present for {role}"
        );
    }
    let active = tx.query_one(sql("SELECT EXISTS(SELECT 1 FROM scraper_head WHERE writer_lease_until>clock_timestamp()) AS active", vec![])).await?.ok_or_else(|| eyre!("Missing lease check"))?;
    ensure!(
        !active.try_get::<bool>("", "active")?,
        "Live scraper leases remain; stop all writers and wait for lease expiry"
    );
    ensure!(database_name(&tx).await? == plan.database, "Wrong database");
    ensure!(
        head(&tx, plan.domain).await? == plan.head,
        "Saved head changed; inspect again"
    );
    verify_anchor(&tx, plan.domain, &plan.ancestor).await?;
    let rows = snapshot(&tx, plan.domain, plan.ancestor.height, plan.max_rows).await?;
    ensure!(
        inventory(&rows)? == plan.affected,
        "Affected rows changed; inspect again"
    );
    let saved_head: Value = tx
        .query_one(sql(
            "SELECT to_jsonb(h) AS data FROM scraper_head h WHERE domain=$1",
            vec![domain_value(plan.domain)],
        ))
        .await?
        .ok_or_else(|| eyre!("Head disappeared"))?
        .try_get("", "data")?;
    write_new(
        archive,
        &serde_json::json!({
            "plan": plan, "head_before": saved_head, "rows_before": rows,
            "consumer_recovery_reference": recovery_reference,
            "status": "pre-apply archive; existence does not prove commit; verify database head",
        }),
    )?;
    for (table, predicate, _) in scopes() {
        if table == "gas_payment_stream_head" {
            continue;
        }
        let query = if table == "cursor" {
            format!("UPDATE cursor SET height=$2 WHERE {predicate}")
        } else {
            format!("DELETE FROM \"{table}\" WHERE {predicate}")
        };
        let result = tx
            .execute(sql(query, params(plan.domain, plan.ancestor.height)))
            .await?;
        let expected = plan
            .affected
            .get(table)
            .ok_or_else(|| eyre!("Missing table inventory"))?
            .rows;
        ensure!(
            result.rows_affected() == u64::try_from(expected)?,
            "Repair row count changed for {table}"
        );
    }
    tx.execute(sql("INSERT INTO scraper_checkpoint(domain,height,hash,timestamp) VALUES($1,$2,$3,to_timestamp($4::bigint) AT TIME ZONE 'UTC')", vec![domain_value(plan.domain), plan.ancestor.height.into(), plan.ancestor.hash.as_bytes().to_vec().into(), plan.ancestor.timestamp.into()])).await?;
    tx.execute(sql("UPDATE scraper_head SET indexed_height=$2,indexed_hash=$3,confirmed_height=$2,head_height=$2,healthy=false,halted=false,writer_id=NULL,writer_lease_until=NULL,updated_at=clock_timestamp() WHERE domain=$1", vec![domain_value(plan.domain), plan.ancestor.height.into(), plan.ancestor.hash.as_bytes().to_vec().into()])).await?;
    // Do not commit a rewind if the canonical chain changed during archive/DML.
    verify_chain(rpc, plan).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests;
