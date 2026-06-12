use sea_orm::{ConnectionTrait, Statement};
use sea_orm_migration::prelude::*;

use crate::l20230309_types::*;
use crate::m20230309_000005_create_table_message::{create_message_view_sql, Message};

const NATIVE_FEE_TOKEN: &str = "'\\x0000000000000000000000000000000000000000'::bytea";

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(GasPayment::Table)
                    .add_column(
                        ColumnDef::new_with_type(GasPayment::FeeToken, Address)
                            .not_null()
                            .default(SimpleExpr::Custom(NATIVE_FEE_TOKEN.to_owned())),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"ALTER TABLE "{}" ALTER COLUMN "{}" DROP DEFAULT"#,
                GasPayment::Table.to_string(),
                GasPayment::FeeToken.to_string()
            ))
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(GasPayment::Table)
                    .name("gas_payment_msg_id_fee_token_idx")
                    .col(GasPayment::MsgId)
                    .col(GasPayment::FeeToken)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"DROP VIEW IF EXISTS "{}""#,
                TotalGasPayment::Table.to_string()
            ))
            .await?;
        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"
            CREATE VIEW "{tgp_table}" AS
            SELECT
                "gp"."{gp_mid}" AS "{tgp_mid}",
                "gp"."{gp_fee_token}" AS "{tgp_fee_token}",
                COUNT("gp"."{gp_mid}") AS "{tgp_num_payments}",
                SUM("gp"."{gp_payment}") AS "{tgp_payment}",
                SUM("gp"."{gp_gas_amount}") AS "{tgp_gas_amount}"
            FROM "{gp_table}" AS "gp"
            GROUP BY "gp"."{gp_mid}", "gp"."{gp_fee_token}"
            "#,
                gp_table = GasPayment::Table.to_string(),
                gp_mid = GasPayment::MsgId.to_string(),
                gp_fee_token = GasPayment::FeeToken.to_string(),
                gp_payment = GasPayment::Payment.to_string(),
                gp_gas_amount = GasPayment::GasAmount.to_string(),
                tgp_table = TotalGasPayment::Table.to_string(),
                tgp_mid = TotalGasPayment::MsgId.to_string(),
                tgp_fee_token = TotalGasPayment::FeeToken.to_string(),
                tgp_num_payments = TotalGasPayment::NumPayments.to_string(),
                tgp_payment = TotalGasPayment::TotalPayment.to_string(),
                tgp_gas_amount = TotalGasPayment::TotalGasAmount.to_string(),
            ))
            .await?;

        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"DROP VIEW IF EXISTS "{}_view""#,
                Message::Table.to_string()
            ))
            .await?;
        manager
            .get_connection()
            .execute_unprepared(&create_message_view_sql(Some(&format!(
                r#"AND "gp"."{}" = {}"#,
                GasPayment::FeeToken.to_string(),
                NATIVE_FEE_TOKEN,
            ))))
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Dropping `GasPayment::FeeToken` and recreating `TotalGasPayment`
        // grouped only by `MsgId` would sum payments across distinct fee
        // tokens, silently corrupting aggregates. Fail closed if any
        // non-native fee-token rows exist so the rollback cannot lose data.
        let conn = manager.get_connection();
        let non_native = conn
            .query_one(Statement::from_string(
                conn.get_database_backend(),
                format!(
                    r#"SELECT EXISTS (SELECT 1 FROM "{gp_table}" WHERE "{gp_fee_token}" <> {native}) AS "exists""#,
                    gp_table = GasPayment::Table.to_string(),
                    gp_fee_token = GasPayment::FeeToken.to_string(),
                    native = NATIVE_FEE_TOKEN,
                ),
            ))
            .await?
            .map(|row| row.try_get::<bool>("", "exists"))
            .transpose()?
            .unwrap_or(false);
        if non_native {
            return Err(DbErr::Migration(format!(
                "Cannot run down() for m20260611_000008_add_gas_payment_fee_token: \
                 non-native `{}` rows exist; dropping the column and recreating the \
                 `{}` view grouped only by `{}` would mix amounts across fee tokens \
                 and corrupt aggregates.",
                GasPayment::FeeToken.to_string(),
                TotalGasPayment::Table.to_string(),
                GasPayment::MsgId.to_string(),
            )));
        }

        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"DROP VIEW IF EXISTS "{}_view""#,
                Message::Table.to_string()
            ))
            .await?;
        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"DROP VIEW IF EXISTS "{}""#,
                TotalGasPayment::Table.to_string()
            ))
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(GasPayment::Table)
                    .name("gas_payment_msg_id_fee_token_idx")
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(GasPayment::Table)
                    .drop_column(GasPayment::FeeToken)
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"
            CREATE VIEW "{tgp_table}" AS
            SELECT
                "gp"."{gp_mid}" AS "{tgp_mid}",
                COUNT("gp"."{gp_mid}") AS "{tgp_num_payments}",
                SUM("gp"."{gp_payment}") AS "{tgp_payment}",
                SUM("gp"."{gp_gas_amount}") AS "{tgp_gas_amount}"
            FROM "{gp_table}" AS "gp"
            GROUP BY "gp"."{gp_mid}"
            "#,
                gp_table = GasPayment::Table.to_string(),
                gp_mid = GasPayment::MsgId.to_string(),
                gp_payment = GasPayment::Payment.to_string(),
                gp_gas_amount = GasPayment::GasAmount.to_string(),
                tgp_table = TotalGasPayment::Table.to_string(),
                tgp_mid = TotalGasPayment::MsgId.to_string(),
                tgp_num_payments = TotalGasPayment::NumPayments.to_string(),
                tgp_payment = TotalGasPayment::TotalPayment.to_string(),
                tgp_gas_amount = TotalGasPayment::TotalGasAmount.to_string(),
            ))
            .await?;
        manager
            .get_connection()
            .execute_unprepared(&create_message_view_sql(None))
            .await?;

        Ok(())
    }
}

#[derive(Iden)]
enum GasPayment {
    Table,
    MsgId,
    Payment,
    GasAmount,
    FeeToken,
}

#[derive(Iden)]
enum TotalGasPayment {
    Table,
    MsgId,
    FeeToken,
    NumPayments,
    TotalPayment,
    TotalGasAmount,
}
