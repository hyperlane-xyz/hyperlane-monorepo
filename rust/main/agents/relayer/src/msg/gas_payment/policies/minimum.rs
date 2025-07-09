use async_trait::async_trait;
use derive_new::new;
use eyre::Result;

use hyperlane_core::{
    HyperlaneMessage, InterchainGasExpenditure, InterchainGasPayment, TxCostEstimate, U256,
};

use crate::msg::gas_payment::GasPaymentPolicy;

#[derive(Debug, new)]
pub struct GasPaymentPolicyMinimum {
    minimum_payment: U256,
}

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyMinimum {
    /// `Minimum` requires a payment to exist on the IGP specified in the config,
    /// even if the payment is zero. For example, a policy of Minimum { payment: 0 }
    /// will only relay messages that send a zero payment to the IGP specified in the config.
    /// This is different from not requiring message senders to make any payment at all to
    /// the configured IGP to get relayed. To relay regardless of the existence of a payment,
    /// the `None` IGP policy should be used.

    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        _current_expenditure: &InterchainGasExpenditure,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        if current_payment.payment >= self.minimum_payment {
            Ok(Some(tx_cost_estimate.gas_limit))
        } else {
            Ok(None)
        }
    }

    fn requires_payment_found(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn test_gas_payment_policy_minimum() {
    use hyperlane_core::{HyperlaneMessage, H256};

    let min = U256::from(1000u32);
    let policy = GasPaymentPolicyMinimum::new(min);
    let message = HyperlaneMessage::default();

    // If the payment is less than the minimum, returns false
    let current_payment = InterchainGasPayment {
        message_id: H256::zero(),
        destination: message.destination,
        payment: U256::from(999u32),
        gas_amount: U256::zero(),
    };
    // expenditure should make no difference
    let current_expenditure = InterchainGasExpenditure {
        message_id: H256::zero(),
        gas_used: U256::from(1000000000u32),
        tokens_used: U256::from(1000000000u32),
    };
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment,
                &current_expenditure,
                &TxCostEstimate {
                    gas_limit: U256::from(100000u32),
                    gas_price: U256::from(100000u32).try_into().unwrap(),
                    l2_gas_limit: None,
                },
            )
            .await
            .unwrap(),
        None
    );

    // If the payment is at least the minimum, returns false
    let current_payment = InterchainGasPayment {
        message_id: H256::zero(),
        destination: message.destination,
        payment: U256::from(1000u32),
        gas_amount: U256::zero(),
    };
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment,
                &current_expenditure,
                &TxCostEstimate {
                    gas_limit: U256::from(100000u32),
                    gas_price: U256::from(100001u32).try_into().unwrap(),
                    l2_gas_limit: None,
                },
            )
            .await
            .unwrap(),
        Some(U256::from(100000u32))
    );

    // Ensure that even if the l2_gas_limit isn't None, the gas_limit is what's returned
    assert_eq!(
        policy
            .message_meets_gas_payment_requirement(
                &message,
                &current_payment,
                &current_expenditure,
                &TxCostEstimate {
                    gas_limit: U256::from(100000u32),
                    gas_price: U256::from(100001u32).try_into().unwrap(),
                    l2_gas_limit: Some(U256::from(22222u32)),
                },
            )
            .await
            .unwrap(),
        Some(U256::from(100000u32))
    );
}
