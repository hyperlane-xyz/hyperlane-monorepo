use std::fmt::Debug;

use async_trait::async_trait;
use eyre::Result;

use crate::msg::gas_payment::policies::GasPaymentPolicyOnChainFeeQuoting;
use hyperlane_core::{
    db::{DbError, HyperlaneDB},
    GasExpenditureWithMeta, HyperlaneMessage, InterchainGasExpenditure, InterchainGasPayment,
    TxCostEstimate, TxMeta, TxOutcome, H256, U256,
};

use crate::settings::{
    matching_list::MatchingList, GasPaymentEnforcementConfig, GasPaymentEnforcementPolicy,
};

use self::policies::{
    GasPaymentPolicyMeetsEstimatedCost, GasPaymentPolicyMinimum, GasPaymentPolicyNone,
};

mod policies;

#[async_trait]
pub trait GasPaymentPolicy: Debug + Send + Sync {
    /// Returns Some(gas_limit) if the policy has approved the transaction or
    /// None if the transaction is not approved.
    async fn message_meets_gas_payment_requirement(
        &self,
        message: &HyperlaneMessage,
        current_payment: &InterchainGasPayment,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>>;
}

#[derive(Debug)]
pub struct GasPaymentEnforcer {
    /// List of policies and a whitelist to decide if it should be used for a
    /// given transaction. It is highly recommended to have the last policy
    /// use a wild-card white list to ensure all messages fall into one
    /// policy or another. If a message matches multiple policies'
    /// whitelists, then whichever is first in the list will be used.
    policies: Vec<(Box<dyn GasPaymentPolicy>, MatchingList)>,
    db: HyperlaneDB,
}

impl GasPaymentEnforcer {
    pub fn new(
        policy_configs: impl IntoIterator<Item = GasPaymentEnforcementConfig>,
        db: HyperlaneDB,
    ) -> Self {
        let policies = policy_configs
            .into_iter()
            .map(|cfg| {
                let p: Box<dyn GasPaymentPolicy> = match cfg.policy {
                    GasPaymentEnforcementPolicy::None => Box::new(GasPaymentPolicyNone::new()),
                    GasPaymentEnforcementPolicy::Minimum { payment } => {
                        Box::new(GasPaymentPolicyMinimum::new(payment))
                    }
                    GasPaymentEnforcementPolicy::MeetsEstimatedCost { coingeckoapikey } => {
                        Box::new(GasPaymentPolicyMeetsEstimatedCost::new(coingeckoapikey))
                    }
                    GasPaymentEnforcementPolicy::OnChainFeeQuoting { gasfraction } => {
                        let gasfraction = gasfraction.replace(' ', "");
                        let v: Vec<&str> = gasfraction.split('/').collect();
                        assert_eq!(
                            v.len(),
                            2,
                            r#"Could not parse gas fraction; expected "`numerator / denominator`""#
                        );
                        Box::new(GasPaymentPolicyOnChainFeeQuoting::new(
                            v[0].parse::<u64>().expect("Invalid integer"),
                            v[1].parse::<u64>().expect("Invalid integer"),
                        ))
                    }
                };
                (p, cfg.whitelist)
            })
            .collect();

        Self { policies, db }
    }
}

impl GasPaymentEnforcer {
    /// Returns Some(gas_limit) if the enforcer has approved the transaction or
    /// None if the transaction is not approved.
    pub async fn message_meets_gas_payment_requirement(
        &self,
        message: &HyperlaneMessage,
        tx_cost_estimate: &TxCostEstimate,
    ) -> Result<Option<U256>> {
        let current_payment = self.get_message_gas_payment(message.id())?;
        for (policy, whitelist) in &self.policies {
            if !whitelist.msg_matches(message, true) {
                continue;
            }
            return policy
                .message_meets_gas_payment_requirement(message, &current_payment, tx_cost_estimate)
                .await;
        }

        panic!("No gas payment policy matched for message; consider adding a default policy to the end of the policies array which uses a wildcard whitelist. {message:?}")
    }

    pub fn record_failed_outcome(
        &self,
        message: &HyperlaneMessage,
        outcome: TxOutcome,
    ) -> Result<()> {
        self.db.process_gas_expenditure(&GasExpenditureWithMeta {
            payment: InterchainGasExpenditure {
                message_id: message.id(),
                spent: outcome.gas_spent,
            },
            meta: TxMeta {
                transaction_hash: outcome.txid,
                log_index: outcome.log_index,
            },
        })?;
        Ok(())
    }

    fn get_message_gas_payment(&self, msg_id: H256) -> Result<InterchainGasPayment, DbError> {
        self.db.retrieve_gas_payment_for_message_id(msg_id)
    }
}

#[cfg(test)]
mod test {
    use std::str::FromStr;

    use hyperlane_core::{db::HyperlaneDB, HyperlaneMessage, TxCostEstimate, H160, H256, U256};
    use hyperlane_test::test_utils;

    use crate::settings::{
        matching_list::MatchingList, GasPaymentEnforcementConfig, GasPaymentEnforcementPolicy,
    };

    use super::GasPaymentEnforcer;

    #[tokio::test]
    async fn test_empty_whitelist() {
        test_utils::run_test_db(|db| async move {
            let hyperlane_db = HyperlaneDB::new("mailbox", db);

            let enforcer = GasPaymentEnforcer::new(
                // Require a payment
                vec![GasPaymentEnforcementConfig {
                    policy: GasPaymentEnforcementPolicy::Minimum {
                        payment: U256::one(),
                    },
                    whitelist: Default::default(),
                }],
                hyperlane_db,
            );

            // Ensure that message without any payment is considered as not meeting the
            // requirement because it doesn't match the GasPaymentEnforcementPolicy
            assert_eq!(
                enforcer
                    .message_meets_gas_payment_requirement(
                        &HyperlaneMessage::default(),
                        &TxCostEstimate::default(),
                    )
                    .await
                    .unwrap(),
                None
            );
        })
        .await;
    }

    #[tokio::test]
    #[should_panic]
    async fn test_no_whitelist_match() {
        #[allow(unused_must_use)]
        test_utils::run_test_db(|db| async move {
            let hyperlane_db = HyperlaneDB::new("mailbox", db);

            let Ok(whitelist) = serde_json::from_str(r#"[{"originDomain": 234}]"#) else {
                // weird, but don't panic since then the test will pass by accident
                eprintln!("Failed to parse matching list");
                return
            };

            let enforcer = GasPaymentEnforcer::new(
                // Require a payment
                vec![GasPaymentEnforcementConfig {
                    policy: GasPaymentEnforcementPolicy::None,
                    whitelist,
                }],
                hyperlane_db,
            );

            enforcer
                .message_meets_gas_payment_requirement(
                    &HyperlaneMessage::default(),
                    &TxCostEstimate::default(),
                )
                .await;
        })
        .await;
    }

    #[tokio::test]
    async fn test_non_empty_whitelist() {
        test_utils::run_test_db(|db| async move {
            let hyperlane_db = HyperlaneDB::new("mailbox", db);

            let sender_address = "0xaa000000000000000000000000000000000000aa";
            let recipient_address = "0xbb000000000000000000000000000000000000bb";

            let matching_list = serde_json::from_str(
                &format!(r#"[{{"senderAddress": "{sender_address}", "recipientAddress": "{recipient_address}"}}]"#)
            ).unwrap();

            let enforcer = GasPaymentEnforcer::new(
                vec![
                    GasPaymentEnforcementConfig {
                        // No payment for special cases
                        policy: GasPaymentEnforcementPolicy::None,
                        whitelist: matching_list,
                    },
                    GasPaymentEnforcementConfig {
                        // All other messages must pass a minimum
                        policy: GasPaymentEnforcementPolicy::Minimum {
                            payment: U256::one(),
                        },
                        whitelist: MatchingList::default(),
                    },
                ],
                hyperlane_db,
            );

            let sender: H256 = H160::from_str(sender_address).unwrap().into();
            let recipient: H256 = H160::from_str(recipient_address).unwrap().into();

            let matching_message = HyperlaneMessage {
                sender,
                recipient,
                ..HyperlaneMessage::default()
            };

            // The message should meet the requirement because it's on the whitelist for the first
            // policy, even though it would not pass the second (default) policy.
            assert!(enforcer
                .message_meets_gas_payment_requirement(
                    &matching_message,
                    &TxCostEstimate::default(),
                )
                .await
                .unwrap()
                .is_some());

            // Switch the sender & recipient
            let not_matching_message = HyperlaneMessage {
                sender: recipient,
                recipient: sender,
                ..HyperlaneMessage::default()
            };

            // The message should not meet the requirement because it's NOT on the first whitelist
            // and doesn't satisfy the GasPaymentEnforcementPolicy
            assert!(enforcer
                .message_meets_gas_payment_requirement(
                    &not_matching_message,
                    &TxCostEstimate::default(),
                )
                .await
                .unwrap()
                .is_none());
        })
        .await;
    }
}
