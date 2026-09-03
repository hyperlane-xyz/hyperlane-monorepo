//! Fixed-cardinality attribution for RPC requests.

use std::future::Future;

tokio::task_local! {
    static RPC_OPERATION: RpcOperation;
}

/// The bounded operation classes used to attribute physical RPC requests.
///
/// Keep this enum small. Values become Prometheus labels, so addresses, message IDs,
/// function names, provider URLs, and other unbounded inputs do not belong here.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RpcOperation {
    /// The request did not run inside an explicit operation scope.
    #[default]
    Unattributed,
    /// Contract event cursor and range synchronization.
    ContractSync,
    /// Periodic agent balance, block, and gas metrics.
    AgentMetrics,
    /// Validator checkpoint correctness and submission reads.
    ValidatorCheckpoint,
    /// Relayer destination delivery-state reads.
    RelayerDelivery,
    /// Relayer recipient code and ISM discovery reads.
    RelayerRecipient,
    /// Relayer ISM and metadata construction reads.
    RelayerMetadata,
    /// Relayer process simulation and transaction-cost estimation.
    RelayerEstimate,
    /// Nonce, submission, receipt, inclusion, and finality reads or writes.
    TransactionLifecycle,
}

impl RpcOperation {
    /// Return the stable Prometheus label value for this operation class.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unattributed => "unattributed",
            Self::ContractSync => "contract_sync",
            Self::AgentMetrics => "agent_metrics",
            Self::ValidatorCheckpoint => "validator_checkpoint",
            Self::RelayerDelivery => "relayer_delivery",
            Self::RelayerRecipient => "relayer_recipient",
            Self::RelayerMetadata => "relayer_metadata",
            Self::RelayerEstimate => "relayer_estimate",
            Self::TransactionLifecycle => "transaction_lifecycle",
        }
    }
}

/// Run a future with a fixed RPC operation attribution value.
pub async fn with_rpc_operation<F>(operation: RpcOperation, future: F) -> F::Output
where
    F: Future,
{
    RPC_OPERATION.scope(operation, future).await
}

/// Return the current RPC operation, or `Unattributed` outside an explicit scope.
pub fn current_rpc_operation() -> RpcOperation {
    RPC_OPERATION
        .try_with(|operation| *operation)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scopes_and_restores_operation() {
        assert_eq!(current_rpc_operation(), RpcOperation::Unattributed);

        with_rpc_operation(RpcOperation::ContractSync, async {
            assert_eq!(current_rpc_operation(), RpcOperation::ContractSync);
            with_rpc_operation(RpcOperation::RelayerDelivery, async {
                assert_eq!(current_rpc_operation(), RpcOperation::RelayerDelivery);
            })
            .await;
            assert_eq!(current_rpc_operation(), RpcOperation::ContractSync);
        })
        .await;

        assert_eq!(current_rpc_operation(), RpcOperation::Unattributed);
    }
}
