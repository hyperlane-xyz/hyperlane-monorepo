use abacus_core::db::AbacusDB;
use ethers::types::U256;
use eyre::Result;

#[cfg(test)]
use std::collections::HashMap;

pub(crate) type LeafIndex = u32;
pub(crate) type Payment = U256;

#[derive(Clone, Debug)]
pub(crate) enum GasPaymentOracle {
    Production(Impl),
    #[allow(dead_code)]
    #[cfg(test)]
    TestDouble(TestImpl),
}

impl GasPaymentOracle {
    pub(crate) fn get_total_payment(&self, index: LeafIndex) -> Result<Payment> {
        match self {
            GasPaymentOracle::Production(o) => o.get_total_payment(index),
            #[cfg(test)]
            GasPaymentOracle::TestDouble(o) => o.get_total_payment(index),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Impl {
    db: AbacusDB,
}

impl Impl {
    pub(crate) fn new(db: AbacusDB) -> Self {
        Self { db }
    }
    pub(crate) fn get_total_payment(&self, leaf_index: LeafIndex) -> Result<Payment> {
        Ok(self.db.retrieve_gas_payment_for_leaf(leaf_index)?)
    }
}

#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) struct TestImpl {
    payments: HashMap<LeafIndex, Payment>,
}

#[allow(dead_code)]
#[cfg(test)]
impl TestImpl {
    pub(crate) fn new() -> Self {
        Self {
            payments: HashMap::new(),
        }
    }
    pub(crate) fn get_total_payment(&self, leaf_index: LeafIndex) -> Result<Payment> {
        let balance = self.payments.get(&leaf_index);
        Ok(match balance {
            Some(balance) => balance.clone(),
            None => Payment::zero(),
        })
    }
    pub(crate) fn set_payment(&mut self, leaf_index: LeafIndex, payment: Payment) {
        self.payments.insert(leaf_index, payment);
    }
}
