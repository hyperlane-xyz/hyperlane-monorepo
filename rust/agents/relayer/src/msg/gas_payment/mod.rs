use abacus_core::{
    db::{AbacusDB, DbError},
    CommittedMessage, TxCostEstimate,
};
use async_trait::async_trait;
use ethers::types::U256;
use eyre::Result;

use crate::settings::GasPaymentEnforcementPolicy;

use self::policies::{
    GasPaymentPolicyMeetsEstimatedCost, GasPaymentPolicyMinimum, GasPaymentPolicyNone,
};

mod policies;

#[async_trait]
pub trait GasPaymentPolicy: std::fmt::Debug + Send + Sync {
    async fn message_meets_gas_payment_requirement(
        &self,
        message: &CommittedMessage,
        current_payment: &U256,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<bool>;
}

#[derive(Debug)]
pub struct GasPaymentEnforcer {
    policy: Box<dyn GasPaymentPolicy>,
    db: AbacusDB,
}

impl GasPaymentEnforcer {
    pub fn new(policy_config: GasPaymentEnforcementPolicy, db: AbacusDB) -> Self {
        let policy: Box<dyn GasPaymentPolicy> = match policy_config {
            GasPaymentEnforcementPolicy::None => Box::new(GasPaymentPolicyNone::new()),
            GasPaymentEnforcementPolicy::Minimum { payment } => {
                Box::new(GasPaymentPolicyMinimum::new(payment))
            }
            GasPaymentEnforcementPolicy::MeetsEstimatedCost { coingeckoapikey } => {
                Box::new(GasPaymentPolicyMeetsEstimatedCost::new(coingeckoapikey))
            }
        };

        Self { policy, db }
    }
}

impl GasPaymentEnforcer {
    /// Returns (gas payment requirement met, current payment according to the DB)
    pub async fn message_meets_gas_payment_requirement(
        &self,
        message: &CommittedMessage,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<(bool, U256)> {
        let current_payment = self.get_message_gas_payment(message.leaf_index)?;

        let meets_requirement = self
            .policy
            .message_meets_gas_payment_requirement(message, &current_payment, tx_cost_estimate)
            .await?;

        Ok((meets_requirement, current_payment))
    }

    fn get_message_gas_payment(&self, msg_leaf_index: u32) -> Result<U256, DbError> {
        self.db.retrieve_gas_payment_for_leaf(msg_leaf_index)
    }
}
