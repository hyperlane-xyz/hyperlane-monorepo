use abacus_core::db::{AbacusDB, DbError};
use ethers::types::U256;

use crate::settings::GasPaymentEnforcementPolicy;

#[derive(Debug)]
pub struct GasPaymentEnforcer {
    policy: GasPaymentEnforcementPolicy,
    db: AbacusDB,
}

impl GasPaymentEnforcer {
    pub fn new(policy: GasPaymentEnforcementPolicy, db: AbacusDB) -> Self {
        Self { policy, db }
    }

    /// Returns (gas payment requirement met, current payment according to the DB)
    pub fn message_meets_gas_payment_requirement(
        &self,
        msg_leaf_index: u32,
    ) -> Result<(bool, U256), DbError> {
        let current_payment = self.get_message_gas_payment(msg_leaf_index)?;

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
