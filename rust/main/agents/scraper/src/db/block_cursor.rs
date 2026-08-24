use std::time::{Duration, Instant};

use eyre::Result;
use migration::{Alias, Expr, Func, OnConflict};
use sea_orm::{prelude::*, ActiveValue::*, Insert, Order, QueryOrder, QuerySelect};
use tokio::sync::RwLock;
use tracing::{debug, info, instrument, warn};

use hyperlane_core::BackwardCursorProgress;

use crate::{date_time, db::ScraperDb};

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
        let should_flush = height > old_height && time_since_last_save > MAX_WRITE_BACK_FREQUENCY;
        drop(inner);

        if should_flush {
            if let Err(e) = self.flush().await {
                warn!(error = ?e, "Failed to update database with new cursor. When you just started this, ensure that the migrations included this domain.")
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
        debug!(
            height,
            domain = self.domain,
            event_type = self.event_type,
            "Flushing cursor to database"
        );
        let model = cursor::ActiveModel {
            id: NotSet,
            domain: Set(self.domain as i32),
            time_created: Set(date_time::now()),
            height: Set(height as i64),
            event_type: Set(self.event_type.clone()),
        };

        Insert::one(model)
            .on_conflict(
                OnConflict::columns([cursor::Column::Domain, cursor::Column::EventType])
                    .update_column(cursor::Column::TimeCreated)
                    .value(
                        cursor::Column::Height,
                        Func::greatest([
                            Expr::col((Alias::new("cursor"), cursor::Column::Height)).into(),
                            Expr::col((Alias::new("excluded"), cursor::Column::Height)).into(),
                        ]),
                    )
                    .to_owned(),
            )
            .exec(&self.db)
            .await?;
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

    pub async fn retrieve_backward_cursor(
        &self,
        domain: u32,
        event_type: &str,
    ) -> Result<Option<BackwardCursorProgress>> {
        let event_type = format!("backward_{event_type}");
        // Keep the pair atomic by packing both u32s into the cursor table's
        // signed i64. Flipping the sign bit preserves unsigned ordering under
        // PostgreSQL's signed LEAST comparison.
        let packed = cursor::Entity::find()
            .filter(cursor::Column::Domain.eq(domain))
            .filter(cursor::Column::EventType.eq(event_type))
            .one(&self.0)
            .await?
            .map(|model| (model.height as u64) ^ (1 << 63));
        Ok(packed.map(|packed| BackwardCursorProgress {
            sequence: (packed >> 32) as u32,
            block: packed as u32,
        }))
    }

    pub async fn store_backward_cursor(
        &self,
        domain: u32,
        event_type: &str,
        progress: BackwardCursorProgress,
    ) -> Result<()> {
        let packed = ((progress.sequence as u64) << 32) | progress.block as u64;
        let model = cursor::ActiveModel {
            id: NotSet,
            domain: Set(domain as i32),
            time_created: Set(date_time::now()),
            height: Set((packed ^ (1 << 63)) as i64),
            event_type: Set(format!("backward_{event_type}")),
        };
        Insert::one(model)
            .on_conflict(
                OnConflict::columns([cursor::Column::Domain, cursor::Column::EventType])
                    .update_column(cursor::Column::TimeCreated)
                    .value(
                        cursor::Column::Height,
                        Func::least([
                            Expr::col((Alias::new("cursor"), cursor::Column::Height)).into(),
                            Expr::col((Alias::new("excluded"), cursor::Column::Height)).into(),
                        ]),
                    )
                    .to_owned(),
            )
            .exec(&self.0)
            .await?;
        Ok(())
    }

    pub async fn reset_backward_cursor(
        &self,
        domain: u32,
        event_type: &str,
        progress: BackwardCursorProgress,
    ) -> Result<()> {
        let packed = ((progress.sequence as u64) << 32) | progress.block as u64;
        let model = cursor::ActiveModel {
            id: NotSet,
            domain: Set(domain as i32),
            time_created: Set(date_time::now()),
            height: Set((packed ^ (1 << 63)) as i64),
            event_type: Set(format!("backward_{event_type}")),
        };
        Insert::one(model)
            .on_conflict(
                OnConflict::columns([cursor::Column::Domain, cursor::Column::EventType])
                    .update_columns([cursor::Column::Height, cursor::Column::TimeCreated])
                    .to_owned(),
            )
            .exec(&self.0)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::BackwardCursorProgress;
    use migration::MigratorTrait;
    use sea_orm::Database;
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    use super::ScraperDb;

    #[tokio::test]
    async fn backward_cursors_are_durable_and_event_specific() -> eyre::Result<()> {
        let postgres = Postgres::default().start().await?;
        let port = postgres.get_host_port_ipv4(5432).await?;
        let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
        let connection = Database::connect(&url).await?;
        migration::Migrator::up(&connection, None).await?;

        let db = ScraperDb::connect(&url).await?;
        let message = BackwardCursorProgress {
            sequence: u32::MAX,
            block: 34,
        };
        let payment = BackwardCursorProgress {
            sequence: 56,
            block: u32::MAX,
        };
        db.store_backward_cursor(13375, "message", message).await?;
        db.store_backward_cursor(13375, "gas_payment", payment)
            .await?;
        let updated_message = BackwardCursorProgress {
            sequence: 12,
            block: 34,
        };
        db.store_backward_cursor(13375, "message", updated_message)
            .await?;
        db.store_backward_cursor(13375, "message", message).await?;
        let rewind = BackwardCursorProgress {
            sequence: 12,
            block: 500,
        };
        db.reset_backward_cursor(13375, "message", rewind).await?;

        let reopened = ScraperDb::connect(&url).await?;
        assert_eq!(
            reopened.retrieve_backward_cursor(13375, "message").await?,
            Some(rewind)
        );
        assert_eq!(
            reopened
                .retrieve_backward_cursor(13375, "gas_payment")
                .await?,
            Some(payment)
        );
        assert_eq!(
            reopened.retrieve_backward_cursor(13375, "delivery").await?,
            None
        );
        Ok(())
    }
}
