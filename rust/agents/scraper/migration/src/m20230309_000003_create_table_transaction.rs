use std::borrow::BorrowMut as _;

use sea_orm::ConnectionTrait;
use sea_orm_migration::prelude::*;

use crate::l20230309_types::*;
use crate::m20230309_000001_create_table_domain::Domain;
use crate::m20230309_000002_create_table_block::Block;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Transaction::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Transaction::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Transaction::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(
                        ColumnDef::new_with_type(Transaction::Hash, Hash)
                            .not_null()
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(Transaction::BlockId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new_with_type(Transaction::GasLimit, Wei).not_null())
                    .col(
                        ColumnDef::new_with_type(Transaction::MaxPriorityFeePerGas, Wei)
                            .borrow_mut(),
                    )
                    .col(ColumnDef::new_with_type(Transaction::MaxFeePerGas, Wei).borrow_mut())
                    .col(ColumnDef::new_with_type(Transaction::GasPrice, Wei).borrow_mut())
                    .col(ColumnDef::new_with_type(Transaction::EffectiveGasPrice, Wei).borrow_mut())
                    .col(ColumnDef::new(Transaction::Nonce).big_unsigned().not_null())
                    .col(ColumnDef::new_with_type(Transaction::Sender, Address).not_null())
                    .col(ColumnDef::new_with_type(Transaction::Recipient, Address).borrow_mut())
                    .col(ColumnDef::new_with_type(Transaction::GasUsed, Wei).not_null())
                    .col(ColumnDef::new_with_type(Transaction::CumulativeGasUsed, Wei).not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Transaction::BlockId)
                            .to(Block::Table, Block::Id),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Transaction::Table)
                    .name("transaction_hash_idx")
                    .col(Transaction::Hash)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Transaction::Table)
                    .name("transaction_sender_idx")
                    .col(Transaction::Sender)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Transaction::Table)
                    .name("transaction_block_idx")
                    .col(Transaction::BlockId)
                    .to_owned(),
            )
            .await?;

        // manager.get_connection().execute_unprepared(&format!(
        //     r#"
        //         CREATE VIEW "{tx_table}_view" AS
        //         SELECT
        //             "{tx_table}"."{tx_id}" AS "id",
        //             "{tx_table}"."{tx_time_created}" AS "time_created",
        //             concat('0x', encode("{tx_table}"."{tx_hash}"::bytea, 'hex')) AS "hash",
        //             "{tx_table}"."{tx_block_id}" AS "block_id",
        //             "{tx_table}"."{tx_gas_limit}" AS "gas_limit",
        //             "{tx_table}"."{tx_mpfpg}" AS "max_priority_fee_per_gas",
        //             "{tx_table}"."{tx_mfpg}" AS "max_fee_per_gas",
        //             "{tx_table}"."{tx_gas_price}" AS "gas_price",
        //             "{tx_table}"."{tx_egp}" AS "effective_gas_price",
        //             "{tx_table}"."{tx_nonce}" AS "nonce",
        //             concat('0x', encode("{tx_table}"."{tx_sender}"::bytea, 'hex')) AS "sender",
        //             concat('0x', encode("{tx_table}"."{tx_receipient}"::bytea, 'hex')) AS "recipient",
        //             "{tx_table}"."{tx_gas_used}" AS "gas_used",
        //             "{tx_table}"."{tx_cgu}" AS "cumulative_gas_used",
        //             "{block_table}"."{block_domain}" as "domain_id",
        //             "{domain_table}"."{domain_name}" AS "domain",
        //             "{domain_table}"."{domain_chain_id}" AS "chain_id",
        //             concat('0x', encode("{block_table}"."{block_hash}"::bytea, 'hex')) AS "block_hash",
        //             "{block_table}"."{block_height}" AS "block_height",
        //             "{block_table}"."{block_timestamp}" AS "timestamp"
        //         FROM "{tx_table}"
        //             INNER JOIN "{block_table}"
        //                 ON "{block_table}"."{block_id}" = "{tx_table}"."{tx_block_id}"
        //             INNER JOIN "{domain_table}"
        //                 ON "{domain_table}"."{domain_id}" = "{block_table}"."{block_domain}"
        //     "#,
        //     tx_table = Transaction::Table.to_string(),
        //     tx_id = Transaction::Id.to_string(),
        //     tx_time_created = Transaction::TimeCreated.to_string(),
        //     tx_hash = Transaction::Hash.to_string(),
        //     tx_block_id = Transaction::BlockId.to_string(),
        //     tx_gas_limit = Transaction::GasLimit.to_string(),
        //     tx_mpfpg = Transaction::MaxPriorityFeePerGas.to_string(),
        //     tx_mfpg = Transaction::MaxFeePerGas.to_string(),
        //     tx_gas_price = Transaction::GasPrice.to_string(),
        //     tx_egp = Transaction::EffectiveGasPrice.to_string(),
        //     tx_nonce = Transaction::Nonce.to_string(),
        //     tx_sender = Transaction::Sender.to_string(),
        //     tx_receipient = Transaction::Recipient.to_string(),
        //     tx_gas_used = Transaction::GasUsed.to_string(),
        //     tx_cgu = Transaction::CumulativeGasUsed.to_string(),
        // 
        //     block_table = Block::Table.to_string(),
        //     block_id = Block::Id.to_string(),
        //     block_domain = Block::Domain.to_string(),
        //     block_hash=Block::Hash.to_string(),
        //     block_height=Block::Height.to_string(),
        //     block_timestamp=Block::Timestamp.to_string(),
        // 
        //     domain_table = Domain::Table.to_string(),
        //     domain_id = Domain::Id.to_string(),
        //     domain_name=Domain::Name.to_string(),
        //     domain_chain_id=Domain::ChainId.to_string(),
        // )).await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // manager
        //     .get_connection()
        //     .execute_unprepared(&format!(
        //         r#"DROP VIEW IF EXISTS "{}_view""#,
        //         Transaction::Table.to_string()
        //     ))
        //     .await?;

        manager
            .drop_table(Table::drop().table(Transaction::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum Transaction {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// The transaction hash
    Hash,
    /// Block this transaction was included in
    BlockId,
    /// Amount of gas which was allocated for running the transaction
    GasLimit,
    MaxPriorityFeePerGas,
    MaxFeePerGas,
    /// Price paid for gas on this txn. Null for type 2 txns.
    GasPrice,
    EffectiveGasPrice,
    /// Nonce of this transaction by the sneder
    Nonce,
    /// Transaction signer
    Sender,
    /// Recipient or contract
    Recipient,
    /// Amount of gas used by this transaction
    GasUsed,
    /// Cumulative gas used within the block after this was executed
    CumulativeGasUsed,
}
