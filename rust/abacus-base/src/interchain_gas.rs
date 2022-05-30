use abacus_core::db::AbacusDB;
use abacus_core::{AbacusContract, InterchainGasPaymaster};

use abacus_ethereum::EthereumInterchainGasPaymaster;
// use abacus_test::mocks::MockInterchainGasPaymasterContract;
use async_trait::async_trait;
use eyre::Result;
use futures_util::future::select_all;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;
use tracing::{info_span, Instrument};

use crate::{ContractSync, ContractSyncMetrics, IndexSettings, InterchainGasPaymasterIndexers};

/// Caching InterchainGasPaymaster type
#[derive(Debug)]
pub struct CachingInterchainGasPaymaster {
    paymaster: InterchainGasPaymasters,
    db: AbacusDB,
    indexer: Arc<InterchainGasPaymasterIndexers>,
}

impl std::fmt::Display for CachingInterchainGasPaymaster {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingInterchainGasPaymaster {
    /// Instantiate new CachingInterchainGasPaymaster
    pub fn new(
        paymaster: InterchainGasPaymasters,
        db: AbacusDB,
        indexer: Arc<InterchainGasPaymasterIndexers>,
    ) -> Self {
        Self {
            paymaster,
            db,
            indexer,
        }
    }

    /// Return handle on paymaster object
    pub fn paymaster(&self) -> InterchainGasPaymasters {
        self.paymaster.clone()
    }

    /// Return handle on AbacusDB
    pub fn db(&self) -> AbacusDB {
        self.db.clone()
    }

    /// Spawn a task that syncs the CachingInterchainGasPaymaster's db with the on-chain event
    /// data
    pub fn sync(
        &self,
        agent_name: String,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("InterchainGasPaymasterContractSync", self = %self);

        let sync = ContractSync::new(
            agent_name,
            "InterchainGasPaymaster".to_string(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings,
            metrics,
        );

        tokio::spawn(async move {
            let tasks = vec![sync.sync_gas_payments()];

            let (_, _, remaining) = select_all(tasks).await;
            for task in remaining.into_iter() {
                cancel_task!(task);
            }

            Ok(())
        })
        .instrument(span)
    }
}

#[derive(Debug, Clone)]
/// Arc wrapper for InterchainGasPaymasterVariants enum
pub struct InterchainGasPaymasters(Arc<InterchainGasPaymasterVariants>);

impl From<InterchainGasPaymasterVariants> for InterchainGasPaymasters {
    fn from(paymaster: InterchainGasPaymasterVariants) -> Self {
        Self(Arc::new(paymaster))
    }
}

impl std::ops::Deref for InterchainGasPaymasters {
    type Target = Arc<InterchainGasPaymasterVariants>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for InterchainGasPaymasters {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

/// InterchainGasPaymaster type
#[derive(Debug)]
pub enum InterchainGasPaymasterVariants {
    /// Ethereum InterchainGasPaymaster contract
    Ethereum(Box<dyn InterchainGasPaymaster>),
    /// Mock InterchainGasPaymaster contract - todo do I need to make a mock?
    Mock(Box<dyn InterchainGasPaymaster>),
    /// Other InterchainGasPaymaster variant
    Other(Box<dyn InterchainGasPaymaster>),
}

impl InterchainGasPaymasterVariants {}

impl<M> From<EthereumInterchainGasPaymaster<M>> for InterchainGasPaymasters
where
    M: ethers::providers::Middleware + 'static,
{
    fn from(paymaster: EthereumInterchainGasPaymaster<M>) -> Self {
        InterchainGasPaymasterVariants::Ethereum(Box::new(paymaster)).into()
    }
}

// impl From<MockInterchainGasPaymasterContract> for InterchainGasPaymasters {
//     fn from(mock_paymaster: MockInterchainGasPaymasterContract) -> Self {
//         InterchainGasPaymasterVariants::Mock(Box::new(mock_paymaster)).into()
//     }
// }

impl From<Box<dyn InterchainGasPaymaster>> for InterchainGasPaymasters {
    fn from(paymaster: Box<dyn InterchainGasPaymaster>) -> Self {
        InterchainGasPaymasterVariants::Other(paymaster).into()
    }
}

impl AbacusContract for InterchainGasPaymasterVariants {
    fn chain_name(&self) -> &str {
        match self {
            InterchainGasPaymasterVariants::Ethereum(paymaster) => paymaster.chain_name(),
            InterchainGasPaymasterVariants::Mock(paymaster) => paymaster.chain_name(),
            InterchainGasPaymasterVariants::Other(paymaster) => paymaster.chain_name(),
        }
    }
}

#[async_trait]
impl InterchainGasPaymaster for InterchainGasPaymasterVariants {}
