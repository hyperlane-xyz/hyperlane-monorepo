use solana_transaction_status::{UiMessage, UiParsedMessage, UiTransaction};

use hyperlane_core::{ChainCommunicationError, ChainResult};

use crate::error::HyperlaneSealevelError;

pub(crate) fn parsed_message(txn: &UiTransaction) -> ChainResult<&UiParsedMessage> {
    Ok(match &txn.message {
        UiMessage::Parsed(m) => m,
        m => Err(Into::<ChainCommunicationError>::into(
            HyperlaneSealevelError::UnsupportedMessageEncoding(Box::new(m.clone())),
        ))?,
    })
}
