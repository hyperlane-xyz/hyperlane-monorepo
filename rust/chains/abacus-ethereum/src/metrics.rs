use std::fmt::Debug;
use crate::Address;

/// Metrics subscriber which allows recording metric events.
pub trait MetricsSubscriber: Debug + Send + Sync {
    /// Called when a new transaction has been dispatched.
    fn transaction_dispatched(&self, chain: &str, address: ethers::types::Address);
    /// Called once a transaction has been completed
    fn transaction_completed(&self, chain: &str, address: ethers::types::Address);
    /// Called if a transaction has failed
    fn transaction_failed(&self, chain: &str, address: ethers::types::Address);
}

/// Dummy metrics subscriber which just ignores metric events.
#[derive(Debug)]
pub struct DummyMetricsSubscriber;

impl MetricsSubscriber for DummyMetricsSubscriber {
    fn transaction_dispatched(&self, _chain: &str, _address: Address) {}
    fn transaction_completed(&self, _chain: &str, _address: Address) {}
    fn transaction_failed(&self, _chain: &str, _address: Address) {}
}
