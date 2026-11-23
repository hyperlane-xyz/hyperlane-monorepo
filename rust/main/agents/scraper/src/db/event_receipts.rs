//! Transaction enrichment and links for indexed dispatch, delivery, and gas-payment events.
use eyre::Result;
use hyperlane_core::LogMeta;
use sea_orm::{ConnectionTrait, DbBackend, Statement, Value};

use super::ScraperDb;

pub(crate) const RECEIPT_PAGE_SIZE: usize = 100;

#[derive(Clone, Copy)]
pub(crate) enum ReceiptStream {
    Dispatch,
    Delivery,
    GasPayment,
}

impl ReceiptStream {
    pub(crate) const ALL: [Self; 3] = [Self::Dispatch, Self::Delivery, Self::GasPayment];

    pub(crate) fn table(self) -> &'static str {
        match self {
            Self::Dispatch => "raw_message_dispatch",
            Self::Delivery => "delivered_message",
            Self::GasPayment => "gas_payment",
        }
    }

    fn transaction_column(self) -> Option<&'static str> {
        match self {
            Self::Dispatch => None,
            Self::Delivery => Some("destination_tx_id"),
            Self::GasPayment => Some("tx_id"),
        }
    }

    pub(crate) fn metric_label(self) -> &'static str {
        match self {
            Self::Dispatch => "dispatch",
            Self::Delivery => "delivery",
            Self::GasPayment => "gas_payment",
        }
    }
}

// Fence the height range before paging/sorting so an empty suffix cannot walk
// the permanent dispatch primary key from the beginning of history.
pub(crate) const DISPATCH_PENDING: &str = r#"
    FROM scraper_head h CROSS JOIN LATERAL (
      SELECT id,origin_block_height,origin_block_hash,origin_tx_hash,time_created
      FROM raw_message_dispatch
      WHERE origin_domain=h.domain AND origin_block_height>h.confirmed_height
        AND origin_block_height<=h.indexed_height
      OFFSET 0
    ) e LEFT JOIN "transaction" t ON t.hash=e.origin_tx_hash
    WHERE h.domain=$1 AND t.id IS NULL
      AND e.origin_tx_hash<>decode(repeat('00',32),'hex')"#;

fn sql(query: impl Into<String>, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}

impl ScraperDb {
    /// Keyset batches avoid one permanently unavailable receipt starving later rows.
    pub(crate) async fn pending_receipts(
        &self,
        domain: u32,
        stream: ReceiptStream,
        after: i64,
    ) -> Result<Vec<(i64, LogMeta)>> {
        let table = stream.table();
        let query = if let Some(column) = stream.transaction_column() {
            format!(
                "SELECT id,block_number,block_hash,transaction_hash FROM {table}
                 WHERE domain=$1 AND {column} IS NULL AND id>$2
                 AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL
                 ORDER BY id LIMIT {RECEIPT_PAGE_SIZE}"
            )
        } else {
            // Only scan the provisional suffix. Confirmed dispatch reconciliation
            // remains responsible for canonical messages and historical retries.
            format!(
                r#"SELECT e.id,e.origin_block_height AS block_number,
                   e.origin_block_hash AS block_hash,e.origin_tx_hash AS transaction_hash
                   {DISPATCH_PENDING} AND e.id>$2
                   ORDER BY e.id LIMIT {RECEIPT_PAGE_SIZE}"#
            )
        };
        let rows = self
            .0
            .query_all(sql(
                query,
                vec![
                    i32::from_ne_bytes(domain.to_ne_bytes()).into(),
                    after.into(),
                ],
            ))
            .await?;
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

    pub(crate) async fn link_receipts(
        &self,
        domain: u32,
        stream: ReceiptStream,
        ids: &[i64],
    ) -> Result<()> {
        let query = if let Some(column) = stream.transaction_column() {
            let table = stream.table();
            format!(
                r#"WITH linked AS (UPDATE {table} e SET {column}=t.id
                   FROM "transaction" t JOIN block b ON b.id=t.block_id
                   WHERE e.domain=$1 AND e.id=ANY($2)
                   AND e.{column} IS NULL AND t.hash=e.transaction_hash
                   AND b.domain=e.domain AND b.hash=e.block_hash
                   RETURNING e.msg_id,e.block_number,e.block_hash,e.transaction_hash)
                   SELECT pg_notify('scraper_explorer_event',
                     json_build_object('messageId',encode(msg_id,'hex'))::text)
                   FROM (
                     SELECT msg_id FROM linked
                     UNION
                     SELECT d.msg_id FROM linked l CROSS JOIN LATERAL (
                       SELECT msg_id FROM raw_message_dispatch
                       WHERE origin_domain=$1 AND origin_block_height=l.block_number
                         AND origin_block_hash=l.block_hash AND origin_tx_hash=l.transaction_hash
                       OFFSET 0
                     ) d
                   ) refreshed"#
            )
        } else {
            // Selected IDs stay eligible even if confirmation advanced during RPC fetching.
            r#"SELECT pg_notify('scraper_explorer_event',
                 json_build_object('messageId',encode(e.msg_id,'hex'))::text)
               FROM raw_message_dispatch e
               JOIN block b ON b.domain=e.origin_domain AND b.hash=e.origin_block_hash
               JOIN "transaction" t ON t.block_id=b.id AND t.hash=e.origin_tx_hash
               WHERE e.origin_domain=$1 AND e.id=ANY($2)"#
                .to_owned()
        };
        self.0
            .execute(sql(
                query,
                vec![
                    i32::from_ne_bytes(domain.to_ne_bytes()).into(),
                    ids.to_vec().into(),
                ],
            ))
            .await?;
        Ok(())
    }

    /// Sample the existing delivery/gas backlog metrics.
    pub(crate) async fn pending_receipt_age(
        &self,
        domain: u32,
        stream: ReceiptStream,
    ) -> Result<f64> {
        let table = stream.table();
        let column = stream
            .transaction_column()
            .ok_or_else(|| eyre::eyre!("Dispatch receipt age is not tracked"))?;
        let query = format!(
            "SELECT coalesce((SELECT greatest(0, extract(epoch FROM
             ((clock_timestamp() AT TIME ZONE 'UTC') - time_created))::double precision)
             FROM {table} WHERE domain=$1 AND {column} IS NULL
             AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL
             ORDER BY id LIMIT 1),0::double precision) AS age"
        );
        let row = self
            .0
            .query_one(sql(
                query,
                vec![i32::from_ne_bytes(domain.to_ne_bytes()).into()],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing receipt backlog age"))?;
        Ok(row.try_get("", "age")?)
    }
}
