use futures_util::Future;
use rocksdb::Options;
use tempfile::TempDir;

use abacus_core::db::DB;

pub fn setup_db(db_path: String) -> DB {
    let mut opts = Options::default();
    opts.create_if_missing(true);
    rocksdb::DB::open(&opts, db_path)
        .expect("Failed to open db path")
        .into()
}

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
    use ethers::types::H256;

    use abacus_core::{accumulator::merkle::Proof, db::AbacusDB, AbacusMessage, RawAbacusMessage};

    use super::*;

    #[tokio::test]
    async fn db_stores_and_retrieves_messages() {
        run_test_db(|db| async move {
            let outbox_name = "outbox_1".to_owned();
            let db = AbacusDB::new(outbox_name, db);

            let m = AbacusMessage {
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
            assert_eq!(by_id, RawAbacusMessage::from(&m));

            let by_nonce = db.message_by_nonce(m.nonce).unwrap().unwrap();
            assert_eq!(by_nonce, RawAbacusMessage::from(&m));
        })
        .await;
    }

    #[tokio::test]
    async fn db_stores_and_retrieves_proofs() {
        run_test_db(|db| async move {
            let outbox_name = "outbox_1".to_owned();
            let db = AbacusDB::new(outbox_name, db);

            let proof = Proof {
                leaf: H256::from_low_u64_be(15),
                index: 32,
                path: Default::default(),
            };
            db.store_proof(13, &proof).unwrap();

            let by_index = db.proof_by_nonce(13).unwrap().unwrap();
            assert_eq!(by_index, proof);
        })
        .await;
    }
}
