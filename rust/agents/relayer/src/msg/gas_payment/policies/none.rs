use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{HyperlaneMessage, TxCostEstimate, U256};

use crate::msg::gas_payment::GasPaymentPolicy;

#[derive(Debug)]
pub struct GasPaymentPolicyNone {}

impl GasPaymentPolicyNone {
    pub fn new() -> Self {
        Self {}
    }
}

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyNone {
    /// Returns (gas payment requirement met, current payment according to the DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        _current_payment: &U256,
        _tx_cost_estimate: &TxCostEstimate,
    ) -> Result<bool> {
        Ok(true)
    }
}

#[tokio::test]
async fn test_gas_payment_policy_none() {
    use hyperlane_core::HyperlaneMessage;

    let policy = GasPaymentPolicyNone::new();

    let message = HyperlaneMessage::default();

    // Always returns true
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &U256::zero(),
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
