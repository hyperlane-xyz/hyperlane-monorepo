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
    let db_tmp_dir = TempDir::new().expect("Failed to create tempdir");
    let db = setup_db(
        db_tmp_dir
            .path()
            .to_str()
            .expect("Failed to create db")
            .into(),
    );
    test(db).await;
    let _ = rocksdb::DB::destroy(&Options::default(), db_tmp_dir);
}

#[cfg(test)]
mod test {
    use hyperlane_core::{
        GasPaymentKey, GasPaymentTokenKey, HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage,
        Indexed, InterchainGasPayment, LogMeta, RawHyperlaneMessage, H160, H256, H512, U256,
    };

    use crate::db::{HyperlaneDb, HyperlaneRocksDB, InterchainGasPaymentData};

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
                version: 3,
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
                transaction_id: H512::from_low_u64_be(1),
                transaction_index: 0,
                log_index: U256::from(0),
            };

            db.store_logs(&vec![(Indexed::new(m.clone()), meta)])
                .await
                .unwrap();

            let by_nonce = db.retrieve_message_by_nonce(m.nonce).unwrap().unwrap();
            assert_eq!(
                RawHyperlaneMessage::from(&by_nonce),
                RawHyperlaneMessage::from(&m)
            );
        })
        .await;
    }

    #[tokio::test]
    async fn db_stores_and_retrieves_dispatched_tx_hash() {
        run_test_db(|db| async move {
            let db = HyperlaneRocksDB::new(
                &HyperlaneDomain::new_test_domain("db_stores_and_retrieves_dispatched_tx_hash"),
                db,
            );

            let m = HyperlaneMessage {
                nonce: 42,
                version: 3,
                origin: 10,
                sender: H256::from_low_u64_be(4),
                destination: 12,
                recipient: H256::from_low_u64_be(5),
                body: vec![],
            };
            let tx_hash = H512::from_low_u64_be(0xdeadbeef);
            let meta = LogMeta {
                address: H256::from_low_u64_be(1),
                block_number: 1,
                block_hash: H256::from_low_u64_be(1),
                transaction_id: tx_hash,
                transaction_index: 0,
                log_index: U256::from(0),
            };

            db.store_logs(&vec![(Indexed::new(m.clone()), meta)])
                .await
                .unwrap();

            let retrieved = db
                .retrieve_dispatched_tx_hash_by_message_id(&m.id())
                .unwrap()
                .unwrap();
            assert_eq!(retrieved, tx_hash);
        })
        .await;
    }

    #[tokio::test]
    async fn db_native_token_key_reads_legacy_total_after_new_native_payment() {
        run_test_db(|db| async move {
            let db = HyperlaneRocksDB::new(
                &HyperlaneDomain::new_test_domain(
                    "db_native_token_key_reads_legacy_total_after_new_native_payment",
                ),
                db,
            );
            let message_id = H256::random();
            let destination = 123;
            let gas_payment_key = GasPaymentKey {
                message_id,
                destination,
            };

            db.store_interchain_gas_payment_data_by_gas_payment_key(
                &gas_payment_key,
                &InterchainGasPaymentData {
                    payment: U256::from(7),
                    gas_amount: U256::from(8),
                },
            )
            .unwrap();

            db.process_gas_payment(
                InterchainGasPayment {
                    message_id,
                    destination,
                    fee_token: H160::zero(),
                    payment: U256::from(3),
                    gas_amount: U256::from(4),
                },
                &LogMeta::random(),
            )
            .unwrap();

            let token_payment = db
                .retrieve_gas_payment_by_gas_payment_token_key(GasPaymentTokenKey {
                    message_id,
                    destination,
                    fee_token: H160::zero(),
                })
                .unwrap()
                .unwrap();

            assert_eq!(token_payment.payment, U256::from(10));
            assert_eq!(token_payment.gas_amount, U256::from(12));
        })
        .await;
    }
}
