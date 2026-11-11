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
                   FROM raw_message_dispatch e
                   LEFT JOIN "transaction" t ON t.hash=e.origin_tx_hash
                   WHERE e.origin_domain=$1 AND e.id>$2 AND t.id IS NULL
                   AND e.origin_tx_hash<>decode(repeat('00',octet_length(e.origin_tx_hash)),'hex')
                   AND e.origin_block_height>(SELECT confirmed_height FROM scraper_head WHERE domain=$1)
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
        after: i64,
        through: i64,
    ) -> Result<()> {
        let table = stream.table();
        let query = if let Some(column) = stream.transaction_column() {
            format!(
                r#"WITH linked AS (UPDATE {table} e SET {column}=t.id
                   FROM "transaction" t JOIN block b ON b.id=t.block_id
                   WHERE e.domain=$1 AND e.id>$2 AND e.id<=$3
                   AND e.{column} IS NULL AND t.hash=e.transaction_hash
                   AND b.domain=e.domain AND b.hash=e.block_hash
                   RETURNING e.msg_id)
                   SELECT pg_notify('scraper_explorer_event',
                     json_build_object('messageId',encode(msg_id,'hex'))::text) FROM linked"#
            )
        } else {
            // The proxy already handles this notification for custom and default
            // subscribers. Publish only receipts that matched a retained block.
            r#"SELECT pg_notify('scraper_explorer_event',
                 json_build_object('messageId',encode(e.msg_id,'hex'))::text)
               FROM raw_message_dispatch e
               JOIN block b ON b.domain=e.origin_domain AND b.hash=e.origin_block_hash
               JOIN "transaction" t ON t.block_id=b.id AND t.hash=e.origin_tx_hash
               WHERE e.origin_domain=$1 AND e.id>$2 AND e.id<=$3"#
                .to_owned()
        };
        self.0
            .execute(sql(
                query,
                vec![
                    i32::from_ne_bytes(domain.to_ne_bytes()).into(),
                    after.into(),
                    through.into(),
                ],
            ))
            .await?;
        Ok(())
    }

    /// Read the first pending row through the stream's partial (domain,id) index.
    pub(crate) async fn pending_receipt_age(
        &self,
        domain: u32,
        stream: ReceiptStream,
    ) -> Result<f64> {
        let table = stream.table();
        let query = if let Some(column) = stream.transaction_column() {
            format!(
                "SELECT coalesce((SELECT greatest(0, extract(epoch FROM
                 ((clock_timestamp() AT TIME ZONE 'UTC') - time_created))::double precision)
                 FROM {table} WHERE domain=$1 AND {column} IS NULL
                 AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL
                 ORDER BY id LIMIT 1),0::double precision) AS age"
            )
        } else {
            r#"SELECT coalesce((SELECT greatest(0, extract(epoch FROM
                 ((clock_timestamp() AT TIME ZONE 'UTC') - e.time_created))::double precision)
               FROM raw_message_dispatch e LEFT JOIN "transaction" t ON t.hash=e.origin_tx_hash
               WHERE e.origin_domain=$1 AND t.id IS NULL
               AND e.origin_tx_hash<>decode(repeat('00',octet_length(e.origin_tx_hash)),'hex')
               AND e.origin_block_height>(SELECT confirmed_height FROM scraper_head WHERE domain=$1)
               ORDER BY e.id LIMIT 1),0::double precision) AS age"#
                .to_owned()
        };
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
