#![allow(dead_code, unused_imports, unused_variables)]

extern crate chrono;
extern crate ethers_core;
extern crate ethers_core as ethers;
extern crate hyperlane_core;
extern crate serde;
extern crate serde_json;
extern crate uuid;

#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => {{}};
}

#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => {{}};
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {{}};
}

#[macro_export]
macro_rules! warn {
    ($($arg:tt)*) => {{}};
}

mod tracing {
    pub use crate::{debug, error, info, warn};
}

#[derive(Debug)]
pub enum LanderError {
    NetworkError(String),
}

mod hyperlane_ethereum {
    use hyperlane_core::U256;

    #[derive(Debug, Default)]
    pub struct TransactionOverrides {
        pub gas_price_cap_multiplier: Option<U256>,
    }
}

mod payload {
    include!(concat!(env!("OUT_DIR"), "/payload_module.rs"));
    pub use self::types::*;
}

mod transaction {
    include!(concat!(env!("OUT_DIR"), "/transaction_module.rs"));
    pub use self::types::*;
}

mod adapter {
    pub use self::chains::EthereumTxPrecursor;

    pub mod chains {
        pub use self::ethereum::precursor::EthereumTxPrecursor;

        #[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
        pub struct RadixTxPrecursor;

        #[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
        pub struct SealevelTxPrecursor;

        pub mod tron {
            #[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
            pub struct TronTxPrecursor;
        }

        pub mod ethereum {
            pub mod gas_price {
                use hyperlane_core::U256;

                #[derive(Clone, Debug, PartialEq, Eq)]
                pub enum GasPrice {
                    None,
                    NonEip1559 {
                        gas_price: U256,
                    },
                    Eip1559 {
                        max_fee: U256,
                        max_priority_fee: U256,
                    },
                }
            }

            pub mod payload {
                use ethers::abi::Function;
                use ethers::types::transaction::eip2718::TypedTransaction;
                use payload::{FullPayload, PayloadDetails};

                pub fn parse_data(_payload: &FullPayload) -> (TypedTransaction, Function) {
                    unimplemented!()
                }

                pub fn parse_success_criteria(
                    _details: &PayloadDetails,
                ) -> Option<(TypedTransaction, Function)> {
                    unimplemented!()
                }
            }

            include!(concat!(env!("OUT_DIR"), "/precursor_module.rs"));

            pub mod adapter {
                pub mod gas_price {
                    include!(concat!(env!("OUT_DIR"), "/escalator_module.rs"));
                }
            }
        }
    }
}

use adapter::chains::ethereum::adapter::gas_price::escalator::escalate_gas_price_if_needed;
use adapter::chains::ethereum::gas_price::GasPrice;
use adapter::chains::EthereumTxPrecursor;
use chrono::{TimeZone, Utc};
use ethers::abi::Function;
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{Eip1559TransactionRequest, H160};
use ethers_core::types::U256 as EthersU256;
use ethers_core::utils::eip1559_default_estimator;
use hyperlane_core::{H256, H512, U256};
use hyperlane_ethereum::TransactionOverrides;
use payload::{FullPayload, PayloadUuid};
use serde_json::Value;
use transaction::{Transaction, TransactionStatus, VmSpecificTxData};
use uuid::Uuid;

fn overrides(multiplier: Option<U256>) -> TransactionOverrides {
    TransactionOverrides {
        gas_price_cap_multiplier: multiplier,
    }
}

fn check_non_eip1559(
    name: &str,
    old: U256,
    estimate: U256,
    multiplier: Option<U256>,
    expected: U256,
) {
    let result = escalate_gas_price_if_needed(
        &GasPrice::NonEip1559 { gas_price: old },
        &GasPrice::NonEip1559 {
            gas_price: estimate,
        },
        &overrides(multiplier),
    );
    assert_eq!(
        result,
        GasPrice::NonEip1559 {
            gas_price: expected
        }
    );
    println!("{name}: {result:?}");
}

fn run_escalator_vectors() {
    check_non_eip1559(
        "normal_100_to_50",
        U256::from(100),
        U256::from(50),
        None,
        U256::from(110),
    );
    check_non_eip1559(
        "cap_old_floor_1000_to_100",
        U256::from(1000),
        U256::from(100),
        None,
        U256::from(1000),
    );
    check_non_eip1559(
        "zero_estimate_100_to_0",
        U256::from(100),
        U256::zero(),
        None,
        U256::from(100),
    );
    check_non_eip1559("u256_max_saturation", U256::MAX, U256::MAX, None, U256::MAX);
    check_non_eip1559(
        "multiplier_zero_100_to_50",
        U256::from(100),
        U256::from(50),
        Some(U256::zero()),
        U256::from(100),
    );

    let eip1559_result = escalate_gas_price_if_needed(
        &GasPrice::Eip1559 {
            max_fee: U256::from(100),
            max_priority_fee: U256::from(10),
        },
        &GasPrice::Eip1559 {
            max_fee: U256::from(50),
            max_priority_fee: U256::from(5),
        },
        &overrides(None),
    );
    assert_eq!(
        eip1559_result,
        GasPrice::Eip1559 {
            max_fee: U256::from(110),
            max_priority_fee: U256::from(11),
        }
    );
    println!("eip1559_both_fields: {eip1559_result:?}");
    println!("all 6 production escalator vectors passed");
}

fn check_estimator(
    name: &str,
    base_fee: u64,
    rewards: Vec<Vec<u64>>,
    expected_max_fee: u64,
    expected_priority_fee: u64,
) {
    let rewards = rewards
        .into_iter()
        .map(|row| row.into_iter().map(EthersU256::from).collect())
        .collect();
    let result = eip1559_default_estimator(EthersU256::from(base_fee), rewards);
    assert_eq!(
        result,
        (
            EthersU256::from(expected_max_fee),
            EthersU256::from(expected_priority_fee),
        )
    );
    println!("{name}: max_fee={} priority_fee={}", result.0, result.1);
}

fn run_estimator_vectors() {
    check_estimator(
        "estimator_normal_base_surge_and_median",
        100_000_000_001,
        vec![
            vec![100_000_000_000],
            vec![105_000_000_000],
            vec![102_000_000_000],
        ],
        302_000_000_002,
        102_000_000_000,
    );
    check_estimator(
        "estimator_zero_floors",
        0,
        vec![vec![0], vec![0]],
        200_000,
        100_000,
    );
    check_estimator(
        "estimator_upper_half_outlier_median",
        1_000_000,
        vec![vec![100_000], vec![110_000], vec![120_000], vec![5_000_000]],
        4_560_000,
        2_560_000,
    );
    println!("all 3 pinned ethers_core estimator vectors passed");
}

fn assert_fields(value: &Value, expected: &[&str]) {
    let object = value.as_object().expect("expected JSON object");
    assert_eq!(object.len(), expected.len());
    for field in expected {
        assert!(object.contains_key(*field), "missing field {field}");
    }
}

#[derive(serde::Serialize)]
struct TypeFixture<'a> {
    full_payload: &'a FullPayload,
    transaction: &'a Transaction,
    transaction_statuses: Vec<TransactionStatus>,
}

fn generate_type_fixture() {
    let payload = FullPayload::new(
        PayloadUuid::new(Uuid::parse_str("00112233-4455-4677-8899-aabbccddeeff").unwrap()),
        "oracle-payload",
        vec![0xde, 0xad, 0xbe, 0xef],
        U256::from(250_000),
        Some(vec![0x01, 0x02]),
        H256::from_low_u64_be(0x1234),
    );

    let mut tx_request = Eip1559TransactionRequest::default();
    tx_request.from = Some(H160::from_low_u64_be(0xabcd));
    tx_request.to = Some(H160::from_low_u64_be(0x1234).into());
    tx_request.nonce = Some(EthersU256::from(7));
    tx_request.gas = Some(EthersU256::from(250_000));
    tx_request.value = Some(EthersU256::from(9));
    tx_request.max_fee_per_gas = Some(EthersU256::from(110));
    tx_request.max_priority_fee_per_gas = Some(EthersU256::from(11));

    let function = Function {
        name: "transfer".to_owned(),
        inputs: vec![],
        outputs: vec![],
        constant: None,
        state_mutability: ethers::abi::StateMutability::NonPayable,
    };
    let precursor = EthereumTxPrecursor::new(TypedTransaction::Eip1559(tx_request), function);
    let created = Utc.timestamp_opt(1_700_000_000, 0).single().unwrap();
    let transaction = Transaction {
        uuid: PayloadUuid::new(Uuid::parse_str("ffeeddcc-bbaa-4988-a766-554433221100").unwrap()),
        tx_hashes: vec![H512::from_slice(&[0x11; 64]), H512::from_slice(&[0x22; 64])],
        vm_specific_data: VmSpecificTxData::Evm(Box::new(precursor)),
        payload_details: vec![payload.details.clone()],
        status: TransactionStatus::Finalized,
        submission_attempts: 2,
        creation_timestamp: created,
        last_submission_attempt: Some(created + chrono::Duration::seconds(30)),
        last_status_check: None,
    };
    let statuses = vec![
        TransactionStatus::PendingInclusion,
        TransactionStatus::Mempool,
        TransactionStatus::Included,
        TransactionStatus::Finalized,
        TransactionStatus::Dropped(transaction::DropReason::DroppedByChain),
    ];

    let mut payload_json = serde_json::to_value(&payload).unwrap();
    assert_fields(
        &payload_json,
        &[
            "details",
            "data",
            "gas_limit",
            "to",
            "status",
            "value",
            "inclusion_soft_deadline",
        ],
    );
    assert_fields(
        &payload_json["details"],
        &["uuid", "metadata", "success_criteria"],
    );

    let transaction_json = serde_json::to_value(&transaction).unwrap();
    assert_fields(
        &transaction_json,
        &[
            "uuid",
            "tx_hashes",
            "vm_specific_data",
            "payload_details",
            "status",
            "submission_attempts",
            "creation_timestamp",
            "last_submission_attempt",
            "last_status_check",
        ],
    );
    let hashes = transaction_json["tx_hashes"].as_array().unwrap();
    assert_eq!(hashes.len(), 2);
    for hash in hashes {
        let hash = hash.as_str().unwrap();
        assert!(hash.starts_with("0x"));
        assert_eq!(hash.len(), 130);
    }
    assert_eq!(transaction_json["status"], "Finalized");
    assert_eq!(
        serde_json::to_value(&statuses).unwrap(),
        serde_json::json!([
            "PendingInclusion",
            "Mempool",
            "Included",
            "Finalized",
            { "Dropped": "DroppedByChain" }
        ])
    );

    let payload_roundtrip: FullPayload =
        serde_json::from_str(&serde_json::to_string(&payload).unwrap()).unwrap();
    assert_eq!(payload_roundtrip, payload);
    let transaction_roundtrip: Transaction =
        serde_json::from_str(&serde_json::to_string(&transaction).unwrap()).unwrap();
    assert_eq!(transaction_roundtrip, transaction);

    let payload_to = payload_json["to"].as_str().unwrap().to_owned();
    payload_json["to"] = serde_json::json!([payload_to[..34], payload_to[34..66]]);

    let mut transaction_json = transaction_json;
    let split_hashes: Vec<Value> = transaction_json["tx_hashes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|hash| {
            let hash = hash.as_str().unwrap();
            Value::Array(vec![
                Value::String(hash[..34].to_owned()),
                Value::String(hash[34..66].to_owned()),
                Value::String(hash[66..98].to_owned()),
                Value::String(hash[98..130].to_owned()),
            ])
        })
        .collect();
    transaction_json["tx_hashes"] = Value::Array(split_hashes);
    let fixture = serde_json::json!({
        "full_payload": payload_json,
        "transaction": transaction_json,
        "transaction_statuses": statuses,
    });
    // A golden check writes a candidate beside its preserved expected fixture,
    // without changing either the canonical gzip or the ignored raw mirror.
    let fixture_path = std::env::var_os("ZIGGY_LANDER_FIXTURE_OUTPUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/fixtures/lander_types.json"
            ))
        });
    if let Some(parent) = fixture_path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(
        &fixture_path,
        format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap()),
    )
    .unwrap();
    println!(
        "type_fixture: {}; FullPayload=7 fields Transaction=9 fields H512=2 statuses=5",
        fixture_path.display()
    );
    println!("production payload/transaction/precursor JSON round-trips passed");
}

fn main() {
    run_escalator_vectors();
    run_estimator_vectors();
    generate_type_fixture();
}
