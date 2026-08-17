use eyre::Result;
use migration::{Alias, Expr, Func, OnConflict};
use sea_orm::{ActiveValue::*, ColumnTrait, EntityTrait, Insert, QueryFilter, QuerySelect};

use crate::{date_time, db::ScraperDb};

use super::generated::indexing_checkpoint;

impl ScraperDb {
    pub async fn retrieve_indexing_checkpoint(
        &self,
        domain: u32,
        event_type: &str,
    ) -> Result<Option<u32>> {
        Ok(indexing_checkpoint::Entity::find()
            .filter(indexing_checkpoint::Column::Domain.eq(domain))
            .filter(indexing_checkpoint::Column::EventType.eq(event_type))
            .select_only()
            .column(indexing_checkpoint::Column::Height)
            .into_tuple::<i64>()
            .one(&self.0)
            .await?
            .map(TryInto::try_into)
            .transpose()?)
    }

    pub async fn store_indexing_checkpoint(
        &self,
        domain: u32,
        event_type: &str,
        height: u32,
    ) -> Result<()> {
        let now = date_time::now();
        let model = indexing_checkpoint::ActiveModel {
            id: NotSet,
            domain: Set(domain as i32),
            event_type: Set(event_type.to_owned()),
            height: Set(height as i64),
            time_created: Set(now),
            time_updated: Set(now),
        };

        Insert::one(model)
            .on_conflict(
                OnConflict::columns([
                    indexing_checkpoint::Column::Domain,
                    indexing_checkpoint::Column::EventType,
                ])
                .update_column(indexing_checkpoint::Column::TimeUpdated)
                .value(
                    indexing_checkpoint::Column::Height,
                    Func::greatest([
                        Expr::col((
                            Alias::new("indexing_checkpoint"),
                            indexing_checkpoint::Column::Height,
                        ))
                        .into(),
                        Expr::col((Alias::new("excluded"), indexing_checkpoint::Column::Height))
                            .into(),
                    ]),
                )
                .to_owned(),
            )
            .exec(&self.0)
            .await?;

        Ok(())
    }
}
