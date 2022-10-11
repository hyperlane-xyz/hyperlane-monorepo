use std::time::{Duration, Instant};

use eyre::Result;
use sea_orm::prelude::*;
use sea_orm::{ActiveValue, Insert, Order, QueryOrder};
use tokio::sync::RwLock;
use tracing::{debug, instrument, trace, warn};

use crate::date_time;
use crate::db::cursor;

const MAX_WRITE_BACK_FREQUENCY: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct BlockCursorInner {
    /// Block height
    height: u64,
    /// Last time we updated the database with the block height.
    last_saved_at: Instant,
}

#[derive(Debug)]
pub struct BlockCursor {
    db: DbConn,
    /// The abacus domain this block cursor is for.
    domain: u32,
    inner: RwLock<BlockCursorInner>,
}

impl BlockCursor {
    pub async fn new(db: DbConn, domain: u32, default_height: u64) -> Result<Self> {
        let height = (cursor::Entity::find())
            .filter(cursor::Column::Domain.eq(domain))
            .order_by(cursor::Column::Id, Order::Desc)
            .one(&db)
            .await?
            .map(|block| block.height as u64)
            .unwrap_or(default_height);
        if height < default_height {
            warn!("Cursor height loaded from the database is lower than the default height!")
        }
        Ok(Self {
            db,
            domain,
            inner: RwLock::new(BlockCursorInner {
                height,
                last_saved_at: Instant::now(),
            }),
        })
    }

    pub async fn height(&self) -> u64 {
        self.inner.read().await.height
    }

    #[instrument(skip(self), fields(cursor = ?self.inner))]
    pub async fn update(&self, height: u64) {
        let mut inner = self.inner.write().await;

        let old_height = inner.height;
        inner.height = inner.height.max(height);

        let now = Instant::now();
        let time_since_last_save = now.duration_since(inner.last_saved_at);
        if height > old_height && time_since_last_save > MAX_WRITE_BACK_FREQUENCY {
            inner.last_saved_at = now;
            // prevent any more writes to the inner struct until the write is complete.
            let inner = inner.downgrade();
            let model = cursor::ActiveModel {
                id: ActiveValue::NotSet,
                domain: ActiveValue::Set(self.domain as i32),
                time_updated: ActiveValue::Set(date_time::now()),
                height: ActiveValue::Set(height as i64),
            };
            trace!(?model, "Inserting cursor");
            if let Err(e) = Insert::one(model).exec(&self.db).await {
                warn!(error = ?e, "Failed to update database with new cursor")
            } else {
                debug!(cursor = ?*inner, "Updated cursor")
            }
        }
    }
}
