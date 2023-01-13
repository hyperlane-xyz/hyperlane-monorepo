use async_trait::async_trait;
use eyre::Result;
use std::collections::HashMap;
use std::sync::Arc;

use hyperlane_core::{
    HyperlaneDomain, HyperlaneMessage, InterchainGasPayment, Mailbox, TxCostEstimate, U256,
};

use crate::msg::gas_payment::GasPaymentPolicy;

#[derive(Debug)]
pub struct GasPaymentPolicyOnChainFeeQuoting {
    // /// mailboxes by their domain id
    // mailboxes: HashMap<u32, Arc<dyn Mailbox>>,
}

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
        // TODO: ensure tx_cost_estimate is not generated if it is not needed.
        let half_gas_estimate = tx_cost_estimate.gas_limit >> 1;
        if current_payment.gas_amount >= half_gas_estimate {
            Ok(Some(current_payment.gas_amount))
        } else {
            Ok(None)
        }
    }
}

// #[tokio::test]
// async fn test_gas_payment_policy_none() {
//     use hyperlane_core::{HyperlaneMessage, H256};
//
//     let min = U256::from(1000u32);
//     let policy = GasPaymentPolicyOnChainFeeQuoting::new(min);
//     let message = HyperlaneMessage::default();
//
//     // If the payment is less than the minimum, returns false
//     let current_payment = InterchainGasPayment {
//         message_id: H256::zero(),
//         payment: U256::from(999u32),
//         gas_amount: U256::zero(),
//     };
//     assert!(!policy
//         .message_meets_gas_payment_requirement(
//             &message,
//             &current_payment,
//             &TxCostEstimate {
//                 gas_limit: U256::from(100000u32),
//                 gas_price: U256::from(100000u32),
//             },
//         )
//         .await
//         .unwrap(),);
//
//     // If the payment is at least the minimum, returns false
//     let current_payment = InterchainGasPayment {
//         message_id: H256::zero(),
//         payment: U256::from(1000u32),
//         gas_amount: U256::zero(),
//     };
//     assert!(policy
//         .message_meets_gas_payment_requirement(
//             &message,
//             &current_payment,
//             &TxCostEstimate {
//                 gas_limit: U256::from(100000u32),
//                 gas_price: U256::from(100000u32),
//             },
//         )
//         .await
//         .unwrap());
// }
