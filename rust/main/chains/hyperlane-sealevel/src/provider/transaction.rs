use solana_transaction_status::{
    EncodedTransaction, EncodedTransactionWithStatusMeta, UiInstruction, UiMessage,
    UiParsedMessage, UiTransaction,
};

use hyperlane_core::{ChainCommunicationError, ChainResult};

use crate::error::HyperlaneSealevelError;

pub(crate) fn txn(txn_with_meta: &EncodedTransactionWithStatusMeta) -> ChainResult<&UiTransaction> {
    match &txn_with_meta.transaction {
        EncodedTransaction::Json(t) => Ok(t),
        t => Err(Into::<ChainCommunicationError>::into(
            HyperlaneSealevelError::UnsupportedTransactionEncoding(Box::new(t.clone())),
        ))?,
    }
}

pub(crate) fn parsed_message(txn: &UiTransaction) -> ChainResult<&UiParsedMessage> {
    Ok(match &txn.message {
        UiMessage::Parsed(m) => m,
        m => Err(Into::<ChainCommunicationError>::into(
            HyperlaneSealevelError::UnsupportedMessageEncoding(Box::new(m.clone())),
        ))?,
    })
}

pub(crate) fn instructions(txn: &UiTransaction) -> ChainResult<&Vec<UiInstruction>> {
    let message = parsed_message(txn)?;
    Ok(&message.instructions)
}
