use std::ops::Deref;

use eyre::Result;
use sea_orm::{Database, DbConn};
use tracing::instrument;

use abacus_core::TxnInfo;
pub use block::*;
pub use block_cursor::BlockCursor;
pub use message::*;
pub use txn::*;

#[allow(clippy::all)]
mod generated;

// These modules implement additional functionality for the ScraperDb
mod block;
mod block_cursor;
mod message;
mod txn;

impl Deref for StorableTxn {
    type Target = TxnInfo;

    fn deref(&self) -> &Self::Target {
        &self.info
    }
}

#[derive(Clone, Debug)]
pub struct ScraperDb(DbConn);

impl ScraperDb {
    #[instrument]
    pub async fn connect(url: &str) -> Result<Self> {
        let db = Database::connect(url).await?;
        Ok(Self(db))
    }
}
