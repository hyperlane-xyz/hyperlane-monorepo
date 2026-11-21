use eyre::Result;
use sea_orm::{
    prelude::*, ConnectionTrait, DatabaseTransaction, FromQueryResult, QuerySelect, Statement,
    TransactionTrait,
};
use tracing::instrument;

use hyperlane_core::{
    address_to_bytes, bytes_to_address, bytes_to_h512, HyperlaneMessage, LogMeta, H256, U256,
};

use crate::db::ScraperDb;

use super::{generated::raw_message_dispatch, StorableMessage};

#[derive(Debug, Clone)]
pub struct RawDispatchForEnrichment {
    pub raw_id: i64,
    pub time_created: TimeDateTime,
    pub msg_id: H256,
    pub msg: HyperlaneMessage,
    pub meta: LogMeta,
}

impl RawDispatchForEnrichment {
    pub fn storable_message(&self, txn_id: Option<i64>) -> StorableMessage {
        StorableMessage {
            msg: self.msg.clone(),
            txn_id,
            id_override: Some(self.msg_id),
        }
    }
}

impl ScraperDb {
    async fn begin_reconciliation_read(&self) -> Result<DatabaseTransaction> {
        let tx = self.0.begin().await?;
        // Apply the deadline on the server and keep any stricter session limit.
        tx.execute_unprepared(
            r#"SELECT set_config(
                'statement_timeout',
                CASE
                    WHEN current_setting('statement_timeout')::interval
                         BETWEEN INTERVAL '1ms' AND INTERVAL '2s'
                    THEN current_setting('statement_timeout')
                    ELSE '2s'
                END,
                true
            )"#,
        )
        .await?;
        Ok(tx)
    }

    /// Get the latest raw dispatch that can become a reconciliation candidate.
    ///
    /// This snapshots a stable upper bound for a discovery or completeness scan.
    /// Filtering on `msg_body` also lets Postgres use the reconciliation partial
    /// index instead of walking raw rows that can never be enriched.
    pub async fn latest_reconcilable_raw_dispatch_id(
        &self,
        origin_domain: u32,
        origin_mailbox: &H256,
    ) -> Result<i64> {
        let tx = self.begin_reconciliation_read().await?;
        let result = raw_message_dispatch::Entity::find()
            // Bind the domain directly so PostgreSQL reads the confirmed height once.
            .filter(Expr::cust_with_values(
                "raw_message_dispatch.origin_block_height <= COALESCE(
                    (SELECT confirmed_height FROM scraper_head WHERE domain = $1), 9223372036854775807
                )",
                [origin_domain as i32],
            ))
            .select_only()
            .column_as(raw_message_dispatch::Column::Id.max(), "max_id")
            .filter(raw_message_dispatch::Column::OriginDomain.eq(origin_domain as i32))
            .filter(
                raw_message_dispatch::Column::OriginMailbox.eq(address_to_bytes(origin_mailbox)),
            )
            .filter(raw_message_dispatch::Column::MsgBody.is_not_null())
            .into_tuple::<Option<i64>>()
            .one(&tx)
            .await?;
        tx.commit().await?;

        Ok(result
            .ok_or_else(|| eyre::eyre!("Error getting latest reconcilable raw dispatch id"))?
            .unwrap_or(0))
    }

    #[instrument(skip(self))]
    pub async fn retrieve_unenriched_raw_dispatches(
        &self,
        origin_domain: u32,
        origin_mailbox: &H256,
        after_id: i64,
        through_id: i64,
        limit: u64,
    ) -> Result<(Vec<RawDispatchForEnrichment>, Option<i64>)> {
        let tx = self.begin_reconciliation_read().await?;
        let rows = tx.query_all(Statement::from_sql_and_values(
            tx.get_database_backend(),
            r#"
            WITH page AS (
                SELECT id, origin_domain, origin_mailbox, nonce, origin_block_height FROM raw_message_dispatch
                WHERE origin_domain=$1 AND origin_mailbox=$2 AND msg_body IS NOT NULL
                  AND id>$3 AND id<=$4 ORDER BY id LIMIT 2000
            ), candidates AS (
                SELECT r.id FROM page r
                WHERE r.origin_block_height <= COALESCE(
                    (SELECT confirmed_height FROM scraper_head WHERE domain=$1), 9223372036854775807)
                  AND NOT EXISTS (SELECT 1 FROM message m WHERE m.origin=r.origin_domain
                    AND m.origin_mailbox=r.origin_mailbox AND m.nonce=r.nonce)
                ORDER BY r.id LIMIT $5
            ), cursor AS (
                SELECT CASE WHEN count(*)=$5 THEN max(id)
                    WHEN (SELECT count(*) FROM page)=2000 THEN (SELECT max(id) FROM page)
                    END AS next_after_id FROM candidates
            )
            SELECT r.*, cursor.next_after_id FROM cursor LEFT JOIN candidates ON TRUE
            LEFT JOIN LATERAL (SELECT * FROM raw_message_dispatch WHERE id=candidates.id LIMIT 1) r ON TRUE
            ORDER BY candidates.id
            "#,
            [(origin_domain as i32).into(), address_to_bytes(origin_mailbox).into(),
                after_id.into(), through_id.into(), (limit as i64).into()],
        )).await?;
        tx.commit().await?;
        let mut candidates = Vec::new();
        let mut next = None;
        for row in rows {
            next = row
                .try_get::<Option<i64>>("", "next_after_id")?
                .filter(|id| *id < through_id);
            if row.try_get::<Option<i64>>("", "id")?.is_some() {
                candidates.push(raw_dispatch_to_candidate(
                    raw_message_dispatch::Model::from_query_result(&row, "")?,
                )?);
            }
        }
        Ok((candidates, next))
    }

    /// Re-read known retry rows by primary key while excluding rows that another
    /// writer has already enriched. The retry batch is bounded by the caller.
    pub async fn retrieve_unenriched_raw_dispatches_by_ids(
        &self,
        origin_domain: u32,
        origin_mailbox: &H256,
        raw_ids: &[i64],
    ) -> Result<Vec<RawDispatchForEnrichment>> {
        if raw_ids.is_empty() {
            return Ok(Vec::new());
        }

        let tx = self.begin_reconciliation_read().await?;
        let raw_dispatches = raw_message_dispatch::Entity::find()
            .from_raw_sql(Statement::from_sql_and_values(
                tx.get_database_backend(),
                r#"
                SELECT raw_message_dispatch.*
                FROM raw_message_dispatch
                WHERE raw_message_dispatch.origin_domain = $1
                  AND raw_message_dispatch.origin_mailbox = $2
                  AND raw_message_dispatch.msg_body IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM message m
                    WHERE m.origin = raw_message_dispatch.origin_domain
                      AND m.origin_mailbox = raw_message_dispatch.origin_mailbox
                      AND m.nonce = raw_message_dispatch.nonce)
                  AND raw_message_dispatch.id = ANY($3)
                  AND raw_message_dispatch.origin_block_height <= COALESCE(
                    (SELECT confirmed_height FROM scraper_head WHERE domain = $1), 9223372036854775807
                  )
                ORDER BY raw_message_dispatch.id ASC
                "#,
                [
                    (origin_domain as i32).into(),
                    address_to_bytes(origin_mailbox).into(),
                    raw_ids.to_vec().into(),
                ],
            ))
            .all(&tx)
            .await?;
        tx.commit().await?;

        raw_dispatches
            .into_iter()
            .map(raw_dispatch_to_candidate)
            .collect()
    }
}

fn raw_dispatch_to_candidate(raw: raw_message_dispatch::Model) -> Result<RawDispatchForEnrichment> {
    let body = raw
        .msg_body
        .ok_or_else(|| eyre::eyre!("raw message dispatch missing msg_body"))?;
    let origin_mailbox = bytes_to_address(raw.origin_mailbox)?;

    Ok(RawDispatchForEnrichment {
        raw_id: raw.id,
        time_created: raw.time_created,
        msg_id: H256::from_slice(&raw.msg_id),
        msg: HyperlaneMessage {
            version: 3,
            nonce: raw.nonce as u32,
            origin: raw.origin_domain as u32,
            destination: raw.destination_domain as u32,
            sender: bytes_to_address(raw.sender)?,
            recipient: bytes_to_address(raw.recipient)?,
            body,
        },
        meta: LogMeta {
            address: origin_mailbox,
            block_number: raw.origin_block_height as u64,
            block_hash: H256::from_slice(&raw.origin_block_hash),
            transaction_id: bytes_to_h512(&raw.origin_tx_hash),
            transaction_index: 0,
            log_index: U256::zero(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::{h256_to_bytes, h512_to_bytes, H512};
    use migration::MigratorTrait;
    use sea_orm::{ConnectOptions, Database, DbBackend, IntoActiveModel};
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;
    use time::{
        macros::{date, time},
        PrimitiveDateTime,
    };

    fn create_test_message(nonce: u32, origin: u32, destination: u32) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce,
            origin,
            destination,
            sender: H256::from_low_u64_be(100),
            recipient: H256::from_low_u64_be(200),
            body: vec![1, 2, 3, 4],
        }
    }
    #[test]
    fn test_raw_dispatch_to_candidate_preserves_body_and_msg_id() {
        let msg = create_test_message(42, 1, 2);
        let msg_id = msg.id();
        let tx_hash = H512::from_low_u64_be(5);
        let block_hash = H256::from_low_u64_be(100);
        let mailbox = H256::from_low_u64_be(999);
        let raw = raw_message_dispatch::Model {
            id: 1,
            time_created: PrimitiveDateTime::new(date!(2024 - 01 - 01), time!(0:00)),
            time_updated: PrimitiveDateTime::new(date!(2024 - 01 - 01), time!(0:00)),
            msg_id: h256_to_bytes(&msg_id),
            origin_tx_hash: h512_to_bytes(&tx_hash),
            origin_block_hash: h256_to_bytes(&block_hash),
            origin_block_height: 100,
            nonce: msg.nonce as i32,
            origin_domain: msg.origin as i32,
            destination_domain: msg.destination as i32,
            sender: address_to_bytes(&msg.sender),
            recipient: address_to_bytes(&msg.recipient),
            origin_mailbox: address_to_bytes(&mailbox),
            msg_body: Some(msg.body.clone()),
        };

        let candidate = raw_dispatch_to_candidate(raw).unwrap();
        let storable = candidate.storable_message(Some(7));

        assert_eq!(candidate.msg_id, msg_id);
        assert_eq!(candidate.raw_id, 1);
        assert_eq!(candidate.msg, msg);
        assert_eq!(candidate.meta.address, mailbox);
        assert_eq!(candidate.meta.block_number, 100);
        assert_eq!(candidate.meta.block_hash, block_hash);
        assert_eq!(candidate.meta.transaction_id, tx_hash);
        assert_eq!(storable.id_override, Some(msg_id));
        assert_eq!(storable.txn_id, Some(7));
    }

    #[tokio::test]
    async fn reconciliation_scopes_pages_and_rediscovers_late_bodies() -> Result<()> {
        let postgres = Postgres::default().start().await?;
        let port = postgres.get_host_port_ipv4(5432).await?;
        let connection = Database::connect(format!(
            "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
        ))
        .await?;
        migration::Migrator::up(&connection, None).await?;
        let db = ScraperDb::with_connection(connection);
        let mailbox = H256::from_low_u64_be(999);
        for id in 1..=5 {
            let msg = create_test_message(id as u32, 1, 2);
            raw_message_dispatch::Entity::insert(
                raw_message_dispatch::Model {
                    id,
                    time_created: crate::date_time::now(),
                    time_updated: crate::date_time::now(),
                    msg_id: h256_to_bytes(&msg.id()),
                    origin_tx_hash: h512_to_bytes(&H512::zero()),
                    origin_block_hash: h256_to_bytes(&H256::zero()),
                    origin_block_height: id,
                    nonce: msg.nonce as i32,
                    origin_domain: 1,
                    destination_domain: 2,
                    sender: address_to_bytes(&msg.sender),
                    recipient: address_to_bytes(&msg.recipient),
                    origin_mailbox: address_to_bytes(&mailbox),
                    msg_body: Some(msg.body),
                }
                .into_active_model(),
            )
            .exec(&db.0)
            .await?;
        }
        db.0.execute_unprepared("UPDATE raw_message_dispatch SET msg_body=NULL WHERE id=1")
            .await?;
        let msg = create_test_message(2, 1, 2);
        db.store_dispatched_messages(
            1,
            &mailbox,
            [StorableMessage {
                msg,
                txn_id: None,
                id_override: None,
            }]
            .into_iter(),
        )
        .await?;
        assert_eq!(
            db.latest_reconcilable_raw_dispatch_id(1, &mailbox).await?,
            5
        );
        assert_eq!(
            db.latest_reconcilable_raw_dispatch_id(2, &mailbox).await?,
            0
        );
        assert_eq!(
            db.latest_reconcilable_raw_dispatch_id(1, &H256::zero())
                .await?,
            0
        );
        let (page, next) = db
            .retrieve_unenriched_raw_dispatches(1, &mailbox, 0, 5, 2)
            .await?;
        assert_eq!(
            page.iter().map(|r| r.raw_id).collect::<Vec<_>>(),
            vec![3, 4]
        );
        assert_eq!(next, Some(4));
        let (tail, _) = db
            .retrieve_unenriched_raw_dispatches(1, &mailbox, 4, 5, 2)
            .await?;
        assert_eq!(tail.iter().map(|r| r.raw_id).collect::<Vec<_>>(), vec![5]);
        let (bounded, _) = db
            .retrieve_unenriched_raw_dispatches(1, &mailbox, 0, 3, 10)
            .await?;
        assert_eq!(
            bounded.iter().map(|r| r.raw_id).collect::<Vec<_>>(),
            vec![3]
        );
        let direct = db
            .retrieve_unenriched_raw_dispatches_by_ids(1, &mailbox, &[1, 2, 3])
            .await?;
        assert_eq!(direct.iter().map(|r| r.raw_id).collect::<Vec<_>>(), vec![3]);
        assert!(db
            .retrieve_unenriched_raw_dispatches(2, &mailbox, 0, 5, 10)
            .await?
            .0
            .is_empty());
        assert!(db
            .retrieve_unenriched_raw_dispatches_by_ids(1, &H256::zero(), &[3])
            .await?
            .is_empty());
        db.0.execute_unprepared(
            "UPDATE raw_message_dispatch SET msg_body=decode('01','hex') WHERE id=1",
        )
        .await?;
        assert!(db
            .retrieve_unenriched_raw_dispatches(1, &mailbox, 4, 5, 10)
            .await?
            .0
            .iter()
            .all(|r| r.raw_id != 1));
        let (sweep, _) = db
            .retrieve_unenriched_raw_dispatches(1, &mailbox, 0, 4, 10)
            .await?;
        assert_eq!(
            sweep.iter().map(|r| r.raw_id).collect::<Vec<_>>(),
            vec![1, 3, 4]
        );
        db.0.execute_unprepared(
            r#"INSERT INTO scraper_head (
                domain, start_height, indexed_height, indexed_hash, head_height,
                confirmed_height, mailbox, merkle_tree_hook, interchain_gas_paymaster
            ) SELECT 1, 0, 5, origin_block_hash, 5, 3, origin_mailbox, origin_mailbox, origin_mailbox
              FROM raw_message_dispatch WHERE id = 2;
            INSERT INTO raw_message_dispatch (
                id, msg_id, origin_tx_hash, origin_block_hash, origin_block_height,
                nonce, origin_domain, destination_domain, sender, recipient, origin_mailbox, msg_body
            ) SELECT n, decode(lpad(to_hex(n), 64, '0'), 'hex'), origin_tx_hash,
                     origin_block_hash, CASE WHEN n = 2006 THEN 3 ELSE 5 END,
                     n, origin_domain, destination_domain, sender, recipient, origin_mailbox, msg_body
              FROM raw_message_dispatch CROSS JOIN generate_series(6, 2006) AS ids(n)
              WHERE id = 2"#,
        )
        .await?;
        let (unconfirmed, next) = db
            .retrieve_unenriched_raw_dispatches(1, &mailbox, 5, 2006, 100)
            .await?;
        assert!(unconfirmed.is_empty());
        assert_eq!(next, Some(2005));
        let (confirmed, next) = db
            .retrieve_unenriched_raw_dispatches(1, &mailbox, 2005, 2006, 100)
            .await?;
        assert_eq!(
            confirmed.iter().map(|row| row.raw_id).collect::<Vec<_>>(),
            vec![2006]
        );
        assert_eq!(next, None);
        let direct = db
            .retrieve_unenriched_raw_dispatches_by_ids(1, &mailbox, &[3, 4, 5])
            .await?;
        assert_eq!(
            direct.iter().map(|row| row.raw_id).collect::<Vec<_>>(),
            vec![3]
        );
        Ok(())
    }

    #[tokio::test]
    async fn reconciliation_read_uses_a_scoped_server_statement_deadline() -> Result<()> {
        let postgres = Postgres::default().start().await?;
        let port = postgres.get_host_port_ipv4(5432).await?;
        let mut options = ConnectOptions::new(format!(
            "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
        ));
        options.max_connections(1);
        let db = ScraperDb::with_connection(Database::connect(options).await?);

        async fn statement_timeout(connection: &impl ConnectionTrait) -> Result<String> {
            let row = connection
                .query_one(Statement::from_string(
                    DbBackend::Postgres,
                    "SHOW statement_timeout".to_owned(),
                ))
                .await?
                .ok_or_else(|| eyre::eyre!("missing statement_timeout"))?;
            Ok(row.try_get("", "statement_timeout")?)
        }

        let tx = db.begin_reconciliation_read().await?;
        assert_eq!(statement_timeout(&tx).await?, "2s");
        tx.commit().await?;
        assert_eq!(statement_timeout(&db.0).await?, "0");

        db.0.execute_unprepared("SET statement_timeout = '100ms'")
            .await?;
        let tx = db.begin_reconciliation_read().await?;
        assert_eq!(statement_timeout(&tx).await?, "100ms");
        let error = tx
            .execute_unprepared("SELECT pg_sleep(5)")
            .await
            .expect_err("PostgreSQL should cancel the read");
        assert!(error.to_string().contains("statement timeout"), "{error}");
        tx.rollback().await?;
        assert_eq!(statement_timeout(&db.0).await?, "100ms");
        Ok(())
    }
}
