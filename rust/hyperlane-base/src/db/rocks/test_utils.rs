use futures_util::Future;
use rocksdb::Options;
use tempfile::TempDir;

use crate::db::DB;

/// Create a database from a path.
pub fn setup_db(db_path: String) -> DB {
    let mut opts = Options::default();
    opts.create_if_missing(true);
    rocksdb::DB::open(&opts, db_path)
        .expect("Failed to open db path")
        .into()
}

/// Create a temporary database for testing purposes.
pub async fn run_test_db<T, Fut>(test: T)
where
    T: FnOnce(DB) -> Fut,
    Fut: Future<Output = ()>,
{
    // Use `/tmp`-equivalent so that any resource leak of the db files will
    // eventually be cleaned up, even if e.g. TempDir's drop handler never runs
    // due to a segfault etc encountered during the test.
    let db_tmp_dir = TempDir::new().unwrap();
    let db = setup_db(db_tmp_dir.path().to_str().unwrap().into());
    test(db).await;
    let _ = rocksdb::DB::destroy(&Options::default(), db_tmp_dir);
}

#[cfg(test)]
mod test {
    use hyperlane_core::{
        HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, LogMeta, RawHyperlaneMessage, H256,
        U256,
    };

    use crate::db::HyperlaneRocksDB;

    use super::*;

    #[tokio::test]
    async fn db_stores_and_retrieves_messages() {
        run_test_db(|db| async move {
            let db = HyperlaneRocksDB::new(
                &HyperlaneDomain::new_test_domain("db_stores_and_retrieves_messages"),
                db,
            );

            let m = HyperlaneMessage {
                nonce: 100,
                version: 0,
                origin: 10,
                sender: H256::from_low_u64_be(4),
                destination: 12,
                recipient: H256::from_low_u64_be(5),
                body: vec![1, 2, 3],
            };
            let meta = LogMeta {
                address: H256::from_low_u64_be(1),
                block_number: 1,
                block_hash: H256::from_low_u64_be(1),
                transaction_hash: H256::from_low_u64_be(1),
                transaction_index: 0,
                log_index: U256::from(0),
            };

            db.store_logs(&vec![(m.clone(), meta)]).await.unwrap();

            let by_nonce = db.retrieve_message_by_nonce(m.nonce).unwrap().unwrap();
            assert_eq!(
                RawHyperlaneMessage::from(&by_nonce),
                RawHyperlaneMessage::from(&m)
            );
        })
        .await;
    }
}
