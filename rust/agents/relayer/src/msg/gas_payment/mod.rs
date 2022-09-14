use abacus_core::{
    db::{AbacusDB, DbError},
    CommittedMessage, TxCostEstimate,
};
use async_trait::async_trait;
use ethers::types::U256;
use eyre::Result;

use crate::settings::GasPaymentEnforcementPolicy;

mod gelato;

#[async_trait]
pub trait GasPaymentEnforcer {
    /// Returns (gas payment requirement met, current payment according to the DB).
    async fn message_meets_gas_payment_requirement(
        &self,
        message: &CommittedMessage,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<(bool, U256)>;

    /// Returns the total gas payment made for a message.
    fn get_message_gas_payment(&self, msg_leaf_index: u32) -> Result<U256, DbError>;
}

#[derive(Debug)]
pub struct MonolithGasPaymentEnforcer {
    policy: GasPaymentEnforcementPolicy,
    db: AbacusDB,
}

impl MonolithGasPaymentEnforcer {
    pub fn new(policy: GasPaymentEnforcementPolicy, db: AbacusDB) -> Self {
        Self { policy, db }
    }
}

#[async_trait]
impl GasPaymentEnforcer for MonolithGasPaymentEnforcer {
    /// Returns (gas payment requirement met, current payment according to the DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        message: &CommittedMessage,
        _tx_cost_estimate: &TxCostEstimate,
    ) -> Result<(bool, U256)> {
        let current_payment = self.get_message_gas_payment(message.leaf_index)?;

        let meets_requirement = match self.policy {
            GasPaymentEnforcementPolicy::None => true,
            GasPaymentEnforcementPolicy::Minimum {
                payment: min_payment,
            } => current_payment >= min_payment,
        };

        Ok((meets_requirement, current_payment))
    }

    fn get_message_gas_payment(&self, msg_leaf_index: u32) -> Result<U256, DbError> {
        self.db.retrieve_gas_payment_for_leaf(msg_leaf_index)
    }
}
