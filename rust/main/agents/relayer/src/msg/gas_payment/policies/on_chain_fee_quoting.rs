use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{
    HyperlaneMessage, InterchainGasExpenditure, InterchainGasPayment, TxCostEstimate, U256,
};

use crate::msg::gas_payment::GasPaymentPolicy;

#[derive(Debug)]
pub struct GasPaymentPolicyOnChainFeeQuoting {
    /// Numerator value to modify the estimated gas by. The estimated gas value
    /// is multiplied by this value.
    fractional_numerator: u64,
    /// Denominator value to modify the estimated gas by. The estimated gas
    /// value is divided by this value.
    fractional_denominator: u64,
}

impl GasPaymentPolicyOnChainFeeQuoting {
    pub fn new(fractional_numerator: u64, fractional_denominator: u64) -> Self {
        Self {
            fractional_numerator,
            fractional_denominator,
        }
    }
}

impl Default for GasPaymentPolicyOnChainFeeQuoting {
    fn default() -> Self {
        // default to requiring they have paid 1/2 the estimated gas.
        Self {
            fractional_numerator: 1,
            fractional_denominator: 2,
        }
    }
}

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyOnChainFeeQuoting {
    /// OnChainFeeQuoting requires the user to pay a specified fraction of the
    /// estimated gas. Like the Minimum policy, OnChainFeeQuoting requires a
    /// payment to exist on the IGP specified in the config.

    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        current_expenditure: &InterchainGasExpenditure,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        let fractional_gas_estimate = (tx_cost_estimate.enforceable_gas_limit()
            * self.fractional_numerator)
            / self.fractional_denominator;
        let gas_amount = current_payment
            .gas_amount
            .saturating_sub(current_expenditure.gas_used);
        // We might want to migrate later to a solution which is a little more
        // sophisticated. See https://github.com/hyperlane-xyz/hyperlane-monorepo/pull/1658#discussion_r1093243358
        if gas_amount >= fractional_gas_estimate {
            Ok(Some(tx_cost_estimate.gas_limit.max(gas_amount)))
        } else {
            Ok(None)
        }
    }

    fn requires_payment_found(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod test {
    use hyperlane_core::H256;
    use once_cell::sync::Lazy;

    use super::*;

    fn current_payment(gas_amount: impl Into<U256>) -> InterchainGasPayment {
        InterchainGasPayment {
            message_id: H256::zero(),
            destination: 0,
            payment: U256::zero(),
            gas_amount: gas_amount.into(),
        }
    }

    fn current_expenditure(gas_used: impl Into<U256>) -> InterchainGasExpenditure {
        InterchainGasExpenditure {
            message_id: H256::zero(),
            gas_used: gas_used.into(),
            tokens_used: U256::zero(),
        }
    }

    const MIN: U256 = U256([1000, 0, 0, 0]);
    static COST_ESTIMATE: Lazy<TxCostEstimate> = Lazy::new(|| TxCostEstimate {
        gas_limit: U256([2000, 0, 0, 0]), // MIN * 2
        gas_price: U256([100001, 0, 0, 0]).try_into().unwrap(),
        l2_gas_limit: None,
    });

    #[test]
    fn ensure_little_endian() {
        assert_eq!(MIN, U256::from(1000u32));
    }

    #[tokio::test]
    async fn test_payment_less_than_min() {
        let policy = GasPaymentPolicyOnChainFeeQuoting::default();
        let message = HyperlaneMessage::default();

        // If the payment is less than the minimum, returns None
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment(MIN - 1),
                    &current_expenditure(0),
                    &COST_ESTIMATE,
                )
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn test_payment_at_least_min() {
        let policy = GasPaymentPolicyOnChainFeeQuoting::default();
        let message = HyperlaneMessage::default();

        // If the payment is at least the minimum, returns the correct gas amount to use
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment(MIN),
                    &current_expenditure(0),
                    &COST_ESTIMATE,
                )
                .await
                .unwrap(),
            Some(COST_ESTIMATE.gas_limit)
        );
    }

    #[tokio::test]
    async fn test_uses_full_paid_amount() {
        let policy = GasPaymentPolicyOnChainFeeQuoting::default();
        let message = HyperlaneMessage::default();

        // Uses the full paid gas amount when it is sufficient
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment(MIN * 2 + 300),
                    &current_expenditure(0),
                    &COST_ESTIMATE,
                )
                .await
                .unwrap(),
            Some(MIN * 2 + 300)
        );
    }

    #[tokio::test]
    async fn test_accounts_for_expenditure() {
        let policy = GasPaymentPolicyOnChainFeeQuoting::default();
        let message = HyperlaneMessage::default();

        // Accounts for gas that has already been spent
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment(MIN + 300),
                    &current_expenditure(301),
                    &COST_ESTIMATE
                )
                .await
                .unwrap(),
            None
        )
    }

    #[tokio::test]
    async fn test_accounts_for_expenditure_when_giving_full_amount() {
        let policy = GasPaymentPolicyOnChainFeeQuoting::default();
        let message = HyperlaneMessage::default();

        // Accounts for gas that has already been spent
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment(MIN * 2 + 300),
                    &current_expenditure(50),
                    &COST_ESTIMATE
                )
                .await
                .unwrap(),
            Some(MIN * 2 + 250)
        )
    }

    #[tokio::test]
    async fn test_l2_gas_amount() {
        let policy = GasPaymentPolicyOnChainFeeQuoting::default();
        let message = HyperlaneMessage::default();

        let tx_cost_estimate = TxCostEstimate {
            gas_limit: MIN * 100, // Large gas limit
            gas_price: COST_ESTIMATE.gas_price.clone(),
            l2_gas_limit: Some(MIN * 2),
        };

        // First ensure that if l2_gas_limit is None, because of the high gas limit,
        // we return None
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment(MIN),
                    &current_expenditure(0),
                    &TxCostEstimate {
                        l2_gas_limit: None,
                        ..tx_cost_estimate.clone()
                    }
                )
                .await
                .unwrap(),
            None
        );
        // And now when l2_gas_limit is Some, expect Some(tx_cost_estimate.gas_limit)
        assert_eq!(
            policy
                .message_meets_gas_payment_requirement(
                    &message,
                    &current_payment(MIN),
                    &current_expenditure(0),
                    &tx_cost_estimate,
                )
                .await
                .unwrap(),
            Some(tx_cost_estimate.gas_limit),
        );
    }
}
