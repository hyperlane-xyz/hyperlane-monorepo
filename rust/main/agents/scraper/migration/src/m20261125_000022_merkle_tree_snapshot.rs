use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let branch = (0..32)
            .map(|i| format!("branch_{i} bytea NOT NULL CHECK (octet_length(branch_{i})=32)"))
            .collect::<Vec<_>>()
            .join(", ");
        manager.get_connection().execute_unprepared(&format!(
            "CREATE TABLE merkle_tree_snapshot (
                domain integer PRIMARY KEY REFERENCES scraper_head(domain) ON DELETE CASCADE,
                merkle_tree_hook bytea NOT NULL,
                confirmed_height bigint NOT NULL,
                block_hash bytea NOT NULL CHECK (octet_length(block_hash)=32),
                root bytea NOT NULL CHECK (octet_length(root)=32),
                leaf_count bigint NOT NULL CHECK (leaf_count BETWEEN 0 AND 4294967295),
                leaf_index bigint CHECK (leaf_index IS NOT DISTINCT FROM (NULLIF(leaf_count,0)-1)),
                {branch}
             );
             DO $$ DECLARE item record; BEGIN
               FOR item IN SELECT a.grantee,a.privilege_type FROM pg_class c
                 CROSS JOIN LATERAL aclexplode(c.relacl) a
                 WHERE c.oid='scraper_head'::regclass AND a.privilege_type IN ('SELECT','INSERT','UPDATE')
               LOOP
                 EXECUTE format('GRANT %s ON merkle_tree_snapshot TO %s',CASE WHEN item.privilege_type='UPDATE' THEN 'UPDATE,DELETE' ELSE item.privilege_type END,
                   CASE WHEN item.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END);
               END LOOP;
             END $$;"
        )).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP TABLE merkle_tree_snapshot")
            .await?;
        Ok(())
    }
}
