use std::{collections::BTreeMap, time::Duration};

use migration::MigratorTrait;
use sea_orm::{
    ConnectionTrait, Database, DatabaseBackend, DbErr, MockDatabase, Statement, TransactionTrait,
    Value,
};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use super::*;
use hyperlane_core::{
    ChainInfo, ChainResult, HyperlaneChain, KnownHyperlaneDomain, TxnInfo, TxnReceiptInfo, U256,
};

#[derive(Clone, Debug)]
struct Provider(HyperlaneDomain);
impl HyperlaneChain for Provider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.0
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}
fn txn_info(hash: H512) -> TxnInfo {
    TxnInfo {
        hash,
        gas_limit: U256::one(),
        max_priority_fee_per_gas: None,
        max_fee_per_gas: None,
        gas_price: None,
        nonce: 0,
        sender: H256::zero(),
        recipient: None,
        receipt: Some(TxnReceiptInfo {
            gas_used: U256::one(),
            cumulative_gas_used: U256::one(),
            effective_gas_price: None,
        }),
        raw_input_data: None,
    }
}
#[async_trait]
impl HyperlaneProvider for Provider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        Ok(BlockInfo {
            hash: H256::from_low_u64_be(height),
            number: height,
            timestamp: 1_700_000_000,
        })
    }
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        Ok(txn_info(*hash))
    }
    async fn is_contract(&self, _: &H256) -> ChainResult<bool> {
        panic!("unexpected RPC")
    }
    async fn get_balance(&self, _: String) -> ChainResult<U256> {
        panic!("unexpected RPC")
    }
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        panic!("unexpected RPC")
    }
}
async fn store(db: ScraperDb) -> eyre::Result<HyperlaneDbStore> {
    let domain: HyperlaneDomain = KnownHyperlaneDomain::Ethereum.into();
    HyperlaneDbStore::new(
        db,
        domain.clone(),
        CoreContractAddresses::default(),
        Arc::new(Provider(domain)),
        &IndexSettings::default(),
        None,
    )
    .await
}
fn row(id: i64, hash: Vec<u8>) -> BTreeMap<String, Value> {
    BTreeMap::from([("id".into(), id.into()), ("hash".into(), hash.into())])
}
async fn ensure(
    store: &HyperlaneDbStore,
    txn: bool,
    count: u64,
) -> eyre::Result<HashMap<H512, i64>> {
    if txn {
        Ok(store
            .ensure_txns((1..=count).map(|n| TxnWithBlockId {
                txn_hash: H512::from_low_u64_be(n),
                block_id: 1,
            }))
            .await?
            .collect())
    } else {
        Ok(store
            .ensure_blocks((1..=count).map(|n| BlockId::new(H256::from_low_u64_be(n), n)))
            .await?
            .map(|b| (H512::from_low_u64_be(b.hash.to_low_u64_be()), b.id))
            .collect())
    }
}
#[tokio::test]
async fn enrichment_returning_only_queries_missing_hashes() -> eyre::Result<()> {
    for txn in [false, true] {
        for returned in [0, 1, 2] {
            let hash = |n| {
                if txn {
                    hyperlane_core::h512_to_bytes(&H512::from_low_u64_be(n))
                } else {
                    hyperlane_core::h256_to_bytes(&H256::from_low_u64_be(n))
                }
            };
            let mut results = vec![
                vec![],
                vec![],
                (1..=returned).map(|n| row(n as i64, hash(n))).collect(),
            ];
            if returned < 2 {
                results.push(
                    ((returned + 1)..=2)
                        .map(|n| row(n as i64, hash(n)))
                        .collect(),
                );
            }
            let db = ScraperDb::with_connection(
                MockDatabase::new(DatabaseBackend::Postgres)
                    .append_query_results(results)
                    .into_connection(),
            );
            let store = store(db).await?;
            assert_eq!(
                ensure(&store, txn, 2).await?,
                HashMap::from([(H512::from_low_u64_be(1), 1), (H512::from_low_u64_be(2), 2)])
            );
            let log = store.db.clone_connection().into_transaction_log();
            // Exclude the cursor initialization SELECT.
            assert_eq!(log.len() - 1, if returned == 2 { 2 } else { 3 });
            let insert = &log[2].statements()[0];
            assert!(
                insert.sql.ends_with("RETURNING \"id\", \"hash\""),
                "{}",
                insert.sql
            );
            assert!(insert.sql.contains("DO NOTHING"));
            if returned < 2 {
                let lookup = &log[3].statements()[0];
                assert_eq!(
                    lookup.values.as_ref().unwrap().0.len(),
                    (2 - returned) as usize
                );
                for n in (returned + 1)..=2 {
                    assert!(lookup.values.as_ref().unwrap().0.contains(&hash(n).into()));
                }
            }
        }
    }
    Ok(())
}
#[tokio::test]
async fn enrichment_returning_errors_and_empty_inputs_preserve_boundaries() -> eyre::Result<()> {
    for txn in [false, true] {
        for insertion_fails in [false, true] {
            let mut db = MockDatabase::new(DatabaseBackend::Postgres).append_query_results(vec![
                    Vec::<
                        BTreeMap<String, Value>,
                    >::new(
                    );
                    if insertion_fails {
                        2
                    } else {
                        3
                    }
                ]);
            db = db.append_query_errors([DbErr::Custom("enrichment read/write failed".into())]);
            let store = store(ScraperDb::with_connection(db.into_connection())).await?;
            assert!(ensure(&store, txn, 0).await?.is_empty());
            assert!(store
                .db
                .store_blocks(1, std::iter::empty())
                .await?
                .is_empty());
            assert!(store.db.store_txns(std::iter::empty()).await?.is_empty());
            let error = ensure(&store, txn, 1).await.unwrap_err();
            assert!(format!("{error:#}").contains("enrichment read/write failed"));
            assert_eq!(
                store.db.clone_connection().into_transaction_log().len(),
                if insertion_fails { 3 } else { 4 }
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn enrichment_returning_observes_concurrent_conflict_winner_in_postgres() -> eyre::Result<()>
{
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let store = store(ScraperDb::with_connection(connection)).await?;
    let connection = store.db.clone_connection();
    for txn in [false, true] {
        let winner = connection.begin().await?;
        let (table, sql) = if txn {
            ("transaction", "INSERT INTO \"transaction\" (time_created,hash,block_id,gas_limit,nonce,sender,gas_used,cumulative_gas_used) VALUES (now(),$1,$2,1,0,$3,1,1) RETURNING id")
        } else {
            ("block", "INSERT INTO \"block\" (time_created,hash,domain,height,timestamp) VALUES (now(),$1,1,1,now()) RETURNING id")
        };
        let mut params: Vec<Value> =
            vec![hyperlane_core::h256_to_bytes(&H256::from_low_u64_be(1)).into()];
        if txn {
            let block_id = store
                .db
                .get_block_basic([&H256::from_low_u64_be(1)].into_iter())
                .await?[0]
                .id;
            params.extend([
                block_id.into(),
                hyperlane_core::address_to_bytes(&H256::zero()).into(),
            ]);
        }
        let winner_id: i64 = winner
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                sql,
                params,
            ))
            .await?
            .unwrap()
            .try_get("", "id")?;
        let waiting_insert = format!("INSERT INTO \"{table}\"%");
        let commit_when_blocked = async {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let row = connection.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                        "SELECT COUNT(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1", [waiting_insert.clone().into()])).await?.unwrap();
                    if row.try_get::<i64>("", "waiting")? > 0 { break; }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Ok::<_, eyre::Report>(())
            }).await??;
            winner.commit().await?;
            Ok::<_, eyre::Report>(())
        };
        let (found, ()) = tokio::try_join!(ensure(&store, txn, 1), commit_when_blocked)?;
        assert_eq!(found[&H512::from_low_u64_be(1)], winner_id);
        assert_eq!(
            ensure(&store, txn, 1).await?,
            found,
            "replay keeps the winner ID"
        );
    }
    Ok(())
}
