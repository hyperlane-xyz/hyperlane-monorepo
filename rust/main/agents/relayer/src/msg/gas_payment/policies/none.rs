use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{
    HyperlaneMessage, InterchainGasExpenditure, InterchainGasPayment, TxCostEstimate, U256,
};

use crate::{msg::gas_payment::GasPaymentPolicy, settings::GasPaymentEnforcementPolicy};

#[derive(Debug)]
pub struct GasPaymentPolicyNone;

#[async_trait]
impl GasPaymentPolicy for GasPaymentPolicyNone {
    async fn message_meets_gas_payment_requirement(
        &self,
        _message: &HyperlaneMessage,
        _current_payment: &InterchainGasPayment,
        _current_expenditure: &InterchainGasExpenditure,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        Ok(Some(tx_cost_estimate.gas_limit))
    }

    fn enforcement_type(&self) -> GasPaymentEnforcementPolicy {
        GasPaymentEnforcementPolicy::None
    }
}

#[tokio::test]
async fn test_gas_payment_policy_none() {
    use hyperlane_core::{HyperlaneMessage, H256, U256};

    let policy = GasPaymentPolicyNone;

    let message = HyperlaneMessage::default();

    let current_payment = InterchainGasPayment {
        message_id: H256::zero(),
        destination: message.destination,
        payment: U256::zero(),
        gas_amount: U256::zero(),
    };
    let current_expenditure = InterchainGasExpenditure {
        message_id: H256::zero(),
        tokens_used: U256::zero(),
        gas_used: U256::zero(),
    };

    // Always returns true
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

    // Ensure that even if the l2_gas_limit is Some, we return the gas_limit
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
