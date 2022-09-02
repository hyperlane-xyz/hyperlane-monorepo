use abacus_core::db::{AbacusDB, DbError};
use ethers::types::U256;

use crate::settings::GasPaymentEnforcementPolicy;

#[derive(Debug)]
pub struct GasPaymentEnforcer {
    policy: GasPaymentEnforcementPolicy,
    db: AbacusDB,
}

impl GasPaymentEnforcer {
    pub fn new(
        policy: GasPaymentEnforcementPolicy,
        db: AbacusDB,
    ) -> Self {
        Self {
            policy,
            db,
        }
    }

    pub fn message_meets_gas_payment_requirement(
        &self,
        msg_leaf_index: u32,
    ) -> Result<bool, DbError> {
        let meets_requirement = match self.policy {
            GasPaymentEnforcementPolicy::None => true,
            GasPaymentEnforcementPolicy::Minimum(min_payment) => {
                let payment = self.get_message_gas_payment(msg_leaf_index)?;

                payment >= min_payment
            }
        };

        Ok(meets_requirement)
    }

    // TODO: make this public and use it in submitters
    fn get_message_gas_payment(&self, msg_leaf_index: u32) -> Result<U256, DbError> {
        self.db.retrieve_gas_payment_for_leaf(msg_leaf_index)
    }
}
