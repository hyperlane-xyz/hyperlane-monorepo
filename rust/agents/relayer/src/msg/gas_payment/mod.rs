use std::fmt::Debug;

use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{
    db::{DbError, HyperlaneDB},
    HyperlaneMessage, TxCostEstimate, H256, U256,
};

use crate::settings::{matching_list::MatchingList, GasPaymentEnforcementPolicy};

use self::policies::{
    GasPaymentPolicyMinimum, GasPaymentPolicyNone,
};

mod policies;

#[async_trait]
pub trait GasPaymentPolicy: Debug + Send + Sync {
    async fn message_meets_gas_payment_requirement(
        &self,
        message: &HyperlaneMessage,
        current_payment: &U256,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<bool>;
}

#[derive(Debug)]
pub struct GasPaymentEnforcer {
    policy: Box<dyn GasPaymentPolicy>,
    /// A whitelist, where any matching message is considered
    /// as having met the gas payment requirement, even if it doesn't
    /// satisfy the policy.
    whitelist: MatchingList,
    db: HyperlaneDB,
}

impl GasPaymentEnforcer {
    pub fn new(
        policy_config: GasPaymentEnforcementPolicy,
        whitelist: MatchingList,
        db: HyperlaneDB,
    ) -> Self {
        let policy: Box<dyn GasPaymentPolicy> = match policy_config {
            GasPaymentEnforcementPolicy::None => Box::new(GasPaymentPolicyNone),
            GasPaymentEnforcementPolicy::Minimum { payment } => {
                Box::new(GasPaymentPolicyMinimum::new(payment))
            }
        };

        Self {
            policy,
            whitelist,
            db,
        }
    }
}

impl GasPaymentEnforcer {
    /// Returns (gas payment requirement met, current payment according to the DB)
    pub async fn message_meets_gas_payment_requirement(
        &self,
        message: &HyperlaneMessage,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<(bool, U256)> {
        let current_payment = self.get_message_gas_payment(message.id())?;

        // If the message matches the whitelist, consider it as meeting the gas payment requirement
        if self.whitelist.msg_matches(message, false) {
            return Ok((true, current_payment));
        }

        let meets_requirement = self
            .policy
            .message_meets_gas_payment_requirement(message, &current_payment, tx_cost_estimate)
            .await?;

        Ok((meets_requirement, current_payment))
    }

    fn get_message_gas_payment(&self, msg_id: H256) -> Result<U256, DbError> {
        self.db.retrieve_gas_payment_for_message_id(msg_id)
    }
}

#[cfg(test)]
mod test {
    use std::str::FromStr;

    use hyperlane_core::{db::HyperlaneDB, HyperlaneMessage, TxCostEstimate, H160, H256, U256};
    use hyperlane_test::test_utils;

    use crate::settings::{matching_list::MatchingList, GasPaymentEnforcementPolicy};

    use super::GasPaymentEnforcer;

    #[tokio::test]
    async fn test_empty_whitelist() {
        test_utils::run_test_db(|db| async move {
            let hyperlane_db = HyperlaneDB::new("mailbox", db);

            let enforcer = GasPaymentEnforcer::new(
                // Require a payment
                GasPaymentEnforcementPolicy::Minimum {
                    payment: U256::one(),
                },
                // Empty whitelist
                MatchingList::default().into(),
                hyperlane_db,
            );

            // Ensure that message without any payment is considered as not meeting the requirement
            // because it doesn't match the GasPaymentEnforcementPolicy or whitelist
            assert_eq!(
                enforcer
                    .message_meets_gas_payment_requirement(
                        &HyperlaneMessage::default(),
                        &TxCostEstimate::default(),
                    )
                    .await
                    .unwrap(),
                (false, U256::zero())
            );
        })
        .await;
    }

    #[tokio::test]
    async fn test_non_empty_whitelist() {
        test_utils::run_test_db(|db| async move {
            let hyperlane_db = HyperlaneDB::new("mailbox", db);

            let sender_address = "0xaa000000000000000000000000000000000000aa";
            let recipient_address = "0xbb000000000000000000000000000000000000bb";

            let enforcer = GasPaymentEnforcer::new(
                // Require a payment
                GasPaymentEnforcementPolicy::Minimum {
                    payment: U256::one(),
                },
                // Whitelist
                serde_json::from_str(&format!(
                    r#"[{{"senderAddress": "{}", "recipientAddress": "{}"}}]"#,
                    sender_address, recipient_address,
                ))
                .unwrap(),
                hyperlane_db,
            );

            let sender: H256 = H160::from_str(sender_address).unwrap().into();
            let recipient: H256 = H160::from_str(recipient_address).unwrap().into();

            let matching_message = HyperlaneMessage {
                sender,
                recipient,
                ..HyperlaneMessage::default()
            };

            // The message should meet the requirement because it's on the whitelist, even
            // though it has no payment and doesn't satisfy the GasPaymentEnforcementPolicy
            assert_eq!(
                enforcer
                    .message_meets_gas_payment_requirement(
                        &matching_message,
                        &TxCostEstimate::default(),
                    )
                    .await
                    .unwrap(),
                (true, U256::zero())
            );

            // Switch the sender & recipient
            let not_matching_message = HyperlaneMessage {
                sender: recipient,
                recipient: sender,
                ..HyperlaneMessage::default()
            };

            // The message should not meet the requirement because it's NOT on the whitelist and
            // doesn't satisfy the GasPaymentEnforcementPolicy
            assert_eq!(
                enforcer
                    .message_meets_gas_payment_requirement(
                        &not_matching_message,
                        &TxCostEstimate::default(),
                    )
                    .await
                    .unwrap(),
                (false, U256::zero())
            );
        })
        .await;
    }
}
