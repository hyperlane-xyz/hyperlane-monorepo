use sea_orm::ConnectionTrait;
use sea_orm_migration::prelude::*;

use crate::l20230309_types::*;
use crate::m20230309_000004_create_table_gas_payment::{GasPayment, TotalGasPayment};

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
            .alter_table(
                Table::alter()
                    .table(GasPayment::Table)
                    .modify_column(
                        ColumnDef::new_with_type(GasPayment::FeeToken, Address).not_null(),
                    )
                    .to_owned(),
            )
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

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
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

        Ok(())
    }
}
