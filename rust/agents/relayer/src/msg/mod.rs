use std::cmp::Ordering;

use abacus_core::{accumulator::merkle::Proof, CommittedMessage, MultisigSignedCheckpoint};

use tokio::time::Instant;

pub mod gelato_submitter;
pub mod processor;
pub mod serial_submitter;

/// Processor scans DB for new messages and sends relevant messages
/// over a channel to a submitter, for delivery.
///
/// A submitter uses some strategy to try to deliver those messages
/// to the target blockchain.
///
/// A SubmitMessageOp describes the message that the submitter should
/// try to submit.
///
/// Right now there are two strategies: serial and Gelato.
///
/// In the future it could make sense for there to be more, some ideas are:
///   - BatchingMessagesSubmitter
///   - ShardedWalletSubmitter (to get parallelism / nonce)
///   - SpeculativeSerializedSubmitter (batches with higher optimistic
///     nonces, recovery behavior)
///   - FallbackProviderSubmitter (Serialized, but if some RPC provider sucks,
///   switch everyone to new one)

#[derive(Clone, Debug)]
pub struct SubmitMessageArgs {
    pub leaf_index: u32,
    pub committed_message: CommittedMessage,
    pub checkpoint: MultisigSignedCheckpoint,
    pub proof: Proof,
    pub enqueue_time: Instant,
    num_retries: u32,
}

impl SubmitMessageArgs {
    pub fn new(
        leaf_index: u32,
        committed_message: CommittedMessage,
        checkpoint: MultisigSignedCheckpoint,
        proof: Proof,
        enqueue_time: Instant,
    ) -> Self {
        SubmitMessageArgs {
            leaf_index,
            committed_message,
            checkpoint,
            proof,
            enqueue_time,
            num_retries: 0,
        }
    }
}

// The run_queue implementation is a max-heap.  We want the next op to
// be min over <num_retries, leaf_index>, so the total ordering is
// the reverse of the natural lexicographic ordering.
//
// TODO(webbhorn): It may be more natural to take a `Reversed` of the normal
// or implicit sort order of the `SubmitMessageArgs` struct. It also may be appropriate
// to either wrap in a Schedulable or impl a Schedulable trait.
impl Ord for SubmitMessageArgs {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.num_retries.cmp(&other.num_retries) {
            Ordering::Equal => match self.leaf_index.cmp(&other.leaf_index) {
                Ordering::Equal => Ordering::Equal,
                Ordering::Less => Ordering::Greater,
                Ordering::Greater => Ordering::Less,
            },
            Ordering::Less => Ordering::Greater,
            Ordering::Greater => Ordering::Less,
        }
    }
}

impl PartialOrd for SubmitMessageArgs {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for SubmitMessageArgs {
    fn eq(&self, other: &Self) -> bool {
        self.num_retries == other.num_retries && self.leaf_index == other.leaf_index
    }
}

impl Eq for SubmitMessageArgs {}

/// A GasPaymentOracle provides the interface that are needed to determine whether sufficient
/// gas has been paid for a relayer to process a message. There are currently two
/// implementations, one which consults the indexed InterchainGasPaymaster events via AbacusDB,
/// and one which is a test fake intended to be injected as a dependency where useful.
#[allow(dead_code)]
pub(crate) mod gas {
    use abacus_core::db::AbacusDB;
    use ethers::types::U256;
    use eyre::Result;

    #[cfg(test)]
    use std::collections::HashMap;

    pub(crate) type LeafIndex = u32;
    pub(crate) type Payment = U256;

    #[derive(Clone, Debug)]
    pub(crate) enum GasPaymentOracle {
        IndexedDB(crate::msg::gas::AbacusDBGasOracle),
        #[cfg(test)]
        Test(TestOracle),
    }

    impl GasPaymentOracle {
        pub(crate) fn get_total_payment(&self, index: LeafIndex) -> Result<Payment> {
            match self {
                GasPaymentOracle::IndexedDB(o) => o.get_total_payment(index),
                #[cfg(test)]
                GasPaymentOracle::Test(o) => o.get_total_payment(index),
            }
        }
    }

    #[derive(Clone, Debug)]
    pub(crate) struct AbacusDBGasOracle {
        db: AbacusDB,
    }

    impl AbacusDBGasOracle {
        pub(crate) fn new(db: AbacusDB) -> Self {
            Self { db }
        }
        pub(crate) fn get_total_payment(&self, leaf_index: LeafIndex) -> Result<Payment> {
            Ok(self.db.retrieve_gas_payment_for_leaf(leaf_index)?)
        }
    }

    #[cfg(test)]
    #[derive(Clone, Debug)]
    pub(crate) struct TestOracle {
        payments: HashMap<LeafIndex, Payment>,
    }

    #[cfg(test)]
    impl TestOracle {
        pub(crate) fn new() -> Self {
            Self {
                payments: HashMap::new(),
            }
        }
        pub(crate) fn get_total_payment(&self, leaf_index: LeafIndex) -> Result<Payment> {
            let balance = self.payments.get(&leaf_index);
            Ok(match balance {
                Some(balance) => balance.clone(),
                None => U256::zero(),
            })
        }
        pub(crate) fn set_payment(&mut self, leaf_index: LeafIndex, payment: Payment) {
            self.payments.insert(leaf_index, payment);
        }
    }
}

/////////////////////////////////////////////////////////////
/////////  ProcessingStatus  ////////////////////////////////
/////////////////////////////////////////////////////////////

#[allow(dead_code)]
pub(crate) mod status {
    use std::sync::Arc;

    use abacus_base::CachingInbox;
    use abacus_core::{CommittedMessage, Inbox, MessageStatus};
    use eyre::Result;

    #[derive(Clone, Debug)]
    pub(crate) enum ProcessedStatusOracle {
        InboxContract(InboxContractStatus),
        #[cfg(test)]
        TestAlwaysNone,
    }

    impl ProcessedStatusOracle {
        pub(crate) async fn message_status(&self, msg: &CommittedMessage) -> Result<MessageStatus> {
            match self {
                ProcessedStatusOracle::InboxContract(o) => o.message_status(msg).await,
                #[cfg(test)]
                ProcessedStatusOracle::TestAlwaysNone => Ok(MessageStatus::None),
            }
        }
    }

    #[derive(Clone, Debug)]
    pub(crate) struct InboxContractStatus {
        inbox: Arc<CachingInbox>,
    }

    impl InboxContractStatus {
        pub(crate) fn new(inbox: Arc<CachingInbox>) -> Self {
            Self { inbox }
        }
        pub(crate) async fn message_status(&self, msg: &CommittedMessage) -> Result<MessageStatus> {
            Ok(self.inbox.message_status(msg.to_leaf()).await?)
        }
    }
}
