use std::fmt::Debug;

use async_trait::async_trait;
use eyre::Result;

use crate::msg::gas_payment::policies::GasPaymentPolicyOnChainFeeQuoting;
use hyperlane_core::{
    db::{DbError, HyperlaneDB},
    HyperlaneMessage, InterchainGasPayment, TxCostEstimate, H256, U256,
};

use crate::settings::GasPaymentEnforcementPolicy;

use self::policies::{
    GasPaymentPolicyMeetsEstimatedCost, GasPaymentPolicyMinimum, GasPaymentPolicyNone,
};

mod policies;

#[async_trait]
pub trait GasPaymentPolicy: Debug + Send + Sync {
    /// Returns Some(gas_limit) if the policy has approved the transaction or
    /// None if the transaction is not approved.
    async fn message_meets_gas_payment_requirement(
        &self,
        message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>>;
}

#[derive(Debug)]
pub struct GasPaymentEnforcer {
    policy: Box<dyn GasPaymentPolicy>,
    db: HyperlaneDB,
}

impl GasPaymentEnforcer {
    pub fn new(policy_config: GasPaymentEnforcementPolicy, db: HyperlaneDB) -> Self {
        let policy: Box<dyn GasPaymentPolicy> = match policy_config {
            GasPaymentEnforcementPolicy::None => Box::new(GasPaymentPolicyNone::new()),
            GasPaymentEnforcementPolicy::Minimum { payment } => {
                Box::new(GasPaymentPolicyMinimum::new(payment))
            }
            GasPaymentEnforcementPolicy::MeetsEstimatedCost { coingeckoapikey } => {
                Box::new(GasPaymentPolicyMeetsEstimatedCost::new(coingeckoapikey))
            }
            GasPaymentEnforcementPolicy::OnChainFeeQuoting => {
                Box::new(GasPaymentPolicyOnChainFeeQuoting)
            }
        };

        Self { policy, db }
    }
}

impl GasPaymentEnforcer {
    /// Returns Some(gas_limit) if the enforcer has approved the transaction or
    /// None if the transaction is not approved.
    pub async fn message_meets_gas_payment_requirement(
        &self,
        message: &HyperlaneMessage,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        let current_payment = self.get_message_gas_payment(message.id())?;
        self.policy
            .message_meets_gas_payment_requirement(message, &current_payment, tx_cost_estimate)
            .await
    }

    fn get_message_gas_payment(&self, msg_id: H256) -> Result<InterchainGasPayment, DbError> {
        self.db.retrieve_gas_payment_for_message_id(msg_id)
    }
}
