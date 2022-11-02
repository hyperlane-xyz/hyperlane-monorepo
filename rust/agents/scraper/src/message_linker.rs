use sea_orm::DbConn;
use tracing::instrument;

/// Task-thread to link the delivered messages to the correct messages.
#[instrument(skip_all)]
pub async fn delivered_message_linker(db: DbConn) -> eyre::Result<()> {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    use std::time::Duration;
    use tokio::time::sleep;
    use tracing::info;

    const QUERY: &str = r#"
        UPDATE
            "delivered_message" AS "delivered"
        SET
            "msg_id" = "message"."id"
        FROM
            "message"
        WHERE
            "delivered"."msg_id" IS NULL
            AND "message"."hash" = "delivered"."hash"
    "#;

    loop {
        let linked = db
            .execute(Statement::from_string(
                DbBackend::Postgres,
                QUERY.to_owned(),
            ))
            .await?
            .rows_affected();
        info!(linked, "Linked message deliveries");
        sleep(Duration::from_secs(10)).await;
    }
}
