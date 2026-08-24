//! Build the WebSocket catch-up index without blocking scraper inserts.

use common::init;
use migration::sea_orm::ConnectionTrait;

mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() -> eyre::Result<()> {
    init()
        .await?
        .execute_unprepared(
            r#"
            CREATE INDEX CONCURRENTLY IF NOT EXISTS raw_message_dispatch_native_sequence_idx
            ON raw_message_dispatch (origin_domain, origin_mailbox, nonce)
            "#,
        )
        .await?;
    Ok(())
}
