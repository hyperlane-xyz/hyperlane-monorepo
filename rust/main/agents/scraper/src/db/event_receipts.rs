//! Pending receipt pages and transaction links for confirmed delivery and gas events.
use eyre::Result;
use hyperlane_core::LogMeta;
use sea_orm::{ConnectionTrait, DbBackend, Statement, Value};

use super::ScraperDb;

pub(crate) const RECEIPT_PAGE_SIZE: usize = 100;

#[derive(Clone, Copy)]
pub(crate) enum ReceiptStream {
    Delivery,
    GasPayment,
}

impl ReceiptStream {
    pub(crate) fn table(self) -> &'static str {
        match self {
            Self::Delivery => "delivered_message",
            Self::GasPayment => "gas_payment",
        }
    }

    fn transaction_column(self) -> &'static str {
        match self {
            Self::Delivery => "destination_tx_id",
            Self::GasPayment => "tx_id",
        }
    }

    pub(crate) fn metric_label(self) -> &'static str {
        match self {
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
        let column = stream.transaction_column();
        let rows = self
            .0
            .query_all(sql(
                format!(
                    "SELECT id,block_number,block_hash,transaction_hash FROM confirmed_{table}
                 WHERE domain=$1 AND {column} IS NULL AND id>$2
                 AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL
                 ORDER BY id LIMIT {RECEIPT_PAGE_SIZE}"
                ),
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
        let column = stream.transaction_column();
        self.0
            .execute(sql(
                format!(
                    r#"UPDATE {table} e SET {column}=t.id
                   FROM "transaction" t JOIN block b ON b.id=t.block_id
                   WHERE e.domain=$1 AND e.id>$2 AND e.id<=$3
                   AND (e.block_number IS NULL OR e.block_number<=COALESCE(
                       (SELECT h.confirmed_height FROM scraper_head h WHERE h.domain=e.domain),
                       9223372036854775807))
                   AND e.{column} IS NULL AND t.hash=e.transaction_hash
                   AND b.domain=e.domain AND b.hash=e.block_hash"#
                ),
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
        let column = stream.transaction_column();
        let row = self
            .0
            .query_one(sql(
                format!(
                    "SELECT coalesce((SELECT greatest(0, extract(epoch FROM
                     ((clock_timestamp() AT TIME ZONE 'UTC') - time_created))::double precision)
                     FROM confirmed_{table} WHERE domain=$1 AND {column} IS NULL
                     AND block_hash IS NOT NULL AND transaction_hash IS NOT NULL
                     ORDER BY id LIMIT 1),0::double precision) AS age"
                ),
                vec![i32::from_ne_bytes(domain.to_ne_bytes()).into()],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing receipt backlog age"))?;
        Ok(row.try_get("", "age")?)
    }
}
