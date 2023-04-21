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
    use hyperlane_core::{HyperlaneMessage, RawHyperlaneMessage, H256};

    use crate::db::HyperlaneDB;

    use super::*;

    #[tokio::test]
    async fn db_stores_and_retrieves_messages() {
        run_test_db(|db| async move {
            let mailbox_name = "mailbox_1".to_owned();
            let db = HyperlaneDB::new(mailbox_name, db);

            let m = HyperlaneMessage {
                nonce: 100,
                version: 0,
                origin: 10,
                sender: H256::from_low_u64_be(4),
                destination: 12,
                recipient: H256::from_low_u64_be(5),
                body: vec![1, 2, 3],
            };

            db.store_message(&m).unwrap();

            let by_id = db.message_by_id(m.id()).unwrap().unwrap();
            assert_eq!(
                RawHyperlaneMessage::from(&by_id),
                RawHyperlaneMessage::from(&m)
            );

            let by_nonce = db.message_by_nonce(m.nonce).unwrap().unwrap();
            assert_eq!(
                RawHyperlaneMessage::from(&by_nonce),
                RawHyperlaneMessage::from(&m)
            );
        })
        .await;
    }
}
