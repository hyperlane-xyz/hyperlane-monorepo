use solana_transaction_status::{
    option_serializer::OptionSerializer, EncodedTransaction, EncodedTransactionWithStatusMeta,
    UiInnerInstructions, UiInstruction, UiMessage, UiParsedMessage, UiTransaction,
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

pub(crate) fn inner_instructions<'a>(
    txn: &'a EncodedTransactionWithStatusMeta,
    empty: &'a Vec<UiInnerInstructions>,
) -> ChainResult<Vec<&'a UiInstruction>> {
    let instructions = txn
        .meta
        .as_ref()
        .map(|v| match &v.inner_instructions {
            OptionSerializer::Some(ii) => ii,
            OptionSerializer::None | OptionSerializer::Skip => empty,
        })
        .unwrap_or(empty)
        .iter()
        .flat_map(|i| &i.instructions)
        .collect::<Vec<&UiInstruction>>();

    Ok(instructions)
}
