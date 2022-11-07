use std::ops::Deref;

use eyre::Result;
use sea_orm::{Database, DbConn};
use tracing::instrument;

use abacus_core::TxnInfo;
pub use block::*;
pub use block_cursor::BlockCursor;
pub use message::*;
pub use txn::*;

use crate::conversions::u256_as_scaled_f64;

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

fn as_f64(v: ethers::types::U256) -> f64 {
    u256_as_scaled_f64(v, 18)
}
