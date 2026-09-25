pub use block::*;
pub use block_cursor::BlockCursor;
use std::time::Duration;

use eyre::{ensure, Result};
pub use merkle_tree_insertion::*;
pub use message::*;
pub use payment::*;
pub use raw_message_dispatch::*;
pub use same_chain_ccr_swap::*;
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::{ConnectOptions, Database, DatabaseConnection, DbConn};
use tracing::instrument;
pub use txn::*;

#[allow(clippy::all)]
mod generated;

// These modules implement additional functionality for the ScraperDb
mod block;
mod block_cursor;
mod merkle_tree_insertion;
mod message;
mod payment;
mod raw_message_dispatch;
mod same_chain_ccr_swap;
mod txn;

/// Database interface to the message explorer database for the scraper. This is
/// focused on writing data to the database.
#[derive(Debug)]
pub struct ScraperDb(DbConn);

impl ScraperDb {
    // Hash lookups bind one parameter per hash; stay below PostgreSQL's 65,535 limit.
    const HASH_LOOKUP_CHUNK_SIZE: usize = 65_000;

    #[cfg(test)]
    #[instrument]
    pub async fn connect(url: &str) -> Result<Self> {
        Self::connect_with_options(url, 10, Duration::from_secs(15)).await
    }

    #[instrument]
    pub async fn connect_with_options(
        url: &str,
        max_connections: u32,
        acquire_timeout: Duration,
    ) -> Result<Self> {
        ensure!(max_connections > 0, "Database pool must allow a connection");
        ensure!(
            !acquire_timeout.is_zero(),
            "Database acquire timeout must be positive"
        );
        // One shared pool is the global backpressure boundary for indexing,
        // confirmation and enrichment across every configured chain.
        let mut options = ConnectOptions::new(url);
        options
            .max_connections(max_connections)
            .min_connections(1)
            .acquire_timeout(acquire_timeout);
        let db = Database::connect(options).await?;
        Ok(Self(db))
    }

    #[cfg(test)]
    pub fn with_connection(db: DbConn) -> Self {
        Self(db)
    }

    pub fn clone_connection(&self) -> DbConn {
        match &self.0 {
            DatabaseConnection::SqlxPostgresPoolConnection(conn) => {
                DatabaseConnection::SqlxPostgresPoolConnection(conn.clone())
            }
            DatabaseConnection::Disconnected => DatabaseConnection::Disconnected,
            DatabaseConnection::MockDatabaseConnection(conn) => {
                DatabaseConnection::MockDatabaseConnection(conn.clone())
            }
        }
    }

    pub async fn verify_frontier_indexes(&self) -> Result<()> {
        migration::indexes::verify_frontier_indexes(&self.0).await
    }
}

/// Grouped explicitly so the `OR` can never bind across filters combined with `AND`.
pub(super) fn confirmed_event(table: &str, domain: &str, height: &str) -> SimpleExpr {
    Expr::cust(format!(
        "({table}.{height} IS NULL OR {table}.{height}<=COALESCE((SELECT h.confirmed_height FROM scraper_head h WHERE h.domain={table}.{domain}),9223372036854775807))"
    ))
}

/// Not sure why Seaorm's DatabaseConnection does not #[derive(Clone)]
/// when "mock" feature is enabled.
/// So we have to implement our own clone instead of #[derive(Clone)]
impl Clone for ScraperDb {
    fn clone(&self) -> Self {
        let conn = self.clone_connection();
        Self(conn)
    }
}

#[cfg(test)]
mod write_batches;

#[cfg(test)]
mod lookup_batches;

#[cfg(test)]
mod sequence_reads;

#[cfg(test)]
mod dispatch_transactions;

#[cfg(test)]
mod confirmed_event_tests {
    use sea_orm::{ColumnTrait, DbBackend, EntityTrait, QueryFilter, QueryTrait};

    use super::{confirmed_event, generated::delivered_message};

    #[test]
    fn confirmed_event_stays_grouped_with_other_filters() {
        let sql = delivered_message::Entity::find()
            .filter(confirmed_event(
                "delivered_message",
                "domain",
                "block_number",
            ))
            .filter(delivered_message::Column::Domain.eq(1))
            .build(DbBackend::Postgres)
            .to_string();
        assert!(
            sql.contains("(delivered_message.block_number IS NULL OR "),
            "confirmation predicate must be grouped: {sql}"
        );
        assert!(
            !sql.contains("WHERE delivered_message.block_number IS NULL OR"),
            "confirmation predicate must not leak outside its group: {sql}"
        );
    }
}
