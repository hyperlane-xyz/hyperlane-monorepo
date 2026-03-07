use std::time::{Duration, Instant};

use eyre::Result;
use sea_orm::{prelude::*, ActiveValue, ConnectionTrait, Insert, Order, QueryOrder, QuerySelect};
use tokio::sync::RwLock;
use tracing::{debug, info, instrument, warn};

use crate::db::ScraperDb;

use super::generated::cursor;

const MAX_WRITE_BACK_FREQUENCY: Duration = Duration::from_secs(10);

/// Distinguishes independent cursor streams for the same domain.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CursorKind {
    /// Cursor used by finalized/enriched scraping.
    Finalized,
    /// Cursor used by near-tip/raw scraping.
    Tip,
}

impl CursorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Finalized => "finalized",
            Self::Tip => "tip",
        }
    }
}

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
    /// Which cursor stream this record belongs to.
    cursor_kind: CursorKind,
    inner: RwLock<BlockCursorInner>,
}

impl BlockCursor {
    async fn new(
        db: DbConn,
        domain: u32,
        default_height: u64,
        cursor_kind: CursorKind,
    ) -> Result<Self> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            Height,
        }

        let height_with_cursor_type = (cursor::Entity::find())
            .filter(cursor::Column::Domain.eq(domain))
            .filter(cursor::Column::CursorType.eq(cursor_kind.as_str()))
            .order_by(cursor::Column::Height, Order::Desc)
            .select_only()
            .column_as(cursor::Column::Height, QueryAs::Height)
            .into_values::<i64, QueryAs>()
            .one(&db)
            .await;

        let height = match height_with_cursor_type {
            Ok(height) => height.map(|h| h as u64).unwrap_or(default_height),
            Err(err) if should_fallback_to_legacy_cursor_query(&err) => {
                warn!(
                    domain,
                    cursor_kind = ?cursor_kind,
                    error = ?err,
                    "cursor_type column missing, falling back to legacy cursor query"
                );
                match cursor_kind {
                    CursorKind::Finalized => (cursor::Entity::find())
                        .filter(cursor::Column::Domain.eq(domain))
                        .order_by(cursor::Column::Height, Order::Desc)
                        .select_only()
                        .column_as(cursor::Column::Height, QueryAs::Height)
                        .into_values::<i64, QueryAs>()
                        .one(&db)
                        .await?
                        .map(|h| h as u64)
                        .unwrap_or(default_height),
                    CursorKind::Tip => {
                        warn!(
                            domain,
                            "Tip cursor persistence requires cursor_type migration; using default tip height"
                        );
                        default_height
                    }
                }
            }
            Err(err) => return Err(err.into()),
        };
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
            cursor_kind,
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
                cursor_type: ActiveValue::Set(self.cursor_kind.as_str().to_owned()),
                time_created: ActiveValue::NotSet,
                height: ActiveValue::Set(height as i64),
            };
            debug!(?model, "Inserting cursor");
            match Insert::one(model).exec(&self.db).await {
                Ok(_) => debug!(cursor = ?*inner, "Updated cursor"),
                Err(e) if should_fallback_to_legacy_cursor_query(&e) => match self.cursor_kind {
                    CursorKind::Finalized => {
                        warn!(
                            error = ?e,
                            domain = self.domain,
                            "cursor_type column missing, falling back to legacy finalized cursor insert"
                        );
                        if let Err(legacy_err) =
                            insert_legacy_cursor_row(&self.db, self.domain, height).await
                        {
                            warn!(
                                error = ?legacy_err,
                                domain = self.domain,
                                "Failed to update database with legacy finalized cursor"
                            );
                        } else {
                            debug!(cursor = ?*inner, "Updated cursor via legacy insert")
                        }
                    }
                    CursorKind::Tip => warn!(
                        error = ?e,
                        domain = self.domain,
                        "Tip cursor persistence requires cursor_type migration; skipping tip cursor write"
                    ),
                },
                Err(e) => warn!(
                    error = ?e,
                    "Failed to update database with new cursor. When you just started this, ensure that the migrations included this domain."
                ),
            }
        }
    }
}

impl ScraperDb {
    pub async fn block_cursor(
        &self,
        domain: u32,
        default_height: u64,
        cursor_kind: CursorKind,
    ) -> Result<BlockCursor> {
        BlockCursor::new(self.clone_connection(), domain, default_height, cursor_kind).await
    }
}

fn should_fallback_to_legacy_cursor_query(err: &DbErr) -> bool {
    let msg = err.to_string().to_lowercase();
    msg.contains("no such column: cursor_type")
        || msg.contains("column cursor_type does not exist")
        || msg.contains("column \"cursor_type\" does not exist")
        || msg.contains("unknown column 'cursor_type'")
}

async fn insert_legacy_cursor_row(
    db: &DbConn,
    domain: u32,
    height: u64,
) -> std::result::Result<(), DbErr> {
    db.execute_unprepared(&format!(
        r#"INSERT INTO "cursor" ("domain", "height") VALUES ({domain}, {height})"#
    ))
    .await
    .map(|_| ())
}
