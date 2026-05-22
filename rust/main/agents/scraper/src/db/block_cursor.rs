use std::time::{Duration, Instant};

use eyre::Result;
use sea_orm::{prelude::*, ActiveValue, Insert, Order, QueryOrder, QuerySelect};
use tokio::sync::RwLock;
use tracing::{debug, info, instrument, warn};

use crate::db::ScraperDb;

use super::generated::cursor;

const MAX_WRITE_BACK_FREQUENCY: Duration = Duration::from_secs(10);

#[derive(Debug)]
struct BlockCursorInner {
    /// Block height
    height: u64,
    /// Last time we updated the database with the block height.
    last_saved_at: Instant,
}

/// A tool to wrap the logic of fetching and updating the cursor position in the
/// database. We may end up reading the same block range again later but this
/// prevents us from starting from the beginning after a restart.
#[derive(Debug)]
pub struct BlockCursor {
    db: DbConn,
    /// The hyperlane domain this block cursor is for.
    domain: u32,
    /// Discriminates different indexer types sharing the same domain (e.g. "" for
    /// messages, "ccr_swap" for same-chain CCR swaps) so each has an independent watermark.
    event_type: String,
    inner: RwLock<BlockCursorInner>,
}

impl BlockCursor {
    async fn new(db: DbConn, domain: u32, event_type: &str, default_height: u64) -> Result<Self> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            Height,
        }

        let height = (cursor::Entity::find())
            .filter(cursor::Column::Domain.eq(domain))
            .filter(cursor::Column::EventType.eq(event_type))
            .order_by(cursor::Column::Height, Order::Desc)
            .select_only()
            .column_as(cursor::Column::Height, QueryAs::Height)
            .into_values::<i64, QueryAs>()
            .one(&db)
            .await?
            .map(|h| h as u64)
            .unwrap_or(default_height);
        if height < default_height {
            warn!(
                height,
                default_height,
                "Cursor height loaded from the database is lower than the default height!"
            )
        } else {
            info!(height, "Restored current cursor position from database")
        }
        Ok(Self {
            db,
            domain,
            event_type: event_type.to_owned(),
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
                time_created: ActiveValue::NotSet,
                height: ActiveValue::Set(height as i64),
                event_type: ActiveValue::Set(self.event_type.clone()),
            };
            debug!(?model, "Inserting cursor");
            if let Err(e) = Insert::one(model).exec(&self.db).await {
                warn!(error = ?e, "Failed to update database with new cursor. When you just started this, ensure that the migrations included this domain.")
            } else {
                debug!(cursor = ?*inner, "Updated cursor")
            }
        }
    }

    /// Persist the current height to the database unconditionally, bypassing the
    /// time-based throttle.  Call this after committing a write-once batch (e.g.
    /// CCR swaps) so a restart never re-plays already-advanced ranges.
    ///
    /// Returns `Err` on DB failure so the caller can decide whether to back off
    /// or keep advancing. `last_saved_at` is only updated on success so a failed
    /// flush does not suppress the throttle in `update()`.
    #[instrument(skip(self), fields(cursor = ?self.inner))]
    pub async fn flush(&self) -> Result<()> {
        let mut inner = self.inner.write().await;
        let height = inner.height;
        let model = cursor::ActiveModel {
            id: ActiveValue::NotSet,
            domain: ActiveValue::Set(self.domain as i32),
            time_created: ActiveValue::NotSet,
            height: ActiveValue::Set(height as i64),
            event_type: ActiveValue::Set(self.event_type.clone()),
        };
        debug!(?model, "Flushing cursor to database");
        Insert::one(model).exec(&self.db).await?;
        inner.last_saved_at = Instant::now();
        let inner = inner.downgrade();
        debug!(cursor = ?*inner, "Flushed cursor");
        Ok(())
    }
}

impl ScraperDb {
    pub async fn block_cursor(
        &self,
        domain: u32,
        event_type: &str,
        default_height: u64,
    ) -> Result<BlockCursor> {
        BlockCursor::new(self.clone_connection(), domain, event_type, default_height).await
    }
}
