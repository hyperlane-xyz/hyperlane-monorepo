use async_trait::async_trait;
use derive_new::new;
use eyre::Result;

use hyperlane_core::{
    HyperlaneMessage, InterchainGasExpenditure, InterchainGasPayment, TxCostEstimate, U256,
};

use crate::{msg::gas_payment::GasPaymentPolicy, settings::GasPaymentEnforcementPolicy};

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
    /// Approved messages preserve the unspent paid-gas budget as a floor.
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        current_expenditure: &InterchainGasExpenditure,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        if current_payment.payment >= self.minimum_payment {
            let gas_amount = current_payment
                .gas_amount
                .saturating_sub(current_expenditure.gas_used);
            Ok(Some(tx_cost_estimate.gas_limit.max(gas_amount)))
        } else {
            Ok(None)
        }
    }

    fn requires_payment_found(&self) -> bool {
        true
    }

    fn enforcement_type(&self) -> GasPaymentEnforcementPolicy {
        GasPaymentEnforcementPolicy::Minimum {
            payment: self.minimum_payment,
        }
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
    // Overspent budgets still allow subsidized delivery using the estimate.
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

    // If the payment is at least the minimum, returns the estimated gas limit
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

#[tokio::test]
async fn test_gas_payment_policy_minimum_preserves_unspent_paid_gas() {
    use hyperlane_core::{HyperlaneMessage, H256};

    let policy = GasPaymentPolicyMinimum::new(U256::from(1));
    let message = HyperlaneMessage::default();

    for (paid_gas, spent_gas, estimated_gas, expected_gas) in [
        // Aero destination-swap incidents: the cheaper fallback underestimates gas.
        (1_011_344u64, 0u64, 682_095u64, 1_011_344u64),
        (927_213, 0, 678_916, 927_213),
        // Only the unspent portion of the paid budget is preserved.
        (1_011_344, 100_000, 682_095, 911_344),
        // Subsidized messages still receive at least the full transaction estimate.
        (100_000, 0, 682_095, 682_095),
        (100_000, 100_001, 682_095, 682_095),
    ] {
        let current_payment = InterchainGasPayment {
            message_id: H256::zero(),
            destination: message.destination,
            payment: U256::from(1),
            gas_amount: U256::from(paid_gas),
        };
        let current_expenditure = InterchainGasExpenditure {
            message_id: H256::zero(),
            gas_used: U256::from(spent_gas),
            tokens_used: U256::zero(),
        };
        let estimate = TxCostEstimate {
            gas_limit: U256::from(estimated_gas),
            gas_price: U256::from(1).try_into().expect("valid gas price"),
            l2_gas_limit: Some(U256::from(1)),
        };

        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment,
                    &current_expenditure,
                    &estimate,
                )
                .await
                .expect("minimum payment policy evaluation succeeds"),
            Some(U256::from(expected_gas)),
            "paid={paid_gas}, spent={spent_gas}, estimate={estimated_gas}",
        );
    }
}
