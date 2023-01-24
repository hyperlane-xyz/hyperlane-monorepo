use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{HyperlaneMessage, InterchainGasPayment, TxCostEstimate, U256};

use crate::msg::gas_payment::GasPaymentPolicy;

#[derive(Debug)]
pub struct GasPaymentPolicyOnChainFeeQuoting;

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyOnChainFeeQuoting {
    /// Returns (gas payment requirement met, current payment according to the
    /// DB)
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        let half_gas_estimate = tx_cost_estimate.gas_limit >> 1;
        if current_payment.gas_amount >= half_gas_estimate {
            Ok(Some(current_payment.gas_amount))
        } else {
            Ok(None)
        }
    }
}

#[tokio::test]
async fn test_gas_payment_policy_on_chain_fee_quoting() {
    use hyperlane_core::{HyperlaneMessage, H256};

    let min = U256::from(1000u32);
    let policy = GasPaymentPolicyOnChainFeeQuoting;
    let message = HyperlaneMessage::default();

    let cost_estimate = TxCostEstimate {
        gas_limit: min * 2,
        gas_price: U256::from(100001u32),
    };

    let current_payment = |gas_amount| InterchainGasPayment {
        message_id: H256::zero(),
        payment: U256::zero(),
        gas_amount,
    };

    // If the payment is less than the minimum, returns None
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment(min - 1),
                &cost_estimate,
            )
            .await
            .unwrap(),
        None
    );

    // If the payment is at least the minimum, returns the correct gas amount to use
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(&message, &current_payment(min), &cost_estimate,)
            .await
            .unwrap(),
        Some(min)
    );

    // Uses the full paid gas amount when it is sufficient
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment(min * 2 + 300),
                &cost_estimate,
            )
            .await
            .unwrap(),
        Some(min * 2 + 300)
    );
}
