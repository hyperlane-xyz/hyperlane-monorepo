use kaspa_consensus_core::tx::TransactionOutpoint;

#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("Message is not dispatched: {message_id}")]
    MessageNotDispatched { message_id: String },

    #[error("The same message was relayed twice: {message_id}")]
    DoubleSpending { message_id: String },

    #[error("HL message field mismatch: field={field} expected={expected} actual={actual}")]
    HLMessageFieldMismatch {
        field: String,
        expected: String,
        actual: String,
    },

    #[error("Transaction is not safe against reorg: {tx_id} confirmations={confirmations} required={required}")]
    NotSafeAgainstReorg {
        tx_id: String,
        confirmations: i64,
        required: i64,
    },

    #[error("Hub is not bootstrapped")]
    HubNotBootstrapped,

    #[error("Invalid transaction hash")]
    InvalidTransactionHash,

    #[error("UTXO not found at index {index}")]
    UtxoNotFound { index: usize },

    #[error("Failed to parse payload: {reason}")]
    PayloadParseError { reason: String },

    #[error("Insufficient deposit amount: required={required} actual={actual}")]
    InsufficientDepositAmount { required: String, actual: String },

    #[error("Deposit not to escrow address: expected={expected} actual={actual}")]
    WrongDepositAddress { expected: String, actual: String },

    #[error("Transaction data not found in block")]
    TransactionDataNotFound,

    #[error("Outpoint missing: {description}")]
    OutpointMissing { description: String },

    #[error("Invalid outpoint data: {reason}")]
    InvalidOutpointData { reason: String },

    #[error("Insufficient outpoints in cache: minimum_required=2 actual_count={count}")]
    InsufficientOutpoints { count: usize },

    #[error("Previous transaction not found in inputs")]
    PreviousTransactionNotFound,

    #[error("Transaction has no payload")]
    MissingTransactionPayload,

    #[error("Transaction inputs not found")]
    MissingTransactionInputs,

    #[error("Transaction outputs not found")]
    MissingTransactionOutputs,

    #[error("Script public key address not found in output")]
    MissingScriptPubKeyAddress,

    #[error("Failed to extract script public key address: {reason}")]
    ScriptPubKeyExtractionError { reason: String },

    #[error("Message IDs do not match")]
    MessageIdsMismatch,

    #[error("HL message ID mismatch after metadata injection")]
    HLMessageIdMismatch,

    #[error("Failed general verification: {reason}")]
    FailedGeneralVerification { reason: String },

    #[error("Some of the messages are not in the unprocessed status on the Hub")]
    MessagesNotUnprocessed,

    #[error("HL message used escrow address as withdrawal recipient")]
    EscrowWithdrawalNotAllowed { message_id: String },

    #[error("Anchor not found in PSKT inputs: outpoint={o:?}")]
    AnchorNotFound { o: TransactionOutpoint },

    #[error("Anchor shouldn't be spent in sweeping PSKT: outpoint={o:?}")]
    AnchorSpent { o: TransactionOutpoint },

    #[error("Anchor is not escrow change: outpoint={o:?}")]
    NonEscrowAnchor { o: TransactionOutpoint },

    #[error("No messages to validate")]
    NoMessages,

    #[error("Hub anchor mismatch: hub_anchor={hub_anchor:?} relayer_anchor={relayer_anchor:?}")]
    HubAnchorMismatch {
        hub_anchor: TransactionOutpoint,
        relayer_anchor: TransactionOutpoint,
    },

    #[error("Sighash type is not SIG_HASH_ALL | SIG_HASH_ANY_ONE_CAN_PAY")]
    SigHashType,

    #[error("Next anchor not found in PSKT outputs")]
    NextAnchorNotFound,

    #[error("More than one anchor candidate in PSKT outputs")]
    MultipleAnchors,

    #[error("PSKT payload doesn't match inteded HL messages")]
    PayloadMismatch,

    #[error("Outpoint not found in PSKT chain: outpoint={o:?}")]
    AnchorMismatch { o: TransactionOutpoint },

    #[error("Message cache length mismatch: expected={expected} actual={actual}")]
    MessageCacheLengthMismatch { expected: usize, actual: usize },

    #[error("Some HL messages do not have outputs")]
    MissingOutputs,

    #[error("Escrow amount mismatch: input_amount={input_amount} output_amount={output_amount}")]
    EscrowAmountMismatch {
        input_amount: u64,
        output_amount: u64,
    },

    #[error("Failed to get transaction: {tx_id}")]
    TransactionFetchError { tx_id: String },

    #[error("External API error: {reason}")]
    ExternalApiError { reason: String },

    #[error("Block hash conversion error: {reason}")]
    BlockHashConversionError { reason: String },

    #[error("Transaction hash conversion error: {reason}")]
    TransactionHashConversionError { reason: String },

    #[error("Hub query error: {reason}")]
    HubQueryError { reason: String },

    #[error("Kaspa node error: {reason}")]
    KaspaNodeError { reason: String },

    #[error("Finality check error: tx_id={tx_id} reason={reason}")]
    FinalityCheckError { tx_id: String, reason: String },
}
