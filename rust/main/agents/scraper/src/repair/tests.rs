use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use ethers::{
    providers::{MockProvider, Provider, ProviderError},
    types::{transaction::eip2718::TypedTransaction, Block, BlockId, Bytes, TxHash},
};
use migration::MigratorTrait;
use sea_orm::Database;
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::*;

#[derive(Clone, Debug)]
struct GenericChain {
    domain: hyperlane_core::HyperlaneDomain,
    fail_reads: bool,
}

impl hyperlane_core::HyperlaneChain for GenericChain {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for GenericChain {
    async fn get_block_by_height(
        &self,
        height: u64,
    ) -> hyperlane_core::ChainResult<hyperlane_core::BlockInfo> {
        if self.fail_reads {
            return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                "transport failure",
            ));
        }
        if matches!(height, 8 | 12) {
            return Err(
                hyperlane_core::HyperlaneProviderError::CouldNotFindBlockByHeight(height).into(),
            );
        }
        Ok(hyperlane_core::BlockInfo {
            number: height,
            timestamp: 1000,
            hash: hyperlane_core::H256::repeat_byte(if height == 5 { 5 } else { 9 }),
        })
    }
    fn is_block_unavailable(&self, error: &hyperlane_core::ChainCommunicationError) -> bool {
        // Test providers positively distinguish a deleted block from transport errors.
        error
            .to_string()
            .contains("Could not find block from provider")
    }
    async fn get_chain_metrics(
        &self,
    ) -> hyperlane_core::ChainResult<Option<hyperlane_core::ChainInfo>> {
        Ok(Some(hyperlane_core::ChainInfo::new(12, None)))
    }
    async fn get_txn_by_hash(
        &self,
        _: &hyperlane_core::H512,
    ) -> hyperlane_core::ChainResult<hyperlane_core::TxnInfo> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "unused test RPC",
        ))
    }
    async fn is_contract(&self, _: &hyperlane_core::H256) -> hyperlane_core::ChainResult<bool> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "unused test RPC",
        ))
    }
    async fn get_balance(&self, _: String) -> hyperlane_core::ChainResult<hyperlane_core::U256> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "unused test RPC",
        ))
    }
}

const ALT_PROTOCOLS: [HyperlaneDomainProtocol; 7] = [
    HyperlaneDomainProtocol::Sealevel,
    HyperlaneDomainProtocol::Cosmos,
    HyperlaneDomainProtocol::CosmosNative,
    HyperlaneDomainProtocol::Starknet,
    HyperlaneDomainProtocol::Radix,
    HyperlaneDomainProtocol::Aleo,
    HyperlaneDomainProtocol::Tron,
];

fn generic_source(protocol: HyperlaneDomainProtocol, fail_reads: bool) -> ProtocolSource {
    ProtocolSource {
        provider: Box::new(GenericChain {
            domain: hyperlane_core::HyperlaneDomain::Unknown {
                domain_id: 1,
                domain_name: "repair-test".into(),
                domain_type: hyperlane_core::HyperlaneDomainType::LocalTestChain,
                domain_protocol: protocol,
                domain_technical_stack: hyperlane_core::HyperlaneDomainTechnicalStack::Other,
            },
            fail_reads,
        }),
        contracts: [1, 2, 3]
            .map(|byte| hyperlane_core::H256::from(hyperlane_core::H160::repeat_byte(byte))),
    }
}

#[tokio::test]
async fn generic_repair_reads_skip_only_proven_unavailable_blocks() -> Result<()> {
    for protocol in ALT_PROTOCOLS {
        let source = generic_source(protocol, false);
        assert_eq!(source.protocol(), protocol);
        assert_eq!(source.latest(10).await?.height, 11);
        assert!(source.latest(0).await.is_err());
        assert_eq!(source.header(Some(8)).await?, None);
        assert!(required_header(&source, Some(8)).await.is_err());
        assert!(generic_source(protocol, true).latest(10).await.is_err());
        let head = serde_json::json!({
            "mailbox": format!("\\x{}", "01".repeat(20)),
            "merkle_tree_hook": format!("\\x{}", "02".repeat(20)),
            "interchain_gas_paymaster": format!("\\x{}", "03".repeat(20)),
        });
        source.verify_domain(&head, 1, H256::zero()).await?;
        assert!(source.verify_domain(&head, 2, H256::zero()).await.is_err());
        let mut wrong_contract = head.clone();
        wrong_contract["mailbox"] = Value::String(format!("\\x{}", "04".repeat(32)));
        assert!(source
            .verify_domain(&wrong_contract, 1, H256::zero())
            .await
            .is_err());
    }
    Ok(())
}

#[tokio::test]
async fn every_vm_repairs_the_same_atomic_history() -> Result<()> {
    for protocol in ALT_PROTOCOLS {
        let postgres = Postgres::default().with_tag("16-alpine").start().await?;
        let db = Database::connect(format!(
            "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
            postgres.get_host_port_ipv4(5432).await?
        ))
        .await?;
        seed(&db).await?;
        // Use full-width contract addresses as stored by AltVM scrapers.
        db.execute_unprepared("UPDATE scraper_head SET mailbox=decode(repeat('00',12)||repeat('01',20),'hex'), merkle_tree_hook=decode(repeat('00',12)||repeat('02',20),'hex'), interchain_gas_paymaster=decode(repeat('00',12)||repeat('03',20),'hex')").await?;
        let source = generic_source(protocol, false);
        let plan = inspect(&db, &source, 1, 10, 1000).await?;
        assert_eq!(plan.protocol, protocol);
        assert_eq!(plan.chain_id, None);
        assert_eq!(plan.ancestor.height, 5);
        let serialized = serde_json::to_vec(&plan)?;
        let plan: Plan = serde_json::from_slice(&serialized)?;
        let other_protocol = if protocol == HyperlaneDomainProtocol::Tron {
            HyperlaneDomainProtocol::Cosmos
        } else {
            HyperlaneDomainProtocol::Tron
        };
        assert!(verify_chain(&generic_source(other_protocol, false), &plan)
            .await
            .is_err());
        let archive = path("generic-success");
        apply(
            &db,
            &source,
            &plan,
            &archive,
            &["repair_test_writer".into()],
            "incident/test",
        )
        .await?;
        assert_eq!(scalar(&db, "SELECT count(*) AS n FROM scraper_head WHERE domain=1 AND indexed_height=5 AND confirmed_height=5 AND NOT halted").await?, 1);
        assert_eq!(
            scalar(
                &db,
                "SELECT count(*) AS n FROM raw_message_dispatch WHERE origin_domain=1"
            )
            .await?,
            0
        );
        assert_eq!(
            scalar(
                &db,
                "SELECT last_cursor AS n FROM gas_payment_stream_head WHERE domain=1"
            )
            .await?,
            1
        );
        assert_eq!(
            scalar(&db, "SELECT count(*) AS n FROM gas_payment WHERE domain=2").await?,
            1
        );
        std::fs::remove_file(archive)?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct Chain {
    inner: Provider<MockProvider>,
    changed: Arc<AtomicBool>,
}

impl Chain {
    fn new() -> Self {
        Self {
            inner: Provider::mocked().0,
            changed: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[async_trait]
impl Middleware for Chain {
    type Error = ProviderError;
    type Provider = MockProvider;
    type Inner = Provider<MockProvider>;

    fn inner(&self) -> &Self::Inner {
        &self.inner
    }

    async fn get_chainid(&self) -> std::result::Result<U256, Self::Error> {
        Ok(1.into())
    }

    async fn get_block<T: Into<BlockId> + Send + Sync>(
        &self,
        id: T,
    ) -> std::result::Result<Option<Block<TxHash>>, Self::Error> {
        let height = match id.into() {
            BlockId::Number(BlockNumber::Number(n)) => n.as_u64(),
            BlockId::Number(BlockNumber::Latest) => 12,
            BlockId::Hash(_) => return Ok(None),
            _ => return Err(ProviderError::CustomError("unsupported block query".into())),
        };
        let hash = if height == 5 && !self.changed.load(Ordering::SeqCst) {
            H256::repeat_byte(5)
        } else {
            H256::repeat_byte(9)
        };
        Ok(Some(Block {
            number: Some(height.into()),
            hash: Some(hash),
            timestamp: 1000.into(),
            ..Default::default()
        }))
    }

    async fn call(
        &self,
        _: &TypedTransaction,
        _: Option<BlockId>,
    ) -> std::result::Result<Bytes, Self::Error> {
        Ok(ethers::abi::encode(&[ethers::abi::Token::Uint(1.into())]).into())
    }
}

#[derive(Debug, Clone)]
struct ForkChain {
    inner: Provider<MockProvider>,
}

impl ForkChain {
    fn new() -> Self {
        Self {
            inner: Provider::mocked().0,
        }
    }

    fn canonical_hash(height: u64) -> H256 {
        if height == 5 {
            H256::repeat_byte(5)
        } else {
            H256::from_low_u64_be(height + 100)
        }
    }
}

#[async_trait]
impl Middleware for ForkChain {
    type Error = ProviderError;
    type Provider = MockProvider;
    type Inner = Provider<MockProvider>;

    fn inner(&self) -> &Self::Inner {
        &self.inner
    }

    async fn get_chainid(&self) -> std::result::Result<U256, Self::Error> {
        Ok(1.into())
    }

    async fn get_block<T: Into<BlockId> + Send + Sync>(
        &self,
        id: T,
    ) -> std::result::Result<Option<Block<TxHash>>, Self::Error> {
        let (height, hash, parent_hash) = match id.into() {
            BlockId::Number(BlockNumber::Number(number)) => {
                let height = number.as_u64();
                (
                    height,
                    Self::canonical_hash(height),
                    Self::canonical_hash(height.saturating_sub(1)),
                )
            }
            BlockId::Number(BlockNumber::Latest) => {
                (12, Self::canonical_hash(12), Self::canonical_hash(11))
            }
            BlockId::Hash(hash) => {
                let byte = hash.as_bytes()[0];
                if hash != H256::repeat_byte(byte) || !(5..=10).contains(&byte) {
                    return Ok(None);
                }
                let height = u64::from(byte);
                (height, hash, H256::repeat_byte(byte.saturating_sub(1)))
            }
            _ => return Err(ProviderError::CustomError("unsupported block query".into())),
        };
        Ok(Some(Block {
            number: Some(height.into()),
            hash: Some(hash),
            parent_hash,
            timestamp: 1000.into(),
            ..Default::default()
        }))
    }

    async fn call(
        &self,
        _: &TypedTransaction,
        _: Option<BlockId>,
    ) -> std::result::Result<Bytes, Self::Error> {
        Ok(ethers::abi::encode(&[ethers::abi::Token::Uint(1.into())]).into())
    }
}

fn path(label: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "scraper-repair-{label}-{}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ))
}

async fn seed(db: &DatabaseConnection) -> Result<()> {
    migration::Migrator::up(db, None).await?;
    db.execute_unprepared(include_str!("fixture.sql")).await?;
    Ok(())
}

async fn scalar(db: &DatabaseConnection, query: &str) -> Result<i64> {
    Ok(db
        .query_one(sql(query, vec![]))
        .await?
        .unwrap()
        .try_get("", "n")?)
}

#[tokio::test]
async fn repair_rewinds_all_streams_and_dependencies_without_reusing_cursors() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    seed(&db).await?;
    let chain = Chain::new();
    let plan = inspect(&db, &chain, 1, 10, 1000).await?;
    let mut legacy_json = serde_json::to_value(&plan)?;
    legacy_json["version"] = Value::from(1);
    legacy_json.as_object_mut().unwrap().remove("protocol");
    let legacy: Plan = serde_json::from_value(legacy_json)?;
    assert_eq!(legacy.protocol, HyperlaneDomainProtocol::Ethereum);
    verify_chain(&chain, &legacy).await?;
    assert_eq!(plan.ancestor.height, 5);
    assert_eq!(plan.affected["message"].rows, 2); // Dispatch enrichment + CCR.
    assert_eq!(plan.affected["delivered_message"].rows, 2);
    assert_eq!(plan.affected["gas_payment"].rows, 1);
    assert_eq!(plan.affected["gas_payment_stream_cursor"].rows, 1);
    assert_eq!(scalar(&db, "SELECT count(*) AS n FROM block").await?, 3); // Inspect is read-only.
    assert!(inspect(&db, &chain, 1, 2, 1000)
        .await
        .unwrap_err()
        .to_string()
        .contains("No retained canonical ancestor"));
    assert!(inspect(&db, &chain, 1, 10, 1)
        .await
        .unwrap_err()
        .to_string()
        .contains("max-rows"));

    let roles = vec!["repair_test_writer".to_owned()];
    let archive = path("success");
    // A changed enriched row invalidates the plan even without progress changes.
    db.execute_unprepared("UPDATE gas_payment SET payment=payment+1 WHERE domain=1")
        .await?;
    assert!(apply(&db, &chain, &plan, &archive, &roles, "incident/test")
        .await
        .unwrap_err()
        .to_string()
        .contains("Affected rows changed"));
    assert!(!archive.exists());
    db.execute_unprepared("UPDATE gas_payment SET payment=payment-1 WHERE domain=1")
        .await?;
    chain.changed.store(true, Ordering::SeqCst);
    assert!(apply(&db, &chain, &plan, &archive, &roles, "incident/test")
        .await
        .unwrap_err()
        .to_string()
        .contains("ancestor changed"));
    chain.changed.store(false, Ordering::SeqCst);

    // Any live lease, including another domain, blocks a shared-database repair.
    db.execute_unprepared(
        "UPDATE scraper_head SET writer_lease_until=clock_timestamp()+interval '1 minute'",
    )
    .await?;
    assert!(apply(&db, &chain, &plan, &archive, &roles, "incident/test")
        .await
        .unwrap_err()
        .to_string()
        .contains("Live scraper leases"));
    db.execute_unprepared("UPDATE scraper_head SET writer_lease_until=NULL")
        .await?;

    // Fail late, after earlier deletes: the transaction must restore all history.
    db.execute_unprepared("CREATE FUNCTION reject_repair() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected repair failure'; END $$; CREATE TRIGGER reject_repair BEFORE DELETE ON block FOR EACH ROW EXECUTE FUNCTION reject_repair()").await?;
    let failed_archive = path("failed");
    assert!(
        apply(&db, &chain, &plan, &failed_archive, &roles, "incident/test")
            .await
            .unwrap_err()
            .to_string()
            .contains("injected repair failure")
    );
    assert!(failed_archive.exists());
    assert_eq!(
        snapshot(&db, 1, 5, 1000)
            .await
            .map(|r| inventory(&r).unwrap())?,
        plan.affected
    );
    assert_eq!(head(&db, 1).await?, plan.head);
    db.execute_unprepared("DROP TRIGGER reject_repair ON block; DROP FUNCTION reject_repair()")
        .await?;
    assert!(
        apply(&db, &chain, &plan, &failed_archive, &roles, "incident/test")
            .await
            .is_err()
    ); // Never overwrite evidence.

    apply(&db, &chain, &plan, &archive, &roles, "incident/test").await?;
    assert_eq!(
        scalar(&db, "SELECT count(*) AS n FROM message WHERE origin=1").await?,
        0
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS n FROM delivered_message WHERE domain=1"
        )
        .await?,
        0
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS n FROM raw_message_dispatch WHERE origin_domain=1"
        )
        .await?,
        0
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS n FROM merkle_tree_insertion WHERE domain=1"
        )
        .await?,
        0
    );
    assert_eq!(scalar(&db, "SELECT count(*) AS n FROM \"transaction\" t JOIN block b ON t.block_id=b.id WHERE b.domain=1").await?, 0);
    assert_eq!(
        scalar(&db, "SELECT count(*) AS n FROM gas_payment WHERE domain=2").await?,
        1
    ); // Unrelated chain preserved.
    assert_eq!(
        scalar(
            &db,
            "SELECT last_cursor AS n FROM gas_payment_stream_head WHERE domain=1"
        )
        .await?,
        1
    );
    assert_eq!(
        scalar(&db, "SELECT height AS n FROM cursor WHERE domain=1").await?,
        5
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS n FROM scraper_checkpoint WHERE domain=1 AND height=5"
        )
        .await?,
        1
    );
    assert_eq!(scalar(&db, "SELECT count(*) AS n FROM scraper_head WHERE domain=1 AND indexed_height=5 AND confirmed_height=5 AND head_height=5 AND NOT healthy AND NOT halted AND writer_id IS NULL").await?, 1);
    let archived: Value = serde_json::from_reader(std::fs::File::open(&archive)?)?;
    assert!(archived["rows_before"]["gas_payment"][0]
        .as_str()
        .unwrap()
        .contains("123456789012345678901234567890123456789"));
    assert!(
        apply(&db, &chain, &plan, &path("repeat"), &roles, "incident/test")
            .await
            .is_err()
    );

    // Replay allocates a fresh cursor above the deleted occurrence's cursor.
    db.execute_unprepared("INSERT INTO gas_payment(domain,origin,destination,msg_id,payment,gas_amount,log_index,interchain_gas_paymaster,block_number) VALUES(1,1,2,decode(repeat('aa',32),'hex'),1,1,0,decode(repeat('03',20),'hex'),6); SELECT assign_confirmed_gas_payment_cursors(1,5,6)").await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT stream_cursor AS n FROM gas_payment_stream_cursor WHERE domain=1"
        )
        .await?,
        2
    );
    std::fs::remove_file(archive)?;
    std::fs::remove_file(failed_archive)?;
    Ok(())
}

#[tokio::test]
async fn repair_inserts_an_ancestor_traced_from_orphaned_checkpoints() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    seed(&db).await?;
    db.execute_unprepared(
        "DELETE FROM block WHERE domain=1 AND height=5;
         UPDATE scraper_checkpoint SET hash=decode(repeat('0a',32),'hex') WHERE domain=1 AND height=10",
    )
    .await?;

    let chain = ForkChain::new();
    let plan = inspect(&db, &chain, 1, 10, 1000).await?;
    assert_eq!(plan.version, 3);
    assert_eq!(plan.ancestor.height, 5);
    assert_eq!(plan.ancestor.hash, H256::repeat_byte(5));
    assert!(plan.insert_ancestor);

    let archive = path("traced-ancestor");
    apply(
        &db,
        &chain,
        &plan,
        &archive,
        &["repair_test_writer".into()],
        "incident/test",
    )
    .await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS n FROM scraper_checkpoint WHERE domain=1 AND height=5 AND hash=decode(repeat('05',32),'hex')"
        )
        .await?,
        1
    );
    std::fs::remove_file(archive)?;
    Ok(())
}

#[tokio::test]
async fn repair_refuses_connected_writers_and_unknown_provenance() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    seed(&db).await?;
    let chain = Chain::new();
    let plan = inspect(&db, &chain, 1, 10, 1000).await?;
    let writer = Database::connect(format!(
        "postgresql://repair_test_writer:test@127.0.0.1:{port}/postgres"
    ))
    .await?;
    let archive = path("blocked");
    assert!(apply(
        &db,
        &chain,
        &plan,
        &archive,
        &["repair_test_writer".into()],
        "incident/test"
    )
    .await
    .unwrap_err()
    .to_string()
    .contains("Writer connections"));
    assert!(!archive.exists());
    writer.close().await?;
    db.execute_unprepared("INSERT INTO delivered_message(msg_id,domain,destination_mailbox) VALUES(decode(repeat('ef',32),'hex'),1,decode(repeat('01',20),'hex'))").await?;
    assert!(inspect(&db, &chain, 1, 10, 1000)
        .await
        .unwrap_err()
        .to_string()
        .contains("provenance audit"));
    Ok(())
}
