use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{HyperlaneMessage, InterchainGasPayment, TxCostEstimate, U256};

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
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        if current_payment.payment >= self.minimum_payment {
            Ok(Some(tx_cost_estimate.gas_limit))
        } else {
            Ok(None)
        }
    }
}

#[tokio::test]
async fn test_gas_payment_policy_none() {
    use hyperlane_core::{HyperlaneMessage, H256};

    let min = U256::from(1000u32);
    let policy = GasPaymentPolicyMinimum::new(min);
    let message = HyperlaneMessage::default();

    // If the payment is less than the minimum, returns false
    let current_payment = InterchainGasPayment {
        message_id: H256::zero(),
        payment: U256::from(999u32),
        gas_amount: U256::zero(),
    };
    assert!(!policy
        .message_meets_gas_payment_requirement(
            &message,
            &current_payment,
            &TxCostEstimate {
                gas_limit: U256::from(100000u32),
                gas_price: U256::from(100000u32),
            },
        )
        .await
        .unwrap(),);

    // If the payment is at least the minimum, returns false
    let current_payment = InterchainGasPayment {
        message_id: H256::zero(),
        payment: U256::from(1000u32),
        gas_amount: U256::zero(),
    };
    assert!(policy
        .message_meets_gas_payment_requirement(
            &message,
            &current_payment,
            &TxCostEstimate {
                gas_limit: U256::from(100000u32),
                gas_price: U256::from(100000u32),
            },
        )
        .await
        .unwrap());
}
