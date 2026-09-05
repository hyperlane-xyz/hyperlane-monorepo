use std::sync::Mutex;

use migration::MigratorTrait;
use sea_orm::Database;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use hyperlane_core::{
    ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomainProtocol,
    HyperlaneDomainTechnicalStack, HyperlaneDomainType, TxnInfo, U256,
};

use super::*;

#[derive(Clone, Debug)]
struct BlockProvider {
    domain: HyperlaneDomain,
    calls: Arc<Mutex<Vec<u64>>>,
}

impl HyperlaneChain for BlockProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for BlockProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        self.calls.lock().unwrap().push(height);
        let hash = match height {
            3 => H256::from_low_u64_be(20),
            4 => {
                return Err(ChainCommunicationError::from_other_str(
                    "missing provider block",
                ))
            }
            // A provider returning a different hash must not invent a DB id for
            // the requested hash when insertion readback cannot find it.
            5 => H256::from_low_u64_be(99),
            1_000..=1_050 => H256::from_low_u64_be(height),
            _ => panic!("unexpected provider lookup at height {height}"),
        };
        Ok(BlockInfo {
            hash,
            number: height,
            timestamp: 1_700_000_000,
        })
    }
    async fn get_txn_by_hash(&self, _: &H512) -> ChainResult<TxnInfo> {
        panic!("unexpected transaction lookup")
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

#[tokio::test]
async fn block_enrichment_preserves_duplicate_heights_known_rows_and_failed_readbacks(
) -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let domain = HyperlaneDomain::Unknown {
        domain_id: 13375,
        domain_name: "sealeveltest1".to_owned(),
        domain_type: HyperlaneDomainType::LocalTestChain,
        domain_protocol: HyperlaneDomainProtocol::Sealevel,
        domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
    };
    let calls = Arc::new(Mutex::new(Vec::new()));
    let store = HyperlaneDbStore::new(
        db,
        domain.clone(),
        CoreContractAddresses::default(),
        Arc::new(BlockProvider {
            domain,
            calls: calls.clone(),
        }),
        &IndexSettings::default(),
        None,
    )
    .await?;
    let known_hash = H256::from_low_u64_be(10);
    store
        .db
        .store_blocks(
            13375,
            [BlockInfo {
                hash: known_hash,
                number: 10,
                timestamp: 1_700_000_000,
            }]
            .into_iter(),
        )
        .await?;
    let input = [
        BlockId::new(known_hash, 999),
        BlockId::new(H256::from_low_u64_be(20), 2),
        BlockId::new(H256::from_low_u64_be(30), 4),
        BlockId::new(H256::from_low_u64_be(40), 5),
        BlockId::new(H256::from_low_u64_be(20), 3),
    ];
    let found: HashMap<_, _> = store
        .ensure_blocks(input.into_iter())
        .await?
        .map(|block| (block.hash, block.id))
        .collect();
    assert_eq!(found.len(), 2);
    assert!(found[&known_hash] > 0);
    assert!(found[&H256::from_low_u64_be(20)] > 0);
    let mut actual_calls = calls.lock().unwrap().clone();
    actual_calls.sort_unstable();
    assert_eq!(actual_calls, vec![3, 4, 5]);
    let replay = [
        BlockId::new(known_hash, 999),
        BlockId::new(H256::from_low_u64_be(20), 888),
    ];
    assert_eq!(store.ensure_blocks(replay.into_iter()).await?.count(), 2);
    assert_eq!(store.ensure_blocks(std::iter::empty()).await?.count(), 0);
    assert_eq!(
        calls.lock().unwrap().len(),
        3,
        "known and empty batches must not query the provider"
    );
    let across_chunks =
        (1_000..=1_050).map(|height| BlockId::new(H256::from_low_u64_be(height), height));
    let blocks: Vec<_> = store.ensure_blocks(across_chunks).await?.collect();
    assert_eq!(blocks.len(), 51);
    assert!(blocks.iter().all(|block| block.id > 0));
    assert_eq!(calls.lock().unwrap().len(), 54);
    Ok(())
}
