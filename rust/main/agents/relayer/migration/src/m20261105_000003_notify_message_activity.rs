use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                CREATE FUNCTION public.notify_message_activity_insert()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                BEGIN
                    PERFORM pg_notify('message_activity_insert', encode(NEW.message_id, 'hex'));
                    RETURN NEW;
                END;
                $$;

                CREATE TRIGGER notify_message_activity_insert
                AFTER INSERT ON public.message_activity
                FOR EACH ROW
                EXECUTE FUNCTION public.notify_message_activity_insert();
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
                DROP TRIGGER notify_message_activity_insert ON public.message_activity;
                DROP FUNCTION public.notify_message_activity_insert();
                "#,
            )
            .await?;
        Ok(())
    }
}
