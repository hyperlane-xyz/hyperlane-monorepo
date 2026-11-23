//! Bound SQL batches using SeaQuery's parameter binding, without parsing SQL templates.
use super::{bytes, number, signed};
use crate::near_head::source::{Event, EventData, Header};
use eyre::Result;
use hyperlane_core::{address_to_bytes, h512_to_bytes, H512};
use sea_orm::{
    sea_query::{Alias, Expr, OnConflict, Query, SimpleExpr},
    ConnectionTrait, Value,
};

// Preserve table insertion order so concurrent writers acquire locks consistently.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Table {
    Block,
    Delivery,
    Gas,
    Insertion,
    Dispatch,
    Checkpoint,
}

impl Table {
    fn schema(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Block => ("block", &["domain", "hash", "height", "timestamp"]),
            Self::Checkpoint => (
                "scraper_checkpoint",
                &["domain", "hash", "height", "timestamp"],
            ),
            Self::Dispatch => (
                "raw_message_dispatch",
                &[
                    "origin_domain",
                    "origin_block_hash",
                    "origin_block_height",
                    "origin_tx_hash",
                    "transaction_index",
                    "log_index",
                    "origin_mailbox",
                    "msg_id",
                    "destination_domain",
                    "nonce",
                    "sender",
                    "recipient",
                    "msg_body",
                    "message_version",
                    "time_updated",
                ],
            ),
            Self::Delivery => (
                "delivered_message",
                &[
                    "domain",
                    "block_hash",
                    "block_number",
                    "transaction_hash",
                    "transaction_index",
                    "log_index",
                    "destination_mailbox",
                    "msg_id",
                    "sequence",
                    "time_created",
                ],
            ),
            Self::Insertion => (
                "merkle_tree_insertion",
                &[
                    "domain",
                    "block_hash",
                    "block_number",
                    "transaction_hash",
                    "transaction_index",
                    "log_index",
                    "merkle_tree_hook",
                    "message_id",
                    "leaf_index",
                ],
            ),
            Self::Gas => (
                "gas_payment",
                &[
                    "domain",
                    "block_hash",
                    "block_number",
                    "transaction_hash",
                    "transaction_index",
                    "log_index",
                    "interchain_gas_paymaster",
                    "msg_id",
                    "destination",
                    "gas_amount",
                    "payment",
                    "origin",
                    "sequence",
                    "time_created",
                ],
            ),
        }
    }
}

pub(super) fn header_row(domain: i32, header: &Header) -> Result<Vec<SimpleExpr>> {
    Ok(vec![
        Expr::val(domain).into(),
        Expr::val(bytes(header.hash)).into(),
        Expr::val(number(header.height)?).into(),
        Expr::cust_with_values(
            "to_timestamp($1::bigint) AT TIME ZONE 'UTC'",
            [number(header.timestamp)?],
        ),
    ])
}

pub(super) fn event_row(
    domain: i32,
    header: &Header,
    event: &Event,
) -> Result<(Table, Vec<SimpleExpr>)> {
    // Dispatches require a hash even when an indexer cannot resolve the transaction.
    let transaction_hash = match (&event.data, &event.tx_hash) {
        (_, Some(hash)) => Some(h512_to_bytes(hash)),
        (EventData::Dispatch(_), None) => Some(h512_to_bytes(&H512::zero())),
        _ => None,
    };
    let values: Vec<Value> = vec![
        domain.into(),
        bytes(header.hash),
        number(header.height)?,
        transaction_hash.into(),
        number(event.tx_index)?,
        number(event.log_index)?,
        address_to_bytes(&event.address).into(),
    ];
    let mut row: Vec<SimpleExpr> = values
        .into_iter()
        .map(|value| Expr::val(value).into())
        .collect();
    let table = match &event.data {
        EventData::Dispatch(message) => {
            row.extend([
                Expr::val(message.id().as_bytes().to_vec()).into(),
                Expr::val(signed(message.destination)).into(),
                Expr::val(signed(message.nonce)).into(),
                Expr::val(address_to_bytes(&message.sender)).into(),
                Expr::val(address_to_bytes(&message.recipient)).into(),
                Expr::val(message.body.clone()).into(),
                Expr::val(i16::from(message.version)).into(),
                Expr::cust("now()"),
            ]);
            Table::Dispatch
        }
        EventData::Delivery(id) => {
            row.extend([
                Expr::val(id.as_bytes().to_vec()).into(),
                Expr::val(event.sequence.map(i64::from)).into(),
                Expr::cust("now()"),
            ]);
            Table::Delivery
        }
        EventData::Insertion { message_id, index } => {
            row.extend([
                Expr::val(message_id.as_bytes().to_vec()).into(),
                Expr::val(signed(*index)).into(),
            ]);
            Table::Insertion
        }
        EventData::Gas {
            message_id,
            destination,
            gas,
            payment,
        } => {
            row.extend([
                Expr::val(message_id.as_bytes().to_vec()).into(),
                Expr::val(signed(*destination)).into(),
                Expr::cust_with_values("$1::text::numeric", [gas.clone()]),
                Expr::cust_with_values("$1::text::numeric", [payment.clone()]),
                Expr::val(domain).into(),
                Expr::val(event.sequence.map(i64::from)).into(),
                Expr::cust("now()"),
            ]);
            Table::Gas
        }
    };
    Ok((table, row))
}

pub(super) async fn insert_batch<C: ConnectionTrait>(
    db: &C,
    table: Table,
    rows: &[Vec<SimpleExpr>],
) -> Result<()> {
    let (name, columns) = table.schema();
    // At most 14,000 parameters, below PostgreSQL's 65,535 limit.
    for chunk in rows.chunks(1000) {
        let mut query = Query::insert();
        query
            .into_table(Alias::new(name))
            .columns(columns.iter().map(|column| Alias::new(*column)));
        for row in chunk {
            query.values(row.clone())?;
        }
        if table == Table::Block {
            query.on_conflict(
                OnConflict::column(Alias::new("hash"))
                    .do_nothing()
                    .to_owned(),
            );
        }
        db.execute(db.get_database_backend().build(&query)).await?;
    }
    Ok(())
}
