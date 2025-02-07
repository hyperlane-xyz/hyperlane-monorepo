pub use block::*;
pub use block_cursor::BlockCursor;
use eyre::Result;
pub use message::*;
pub use payment::*;
use sea_orm::{Database, DatabaseConnection, DbConn};
use tracing::instrument;
pub use txn::*;

#[allow(clippy::all)]
mod generated;

// These modules implement additional functionality for the ScraperDb
mod block;
mod block_cursor;
mod message;
mod payment;
mod txn;

/// Database interface to the message explorer database for the scraper. This is
/// focused on writing data to the database.
#[derive(Debug)]
pub struct ScraperDb(DbConn);

impl ScraperDb {
    #[instrument]
    pub async fn connect(url: &str) -> Result<Self> {
        let db = Database::connect(url).await?;
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
