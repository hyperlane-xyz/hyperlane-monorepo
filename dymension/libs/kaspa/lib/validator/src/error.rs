use kaspa_consensus_core::tx::TransactionOutpoint;

#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("Message is not dispatched: {message_id}")]
    MessageNotDispatched { message_id: String },

    #[error("The same message was relayed twice: {message_id}")]
    DoubleSpending { message_id: String },

    #[error("HL message: mismatched domain or recipient")]
    IncorrectHLMessage,

    #[error("Immature transaction: {tx_id}")]
    ImmatureTransaction { tx_id: String },

    #[error("Message is for another bridge: {message_id}")]
    MessageWrongBridge { message_id: String },

    #[error("Some of the messages are not in the unprocessed status on the Hub")]
    MessagesNotUnprocessed,

    #[error("HL message used escrow address as withdrawal recipient")]
    EscrowWithdrawalNotAllowed { message_id: String },

    #[error("Anchor {o:?} not found in PSKT inputs")]
    AnchorNotFound { o: TransactionOutpoint },

    #[error(
        "Relayer Hub anchor {hub_anchor:?} does not match withdrawal Hub anchor {relayer_anchor:?}"
    )]
    HubAnchorMismatch {
        hub_anchor: TransactionOutpoint,
        relayer_anchor: TransactionOutpoint,
    },

    #[error("Sighash type is not SIG_HASH_ALL | SIG_HASH_ANY_ONE_CAN_PAY")]
    IncorrectSigHashType,

    #[error("PSKT should not have lock time")]
    UnexpectedLockTime,

    #[error("Next anchor not found in PSKT outputs")]
    NextAnchorNotFound,

    #[error("More than one anchor candidate in PSKT outputs")]
    MultipleAnchors,

    #[error("PSKT payload doesn't match inteded HL messages")]
    PayloadMismatch,

    #[error("PSKT has incorrect TX version")]
    TxVersionMismatch,

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

    #[error("{0}")]
    SystemError(#[from] eyre::Report),
}
