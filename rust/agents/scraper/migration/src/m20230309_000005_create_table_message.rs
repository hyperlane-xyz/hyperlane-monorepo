use sea_orm::ConnectionTrait;
use sea_orm_migration::prelude::*;

use crate::l20230309_types::*;
use crate::m20230309_000001_create_table_domain::Domain;
use crate::m20230309_000002_create_table_block::Block;
use crate::m20230309_000003_create_table_transaction::Transaction;
use crate::m20230309_000004_create_table_delivered_message::DeliveredMessage;
use crate::m20230309_000004_create_table_gas_payment::TotalGasPayment;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Message::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Message::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Message::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(
                        ColumnDef::new_with_type(Message::MsgId, Hash)
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(Message::Origin).unsigned().not_null())
                    .col(ColumnDef::new(Message::Destination).unsigned().not_null())
                    .col(ColumnDef::new(Message::Nonce).unsigned().not_null())
                    .col(ColumnDef::new_with_type(Message::Sender, Address).not_null())
                    .col(ColumnDef::new_with_type(Message::Recipient, Address).not_null())
                    .col(ColumnDef::new(Message::MsgBody).binary())
                    .col(ColumnDef::new_with_type(Message::OriginMailbox, Address).not_null())
                    .col(ColumnDef::new(Message::OriginTxId).big_integer().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Message::Origin)
                            .to(Domain::Table, Domain::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Message::OriginTxId)
                            .to(Transaction::Table, Transaction::Id),
                    )
                    .index(
                        Index::create()
                            .unique()
                            .col(Message::OriginMailbox)
                            .col(Message::Origin)
                            .col(Message::Nonce),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Message::Table)
                    .name("message_sender_idx")
                    .col(Message::Sender)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Message::Table)
                    .name("message_recipient_idx")
                    .col(Message::Recipient)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Message::Table)
                    .name("message_msg_id_idx")
                    .col(Message::MsgId)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;
        let sql = format!(
            r#"
            CREATE VIEW "{msg_table}_view" AS
            SELECT
                "msg"."{msg_id}" AS "id",
                "msg"."{msg_mid}" AS "msg_id",
                "msg"."{msg_nonce}" AS "nonce",

                "dmsg"."{dmsg_id}" IS NOT NULL AS "is_delivered",

                COALESCE("tgp"."{tgp_payment}", '0') AS "total_payment",
                COALESCE("tgp"."{tgp_gas_amount}", '0') AS "total_gas_amount",

                "msg"."{msg_origin}" AS "origin_domain_id",
                "origin_domain"."{domain_chain_id}" AS "origin_chain_id",
                "origin_domain"."{domain_name}" AS "origin_domain",

                "msg"."{msg_dest}" AS "destination_domain_id",
                "dest_domain"."{domain_chain_id}" AS "destination_chain_id",
                "dest_domain"."{domain_name}" AS "destination_domain",

                "msg"."{msg_time_created}" AS "send_scraped_at",
                "origin_block"."{block_timestamp}" AS "send_occurred_at",
                "dmsg"."{dmsg_time_created}" AS "delivery_scraped_at",
                "dest_block"."{block_timestamp}" AS "delivery_occurred_at",
                "dest_block"."{block_timestamp}" - "origin_block"."{block_timestamp}" AS "delivery_latency",
                "msg"."{msg_time_created}" - "origin_block"."{block_timestamp}" AS "send_scape_latency",
                "dmsg"."{dmsg_time_created}" - "dest_block"."{block_timestamp}" AS "delivery_scape_latency",

                "msg"."{msg_sender}" AS "sender",
                "msg"."{msg_recipient}" AS "recipient",
                "msg"."{msg_origin_mb}" AS "origin_mailbox",
                "dmsg"."{dmsg_dest_mb}" AS "destination_mailbox",

                "msg"."{msg_oti}" AS "origin_tx_id",
                "origin_tx"."{tx_hash}" AS "origin_tx_hash",
                "origin_tx"."{tx_gas_limit}" AS "origin_tx_gas_limit",
                "origin_tx"."{tx_mpfpg}" AS "origin_tx_max_priority_fee_per_gas",
                "origin_tx"."{tx_mfpg}" AS "origin_tx_max_fee_per_gas",
                "origin_tx"."{tx_gas_price}" AS "origin_tx_gas_price",
                "origin_tx"."{tx_egp}" AS "origin_tx_effective_gas_price",
                "origin_tx"."{tx_nonce}" AS "origin_tx_nonce",
                "origin_tx"."{tx_sender}" AS "origin_tx_sender",
                "origin_tx"."{tx_receipient}" AS "origin_tx_recipient",
                "origin_tx"."{tx_gas_used}" AS "origin_tx_gas_used",
                "origin_tx"."{tx_cgu}" AS "origin_tx_cumulative_gas_used",

                "origin_tx"."{tx_block_id}" AS "origin_block_id",
                "origin_block"."{block_height}" AS "origin_block_height",
                "origin_block"."{block_hash}" AS "origin_block_hash",

                "dmsg"."{dmsg_dti}" AS "destination_tx_id",
                "dest_tx"."{tx_hash}" AS "destination_tx_hash",
                "dest_tx"."{tx_gas_limit}" AS "destination_tx_gas_limit",
                "dest_tx"."{tx_mpfpg}" AS "destination_tx_max_priority_fee_per_gas",
                "dest_tx"."{tx_mfpg}" AS "destination_tx_max_fee_per_gas",
                "dest_tx"."{tx_gas_price}" AS "destination_tx_gas_price",
                "dest_tx"."{tx_egp}" AS "destination_tx_effective_gas_price",
                "dest_tx"."{tx_nonce}" AS "destination_tx_nonce",
                "dest_tx"."{tx_sender}" AS "destination_tx_sender",
                "dest_tx"."{tx_receipient}" AS "destination_tx_recipient",
                "dest_tx"."{tx_gas_used}" AS "destination_tx_gas_used",
                "dest_tx"."{tx_cgu}" AS "destination_tx_cumulative_gas_used",

                "dest_tx"."{tx_block_id}" AS "destination_block_id",
                "dest_block"."{block_height}" AS "destination_block_height",
                "dest_block"."{block_hash}" AS "destination_block_hash",

                convert_from("msg"."{msg_body}", 'UTF8') AS "message_body_text"
                "msg"."{msg_body}" AS "message_body",
            FROM "{msg_table}" AS "msg"
                INNER JOIN "{domain_table}"
                    AS "origin_domain"
                    ON "origin_domain"."{domain_id}" = "msg"."{msg_origin}"
                INNER JOIN "{domain_table}"
                    AS "dest_domain"
                    ON "dest_domain"."{domain_id}" = "msg"."{msg_dest}"
                INNER JOIN "{tx_table}"
                    AS "origin_tx"
                    ON "origin_tx"."{tx_id}" = "msg"."{msg_oti}"
                INNER JOIN "{block_table}"
                    AS "origin_block"
                    ON "origin_block"."{block_id}" = "origin_tx"."{tx_block_id}"
                LEFT JOIN "{tgp_table}"
                    AS "tgp"
                    ON "tgp"."{tgp_mid}" = "msg"."{msg_mid}"
                LEFT JOIN "{dmsg_table}"
                    AS "dmsg"
                    ON "dmsg"."{dmsg_mid}" = "msg"."{msg_mid}"
                LEFT JOIN "{tx_table}"
                    AS "dest_tx"
                    ON "dest_tx"."{tx_id}" = "dmsg"."{dmsg_dti}"
                LEFT JOIN "{block_table}"
                    AS "dest_block"
                    ON "dest_block"."{block_id}" = "dest_tx"."{tx_block_id}"
            "#,
            msg_table = Message::Table.to_string(),
            msg_id = Message::Id.to_string(),
            msg_time_created = Message::TimeCreated.to_string(),
            msg_mid = Message::MsgId.to_string(),
            msg_origin = Message::Origin.to_string(),
            msg_dest = Message::Destination.to_string(),
            msg_nonce = Message::Nonce.to_string(),
            msg_sender = Message::Sender.to_string(),
            msg_recipient = Message::Recipient.to_string(),
            msg_body = Message::MsgBody.to_string(),
            msg_origin_mb = Message::OriginMailbox.to_string(),
            msg_oti = Message::OriginTxId.to_string(),
            domain_table = Domain::Table.to_string(),
            domain_id = Domain::Id.to_string(),
            domain_name = Domain::Name.to_string(),
            domain_chain_id = Domain::ChainId.to_string(),
            tx_table = Transaction::Table.to_string(),
            tx_id = Transaction::Id.to_string(),
            tx_hash = Transaction::Hash.to_string(),
            tx_block_id = Transaction::BlockId.to_string(),
            tx_gas_limit = Transaction::GasLimit.to_string(),
            tx_mpfpg = Transaction::MaxPriorityFeePerGas.to_string(),
            tx_mfpg = Transaction::MaxFeePerGas.to_string(),
            tx_gas_price = Transaction::GasPrice.to_string(),
            tx_egp = Transaction::EffectiveGasPrice.to_string(),
            tx_nonce = Transaction::Nonce.to_string(),
            tx_sender = Transaction::Sender.to_string(),
            tx_receipient = Transaction::Recipient.to_string(),
            tx_gas_used = Transaction::GasUsed.to_string(),
            tx_cgu = Transaction::CumulativeGasUsed.to_string(),
            block_table = Block::Table.to_string(),
            block_id = Block::Id.to_string(),
            block_hash = Block::Hash.to_string(),
            block_height = Block::Height.to_string(),
            block_timestamp = Block::Timestamp.to_string(),
            tgp_table = TotalGasPayment::Table.to_string(),
            tgp_mid = TotalGasPayment::MsgId.to_string(),
            tgp_payment = TotalGasPayment::TotalPayment.to_string(),
            tgp_gas_amount = TotalGasPayment::TotalGasAmount.to_string(),
            dmsg_table = DeliveredMessage::Table.to_string(),
            dmsg_id = DeliveredMessage::Id.to_string(),
            dmsg_mid = DeliveredMessage::MsgId.to_string(),
            dmsg_dest_mb = DeliveredMessage::DestinationMailbox.to_string(),
            dmsg_dti = DeliveredMessage::DestinationTxId.to_string(),
            dmsg_time_created = DeliveredMessage::TimeCreated.to_string(),
        );

        // eprintln!("{sql}");
        manager.get_connection().execute_unprepared(&sql).await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"DROP VIEW IF EXISTS "{}_view""#,
                Message::Table.to_string()
            ))
            .await?;

        manager
            .drop_table(Table::drop().table(Message::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum Message {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Unique id of the message on the blockchain
    MsgId,
    /// Domain ID of the origin chain
    Origin,
    /// Domain ID of the destination chain
    Destination,
    /// Nonce of this message in the merkle tree of the mailbox
    Nonce,
    /// Address of the message sender on the origin chain (not necessarily the
    /// transaction signer)
    Sender,
    /// Address of the message recipient on the destination chain.
    Recipient,
    /// Binary blob included in the message.
    MsgBody,
    /// Address of the mailbox contract which sent the message.
    OriginMailbox,
    /// Transaction this message was dispatched in on the origin chain.
    OriginTxId,
}
