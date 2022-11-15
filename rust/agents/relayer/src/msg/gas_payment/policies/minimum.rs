use hyperlane_core::{HyperlaneMessage, TxCostEstimate};
use async_trait::async_trait;
use ethers::types::U256;
use eyre::Result;

use crate::msg::gas_payment::GasPaymentPolicy;

#[derive(Debug)]
pub struct GasPaymentPolicyMinimum {
    minimum_payment: U256,
}

impl GasPaymentPolicyMinimum {
    pub fn new(minimum_payment: U256) -> Self {
        Self { minimum_payment }
    }
}

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyMinimum {
    /// Returns (gas payment requirement met, current payment according to the DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        current_payment: &U256,
        _tx_cost_estimate: &TxCostEstimate,
    ) -> Result<bool> {
        Ok(*current_payment >= self.minimum_payment)
    }
}

#[tokio::test]
async fn test_gas_payment_policy_none() {
    use hyperlane_core::HyperlaneMessage;

    let min = U256::from(1000u32);

    let policy = GasPaymentPolicyMinimum::new(min);

    let message = HyperlaneMessage::default();

    // If the payment is less than the minimum, returns false
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &U256::from(999u32),
                &TxCostEstimate {
                    gas_limit: U256::from(100000u32),
                    gas_price: U256::from(100000u32),
                },
            )
            .await
            .unwrap(),
        false,
    );

    // If the payment is at least the minimum, returns false
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &U256::from(1000u32),
                &TxCostEstimate {
                    gas_limit: U256::from(100000u32),
                    gas_price: U256::from(100000u32),
                },
            )
            .await
            .unwrap(),
        true,
    );
}
