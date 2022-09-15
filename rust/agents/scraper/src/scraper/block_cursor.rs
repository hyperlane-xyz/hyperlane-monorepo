use std::time::{Duration, Instant};

use eyre::Result;
use sea_orm::ActiveValue;
use sea_orm::prelude::*;
use tokio::sync::RwLock;
use tracing::log::warn;

use crate::date_time;
use crate::db::cursor;

const MAX_WRITE_BACK_FREQUENCY: Duration = Duration::from_secs(10);

struct BlockCursorInner {
    /// Block height
    height: u64,
    /// Last time we updated the database with the block height.
    last_saved_at: Instant,
}

struct BlockCursor {
    db: DbConn,
    /// The abacus domain this block cursor is for.
    domain: u32,
    inner: RwLock<BlockCursorInner>,
}

impl BlockCursor {
    async fn new(db: DbConn, domain: u32, default_height: u64) -> Result<Self> {
        let height = cursor::Entity::find_by_id(domain as i32)
            .one(&db)
            .await?
            .map(|model| model.height as u64)
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

    pub async fn update(&self, height: u64) {
        let mut inner = self.inner.write().await;

        let old_height = inner.height;
        inner.height = inner.height.max(height);

        let now = Instant::now();
        if height > old_height && now.duration_since(inner.last_saved_at) > MAX_WRITE_BACK_FREQUENCY
        {
            inner.last_saved_at = now;
            // prevent any more writes to the inner struct until the write is complete.
            let _inner = inner.downgrade();
            let model = cursor::ActiveModel {
                domain: ActiveValue::Unchanged(self.domain as i32),
                time_updated: ActiveValue::Set(date_time::now()),
                height: ActiveValue::Set(height as i64),
            };
            if let Err(e) = model.save(&self.db).await {
                warn!("Failed to update database with new cursor: {e}")
            }
        }
    }
}
