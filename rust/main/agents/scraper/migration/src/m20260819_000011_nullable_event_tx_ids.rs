use sea_orm_migration::prelude::*;

/// Allow events whose transaction could not be resolved on-chain (e.g. Sealevel
/// basic log meta fallback, which carries zero transaction and block hashes) to
/// be stored with a NULL transaction relation instead of being dropped.
///
/// Uses raw SQL because `Table::alter().modify_column()` emits
/// `ALTER COLUMN ... TYPE`, which Postgres rejects for columns referenced by
/// views (`message_view`); dropping the NOT NULL constraint directly is allowed.
///
/// `down` (SET NOT NULL) fails if any NULL rows exist, matching this crate's
/// best-effort downgrade convention. Before downgrading, operators must either
/// backfill valid transaction IDs or explicitly discard unresolved events:
/// `DELETE FROM message WHERE origin_tx_id IS NULL;`
/// `DELETE FROM delivered_message WHERE destination_tx_id IS NULL;`
/// `DELETE FROM gas_payment WHERE tx_id IS NULL;`
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                ALTER TABLE "message" ALTER COLUMN "origin_tx_id" DROP NOT NULL;
                ALTER TABLE "delivered_message" ALTER COLUMN "destination_tx_id" DROP NOT NULL;
                ALTER TABLE "gas_payment" ALTER COLUMN "tx_id" DROP NOT NULL;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                ALTER TABLE "message" ALTER COLUMN "origin_tx_id" SET NOT NULL;
                ALTER TABLE "delivered_message" ALTER COLUMN "destination_tx_id" SET NOT NULL;
                ALTER TABLE "gas_payment" ALTER COLUMN "tx_id" SET NOT NULL;
                "#,
            )
            .await?;
        Ok(())
    }
}
