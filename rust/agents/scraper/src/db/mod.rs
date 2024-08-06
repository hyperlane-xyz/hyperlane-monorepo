pub use block::*;
pub use block_cursor::BlockCursor;
use eyre::Result;
pub use message::*;
pub use payment::*;
use sea_orm::{Database, DbConn};
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
#[derive(Clone, Debug)]
pub struct ScraperDb(DbConn);

impl ScraperDb {
    #[instrument]
    pub async fn connect(url: &str) -> Result<Self> {
        let db = Database::connect(url).await?;
        Ok(Self(db))
    }
}
