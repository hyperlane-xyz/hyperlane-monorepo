use std::{
    cmp::Ordering,
    fmt::{Debug, Formatter},
    rc::Rc,
};

use ethers::types::Log;
use hyperlane_core::{H160, H256};

use super::MailboxLogType;

/// Dispatch and Process logs have different topic orders; this map is used to abstract that away.
pub struct LogItemMap {
    pub event_type: MailboxLogType,
    pub sender_topic_idx: usize,
    pub recipient_topic_idx: usize,
    pub domain_topic_idx: usize,
}

impl LogItemMap {
    /// Create a new map for the given log type.
    pub fn new(log_type: MailboxLogType) -> Self {
        // TODO: Only need two of these (or per), and just return the correct one (in Rc or Arc).
        Self {
            event_type: log_type,
            sender_topic_idx: match log_type {
                MailboxLogType::Dispatch => 1,
                MailboxLogType::Process => 2,
            },
            domain_topic_idx: match log_type {
                MailboxLogType::Dispatch => 2,
                MailboxLogType::Process => 1,
            },
            recipient_topic_idx: 3,
        }
    }
}

pub struct MailboxLogItem<'a> {
    pub log: &'a Log,
    pub map: Rc<LogItemMap>,
}

impl MailboxLogItem<'_> {
    pub fn event_type(&self) -> MailboxLogType {
        self.map.event_type
    }

    pub fn sender(&self) -> H160 {
        self.log.topics[self.map.sender_topic_idx].into()
    }

    pub fn recipient(&self) -> H160 {
        self.log.topics[self.map.recipient_topic_idx].into()
    }

    pub fn destination_domain(&self) -> u64 {
        self.log.topics[self.map.domain_topic_idx].to_low_u64_be()
    }

    pub fn block_number(&self) -> Option<u64> {
        self.log.block_number.map(|index| index.as_u64())
    }

    pub fn transaction_hash(&self) -> Option<H256> {
        self.log.transaction_hash
    }

    pub fn log_index(&self) -> Option<u64> {
        self.log.log_index.map(|index| index.as_u64())
    }

    pub fn data(&self) -> &[u8] {
        &self.log.data
    }
}

/// Log items are tested for equality based on transaction hash; seperate items with the same transaction hash are considered equal.
impl PartialEq for MailboxLogItem<'_> {
    fn eq(&self, other: &Self) -> bool {
        // Transaction hash uniquely identifies a transaction.
        self.transaction_hash() == other.transaction_hash()
    }
}

/// Partially order as transactions by block number, then by log index, and they by transaction hash.
///
/// This sorts transactions according to their order in the blockchain.
///
/// Order transactions with no block number after those with a block number.
impl PartialOrd for MailboxLogItem<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        // Sort
        let mut cmp = partial_cmp_some_lt_none(&self.block_number(), &other.block_number());

        if cmp == Some(Ordering::Equal) {
            // If None neither have a block so do not to compare on log index.
            cmp = partial_cmp_some_lt_none(&self.log_index(), &other.log_index());
        }

        if cmp == Some(Ordering::Equal) || cmp.is_none() {
            // Do not expect transaction hash to ever be None, but still a safe and correct comparison.
            partial_cmp_some_lt_none(&self.transaction_hash(), &other.transaction_hash())
        } else {
            cmp
        }
    }

    fn lt(&self, other: &Self) -> bool {
        matches!(self.partial_cmp(other), Some(Ordering::Less))
    }

    fn le(&self, other: &Self) -> bool {
        matches!(
            self.partial_cmp(other),
            Some(Ordering::Less | Ordering::Equal)
        )
    }

    fn gt(&self, other: &Self) -> bool {
        matches!(self.partial_cmp(other), Some(Ordering::Greater))
    }

    fn ge(&self, other: &Self) -> bool {
        matches!(
            self.partial_cmp(other),
            Some(Ordering::Greater | Ordering::Equal)
        )
    }
}

/// Treat any `Some(_)` as coming before, so being less than, `None`.
///
/// This is used to sort transactions with no block number after transactions with a block number.
fn partial_cmp_some_lt_none<T: Ord>(a: &Option<T>, b: &Option<T>) -> Option<Ordering> {
    match a {
        Some(a) => match b {
            Some(b) => Some(a.cmp(b)),
            None => Some(Ordering::Greater),
        },
        None => b.as_ref().map(|_| Ordering::Less),
    }
}

impl Debug for MailboxLogItem<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailboxLogItem")
            .field("sender", &self.sender())
            .field("recipient", &self.recipient())
            .field("destination_domain", &self.destination_domain())
            .field("block_number", &self.block_number())
            .field("transaction_hash", &self.transaction_hash())
            .field("log_index", &self.log_index())
            .field("data", &self.data())
            .finish()
    }
}
