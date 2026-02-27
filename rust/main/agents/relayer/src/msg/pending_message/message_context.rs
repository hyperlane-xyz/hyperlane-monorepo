use std::sync::Arc;

use tokio::sync::RwLock;

use hyperlane_base::{
    cache::{LocalCache, MeteredCache, OptionalCache},
    db::HyperlaneDb,
};
use hyperlane_core::{Mailbox, U256};
use hyperlane_operation_verifier::ApplicationOperationVerifier;
use lander::DispatcherEntrypoint;

use crate::{
    metrics::message_submission::MessageSubmissionMetrics,
    msg::{gas_payment::GasPaymentEnforcer, metadata::BuildsBaseMetadata},
};

/// The message context contains the links needed to submit a message. Each
/// instance is for a unique origin -> destination pairing.
pub struct MessageContext {
    /// Mailbox on the destination chain.
    pub destination_mailbox: Arc<dyn Mailbox>,
    /// Origin chain database to verify gas payments.
    pub origin_db: Arc<dyn HyperlaneDb>,
    /// Cache to store commonly used data calls.
    pub cache: OptionalCache<MeteredCache<LocalCache>>,
    /// Used to construct the ISM metadata needed to verify a message from the
    /// origin.
    pub metadata_builder: Arc<dyn BuildsBaseMetadata>,
    /// Used to determine if messages from the origin have made sufficient gas
    /// payments.
    pub origin_gas_payment_enforcer: Arc<RwLock<GasPaymentEnforcer>>,
    /// Hard limit on transaction gas when submitting a transaction to the
    /// destination.
    pub transaction_gas_limit: Option<U256>,
    pub metrics: MessageSubmissionMetrics,
    /// Application operation verifier
    pub application_operation_verifier: Arc<dyn ApplicationOperationVerifier>,
    /// Lander entrypoint for gas estimation (optional for backward compatibility)
    pub payload_dispatcher_entrypoint: Option<DispatcherEntrypoint>,
}
