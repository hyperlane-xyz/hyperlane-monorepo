use kaspa_consensus_core::tx::TransactionOutpoint;

#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("Message {message_id} is not delivered")]
    MessageNotDelivered { message_id: String },

    #[error("Some of the messages are not in the unprocessed status on the Hub")]
    MessagesNotUnprocessed,

    #[error("Hub outpoint {o:?} not found in PSKT inputs")]
    HubOutpointNotFound { o: TransactionOutpoint },

    #[error("PSKT payload doesn't match inteded HL messages")]
    PayloadMismatch,

    #[error("Outpoint {o:?} not found in PSKT chain")]
    AnchorMismatch { o: TransactionOutpoint },

    #[error("Some HL messages do not have outputs")]
    MissingOutputs,

    #[error(
        "Escrow input amount {input_amount} does not match escrow output amount {output_amount}"
    )]
    EscrowAmountMismatch {
        input_amount: u64,
        output_amount: u64,
    },

    #[error("System error: {0}")]
    SystemError(#[from] eyre::Report),
}
