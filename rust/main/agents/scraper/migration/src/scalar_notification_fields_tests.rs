use std::time::Duration;

use sea_orm::{
    sqlx::postgres::PgListener, ConnectionTrait, Database, DbBackend, Statement, TransactionTrait,
};
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::*;
use crate::{Migrator, MigratorTrait};

const SENTINEL_CHANNEL: &str = "scraper_test_sentinel";

fn insert(table: &str, id: i64, domain: i32, height: Option<i64>) -> String {
    let height = height.map_or_else(|| "NULL".to_owned(), |height| height.to_string());
    let hash = format!("decode(lpad(to_hex({id}),64,'0'),'hex')");
    match table {
        "raw_message_dispatch" => format!(
            "INSERT INTO raw_message_dispatch(id,msg_id,origin_tx_hash,origin_block_hash,origin_block_height,nonce,origin_domain,destination_domain,sender,recipient,origin_mailbox,msg_body) VALUES ({id},{hash},{hash},{hash},{height},{id},{domain},1,{hash},{hash},{hash},decode(repeat('ab',65536),'hex'))"
        ),
        "delivered_message" => format!(
            "INSERT INTO delivered_message(id,msg_id,domain,destination_mailbox,block_number) VALUES ({id},{hash},{domain},{hash},{height})"
        ),
        "gas_payment" => format!(
            "INSERT INTO gas_payment(id,msg_id,domain,origin,destination,interchain_gas_paymaster,payment,gas_amount,log_index,block_number) VALUES ({id},{hash},{domain},1,1,{hash},1,1,{id},{height})"
        ),
        "merkle_tree_insertion" => format!(
            "INSERT INTO merkle_tree_insertion(id,message_id,domain,merkle_tree_hook,leaf_index,block_number) VALUES ({id},{hash},{domain},{hash},{id},{height})"
        ),
        "message" => format!(
            "INSERT INTO message(id,msg_id,origin,destination,nonce,sender,recipient,origin_mailbox,msg_body) VALUES ({id},{hash},1,1,{id},{hash},{hash},{hash},decode(repeat('ab',65536),'hex'))"
        ),
        _ => panic!("unknown fixture table"),
    }
}

async fn notifications(
    db: &impl ConnectionTrait,
    listener: &mut PgListener,
) -> eyre::Result<Vec<(String, serde_json::Value)>> {
    // Every caller has awaited the writer's commit (or rollback). The pooled
    // connection issuing this sentinel can differ from the writer; PostgreSQL
    // guarantees delivery to this listener in transaction commit order:
    // https://www.postgresql.org/docs/16/sql-notify.html
    db.execute_unprepared("NOTIFY scraper_test_sentinel")
        .await?;
    let mut messages = tokio::time::timeout(Duration::from_secs(5), async {
        let mut messages = Vec::new();
        loop {
            let notification = listener.recv().await?;
            if notification.channel() == SENTINEL_CHANNEL {
                return Ok::<_, eyre::Report>(messages);
            }
            messages.push((
                notification.channel().to_owned(),
                serde_json::from_str(notification.payload())?,
            ));
        }
    })
    .await??;
    messages.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(messages)
}

async fn assert_notification_bindings(db: &impl ConnectionTrait) -> eyre::Result<()> {
    let bindings = db
        .query_all(Statement::from_string(
            DbBackend::Postgres,
            "SELECT p.proname,c.relname,t.tgname
             FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
             JOIN pg_class c ON c.oid=t.tgrelid
             JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE NOT t.tgisinternal AND n.nspname=current_schema()
               AND p.proname IN ('notify_scraper_event','notify_scraper_explorer_event')
             ORDER BY p.proname,c.relname,t.tgname"
                .to_owned(),
        ))
        .await?
        .into_iter()
        .map(|row| {
            Ok((
                row.try_get::<String>("", "proname")?,
                row.try_get::<String>("", "relname")?,
                row.try_get::<String>("", "tgname")?,
            ))
        })
        .collect::<Result<Vec<_>, DbErr>>()?;
    let expected = [
        (
            "notify_scraper_event",
            "delivered_message",
            "scraper_event_notify",
        ),
        (
            "notify_scraper_event",
            "gas_payment",
            "scraper_event_notify",
        ),
        (
            "notify_scraper_event",
            "merkle_tree_insertion",
            "scraper_event_notify",
        ),
        (
            "notify_scraper_event",
            "raw_message_dispatch",
            "scraper_event_notify",
        ),
        (
            "notify_scraper_explorer_event",
            "delivered_message",
            "scraper_explorer_event_notify",
        ),
        (
            "notify_scraper_explorer_event",
            "gas_payment",
            "scraper_explorer_event_notify",
        ),
        (
            "notify_scraper_explorer_event",
            "message",
            "scraper_explorer_event_notify",
        ),
    ]
    .map(|(function, table, trigger)| (function.to_owned(), table.to_owned(), trigger.to_owned()));
    assert_eq!(bindings, expected);
    Ok(())
}

#[tokio::test]
async fn preserves_legacy_frontier_and_explorer_notifications_through_rollback() -> eyre::Result<()>
{
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    Migrator::up(&db, None).await?;
    let mut listener = PgListener::connect(&url).await?;
    listener.listen("scraper_event").await?;
    listener.listen("scraper_explorer_event").await?;
    listener.listen(SENTINEL_CHANNEL).await?;
    let mut id = 10_000;

    // Run the same behavioral checks with the optimized functions, their
    // rollback definitions, and a repeated upgrade on already populated tables.
    for direction in ["up", "down", "up"] {
        let manager = SchemaManager::new(&db);
        if direction == "down" {
            Migration.down(&manager).await?;
        } else {
            Migration.up(&manager).await?;
        }
        assert_notification_bindings(&db).await?;
        db.execute_unprepared("DELETE FROM scraper_head").await?;
        for (table, event_type, explorer) in [
            ("raw_message_dispatch", "dispatch", false),
            ("delivered_message", "delivery", true),
            ("gas_payment", "gas_payment", true),
            ("merkle_tree_insertion", "merkle_tree_insertion", false),
        ] {
            id += 1;
            db.execute_unprepared(&insert(table, id, 1, Some(4)))
                .await?;
            let messages = notifications(&db, &mut listener).await?;
            assert_eq!(messages.len(), if explorer { 2 } else { 1 }, "{table}");
            assert_eq!(messages[0].0, "scraper_event");
            assert_eq!(messages[0].1["eventType"], event_type);
            assert_eq!(messages[0].1["id"], id.to_string());
            assert_eq!(messages[0].1["domain"], 1);
            if explorer {
                assert_eq!(messages[1].0, "scraper_explorer_event");
                assert_eq!(messages[1].1["messageId"], format!("{id:064x}"));
            }
        }

        db.execute_unprepared("INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster) VALUES(1,0,10,decode('01','hex'),10,5,decode('01','hex'),decode('02','hex'),decode('03','hex'))").await?;
        for table in [
            "raw_message_dispatch",
            "delivered_message",
            "gas_payment",
            "merkle_tree_insertion",
        ] {
            for height in [4, 5, 6] {
                id += 1;
                db.execute_unprepared(&insert(table, id, 1, Some(height)))
                    .await?;
                assert!(
                    notifications(&db, &mut listener).await?.is_empty(),
                    "{table} insert {height}"
                );
                if matches!(table, "delivered_message" | "gas_payment") {
                    db.execute_unprepared(&format!(
                        "UPDATE {table} SET block_number={height} WHERE id={id}"
                    ))
                    .await?;
                    let messages = notifications(&db, &mut listener).await?;
                    assert_eq!(
                        messages.len(),
                        usize::from(height <= 5),
                        "{table} update {height}"
                    );
                    if let Some((channel, payload)) = messages.first() {
                        assert_eq!(channel, "scraper_explorer_event");
                        assert_eq!(payload["messageId"], format!("{id:064x}"));
                    }
                }
            }
        }
        // Height-less legacy writers stay immediately visible on frontier domains.
        for table in ["delivered_message", "gas_payment"] {
            id += 1;
            db.execute_unprepared(&insert(table, id, 1, None)).await?;
            assert_eq!(
                notifications(&db, &mut listener).await?.len(),
                2,
                "{table} null height"
            );
        }
        // Enriched messages have no domain/block_number fields at all.
        id += 1;
        db.execute_unprepared(&insert("message", id, 1, None))
            .await?;
        assert_eq!(
            notifications(&db, &mut listener).await?[0].0,
            "scraper_explorer_event"
        );
        db.execute_unprepared(&format!(
            "UPDATE message SET msg_body=decode('ab','hex') WHERE id={id}"
        ))
        .await?;
        assert_eq!(notifications(&db, &mut listener).await?.len(), 1);

        id += 1;
        db.execute_unprepared(&insert("raw_message_dispatch", id, -1, Some(4)))
            .await?;
        assert_eq!(
            notifications(&db, &mut listener).await?[0].1["domain"],
            4_294_967_295u64
        );
        id += 1;
        let transaction = db.begin().await?;
        transaction
            .execute_unprepared(&insert("raw_message_dispatch", id, -1, Some(4)))
            .await?;
        transaction.rollback().await?;
        assert!(notifications(&db, &mut listener).await?.is_empty());
    }
    Ok(())
}
