use super::source::{Event, EventData, Header};
use ethers::types::H256;
use eyre::{ensure, Result};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait, Value};
use std::time::Duration;

pub(super) struct State {
    pub revision: i64,
    pub indexed: Option<(u64, H256)>,
}
pub(super) struct Store {
    pub db: DatabaseConnection,
    pub domain: u32,
}
fn sql(query: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}
fn number(value: u64) -> Result<Value> {
    Ok(i64::try_from(value)?.into())
}
impl Store {
    fn domain(&self) -> Value {
        i32::from_ne_bytes(self.domain.to_ne_bytes()).into()
    }
    pub async fn reset(&self) -> Result<()> {
        let tx = self.db.begin().await?;
        tx.execute(sql("INSERT INTO scraper_tip_head(domain) VALUES($1) ON CONFLICT(domain) DO UPDATE SET revision=scraper_tip_head.revision+1,epoch=scraper_tip_head.epoch+1,indexed_height=NULL,indexed_hash=NULL,from_height=NULL,healthy=false", vec![self.domain()])).await?;
        tx.execute(sql(
            "DELETE FROM scraper_tip_event WHERE domain=$1",
            vec![self.domain()],
        ))
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn state(&self) -> Result<State> {
        let row = self
            .db
            .query_one(sql(
                "SELECT revision,indexed_height,indexed_hash FROM scraper_tip_head WHERE domain=$1",
                vec![self.domain()],
            ))
            .await?
            .ok_or_else(|| eyre::eyre!("Missing tip state"))?;
        let height: Option<i64> = row.try_get("", "indexed_height")?;
        let hash: Option<Vec<u8>> = row.try_get("", "indexed_hash")?;
        let indexed = match (height, hash) {
            (Some(height), Some(hash)) => {
                ensure!(hash.len() == 32, "Invalid tip hash");
                Some((u64::try_from(height)?, H256::from_slice(&hash)))
            }
            (None, None) => None,
            _ => eyre::bail!("Incomplete tip checkpoint"),
        };
        Ok(State {
            revision: row.try_get("", "revision")?,
            indexed,
        })
    }
    pub async fn pause_revision(&self, revision: i64) -> Result<i64> {
        let row = self.db.query_one(sql(
            "UPDATE scraper_tip_head SET healthy=false,revision=revision+1 WHERE domain=$1 AND revision=$2 RETURNING revision",
            vec![self.domain(), revision.into()],
        )).await?.ok_or_else(|| eyre::eyre!("Tip observation superseded before reset"))?;
        Ok(row.try_get("", "revision")?)
    }
    pub async fn pause(&self) -> Result<()> {
        self.db
            .execute(sql(
                "UPDATE scraper_tip_head SET healthy=false,revision=revision+1 WHERE domain=$1",
                vec![self.domain()],
            ))
            .await?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn commit(
        &self,
        expected: &State,
        boundary: &Header,
        first: u64,
        events: &[Event],
        reset: bool,
        healthy: bool,
        lease: Duration,
    ) -> Result<()> {
        let tx = self.db.begin().await?;
        let result = tx.execute(sql(
            "UPDATE scraper_tip_head SET revision=revision+1,epoch=epoch+$3::bigint,indexed_height=$4,indexed_hash=$5,from_height=$6,healthy=$7,valid_until=clock_timestamp()+make_interval(secs=>$8::double precision) WHERE domain=$1 AND revision=$2",
            vec![self.domain(), expected.revision.into(), i64::from(reset).into(), number(boundary.height)?, boundary.hash.as_bytes().to_vec().into(), number(first)?, healthy.into(), lease.as_secs_f64().into()],
        )).await?;
        ensure!(
            result.rows_affected() == 1,
            "Tip observation superseded by another writer"
        );
        tx.execute(sql(
            "DELETE FROM scraper_tip_event WHERE domain=$1 AND ($2 OR block_number<$3)",
            vec![self.domain(), reset.into(), number(first)?],
        ))
        .await?;
        // One insert statement per range, independent of event count.
        #[derive(serde::Serialize)]
        struct StoredEvent<'a> {
            #[serde(flatten)]
            event: &'a Event,
            message_id: H256,
        }
        let payload = events
            .iter()
            .map(|event| StoredEvent {
                event,
                message_id: match &event.data {
                    EventData::Dispatch(message) => H256::from_slice(message.id().as_bytes()),
                    EventData::Delivery(id) => *id,
                    EventData::Insertion { message_id, .. } | EventData::Gas { message_id, .. } => {
                        *message_id
                    }
                },
            })
            .collect::<Vec<_>>();
        let payload = serde_json::to_string(&payload)?;
        tx.execute(sql(r#"
            INSERT INTO scraper_tip_event(domain,block_number,block_hash,transaction_hash,log_index,message_id,event)
            SELECT $1,(e->>'block_number')::bigint,decode(substr(e->>'block_hash',3),'hex'),
              decode(substr(e->>'tx_hash',3),'hex'),(e->>'log_index')::bigint,decode(substr(e->>'message_id',3),'hex'),e
            FROM jsonb_array_elements($2::jsonb) e
        "#, vec![self.domain(), payload.into()])).await?;
        tx.commit().await?;
        Ok(())
    }
}
