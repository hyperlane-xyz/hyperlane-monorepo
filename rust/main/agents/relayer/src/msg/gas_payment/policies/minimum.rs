use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{
    HyperlaneMessage, InterchainGasExpenditure, InterchainGasPayment, TxCostEstimate, U256,
};

use crate::msg::gas_payment::GasPaymentPolicy;

/// Policy for checking the minimum gas payment.
#[derive(Debug, new)]
pub struct GasPaymentPolicyMinimum {
    /// The minimum payment required to perform an operation.
    minimum_payment: U256,
}

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyMinimum {
    /// Checks if the current gas payment meets the minimum requirements.
    ///
    /// # Arguments
    /// - `_message`: The message to be sent.
    /// - `current_payment`: The current gas payment.
    /// - `_current_expenditure`: The current gas expenditure.
    /// - `tx_cost_estimate`: The estimated transaction cost.
    ///
    /// # Returns
    /// - `Ok(Some(gas_limit))` if the payment is sufficient.
    /// - `Ok(None)` if the payment is insufficient.
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        _current_expenditure: &InterchainGasExpenditure,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        // Early return if the payment is zero
        if current_payment.payment.is_zero() {
            return Ok(None);
        }

        // Check if the payment meets the minimum requirement
        if current_payment.payment >= self.minimum_payment {
            Ok(Some(tx_cost_estimate.gas_limit))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::{HyperlaneMessage, H256};

    #[tokio::test]
    async fn test_gas_payment_policy_minimum() {
        let min = U256::from(1000u32);
        let policy = GasPaymentPolicyMinimum::new(min); // Using the automatically implemented new
        let message = HyperlaneMessage::default();

        // Test case: Payment is less than the minimum
        let current_payment = InterchainGasPayment {
            message_id: H256::zero(),
            destination: message.destination,
            payment: U256::from(999u32),
            gas_amount: U256::zero(),
        };
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment,
                    &InterchainGasExpenditure::default(),
                    &TxCostEstimate::default(),
                )
                .await
                .unwrap(),
            None
        );

        // Test case: Payment is equal to the minimum
        let current_payment = InterchainGasPayment {
            payment: U256::from(1000u32),
            ..current_payment
        };
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment,
                    &InterchainGasExpenditure::default(),
                    &TxCostEstimate {
                        gas_limit: U256::from(100000u32),
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
            Some(U256::from(100000u32))
        );

        // Test case: Payment is greater than the minimum
        let current_payment = InterchainGasPayment {
            payment: U256::from(1001u32),
            ..current_payment
        };
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment,
                    &InterchainGasExpenditure::default(),
                    &TxCostEstimate {
                        gas_limit: U256::from(100000u32),
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
            Some(U256::from(100000u32))
        );

        // Test case: Payment is zero
        let current_payment = InterchainGasPayment {
            payment: U256::zero(),
            ..current_payment
        };
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment,
                    &InterchainGasExpenditure::default(),
                    &TxCostEstimate::default(),
                )
                .await
                .unwrap(),
            None
        );

        // Test case: l2_gas_limit present but ignored
        let current_payment = InterchainGasPayment {
            payment: U256::from(1000u32),
            ..current_payment
        };
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment,
                    &InterchainGasExpenditure::default(),
                    &TxCostEstimate {
                        gas_limit: U256::from(100000u32),
                        l2_gas_limit: Some(U256::from(22222u32)),
                        ..Default::default()
                    },
                )
                .await
                .unwrap(),
            Some(U256::from(100000u32))
        );
    }
}
