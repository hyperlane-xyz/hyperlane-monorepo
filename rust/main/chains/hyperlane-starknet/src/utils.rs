use std::sync::Arc;

use cainome::cairo_serde::CairoSerde;
use hyperlane_core::Indexed;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneMessage, ModuleType, ReorgPeriod, TxOutcome,
};
use starknet::accounts::Execution;
use starknet::core::types::{ExecutionResult, PendingTransactionReceipt};
use starknet::{
    accounts::SingleOwnerAccount,
    core::{
        types::{EmittedEvent, FieldElement, MaybePendingTransactionReceipt, TransactionReceipt},
        utils::{cairo_short_string_to_felt, CairoShortStringToFeltError},
    },
    providers::{jsonrpc::HttpTransport, AnyProvider, JsonRpcClient, Provider},
    signers::LocalWallet,
};
use tracing::debug;
use url::Url;

use crate::contracts::{
    aggregation_ism, interchain_security_module, mailbox, multisig_ism, routing_ism,
    validator_announce,
};
use crate::types::{tx_pending_receipt_to_outcome, tx_receipt_to_outcome, HyH256};
use crate::{
    contracts::{interchain_security_module::ModuleType as StarknetModuleType, mailbox::Message},
    HyperlaneStarknetError,
};

/// Polls the rpc client until the transaction receipt is available.
pub async fn get_transaction_receipt(
    rpc: &Arc<AnyProvider>,
    transaction_hash: FieldElement,
) -> ChainResult<TxOutcome> {
    // there is a delay between the transaction being available
    // at the client and the sealing of the block

    // Polling delay is the total amount of seconds to wait before we call a timeout
    const TIMEOUT_DELAY: u64 = 60;
    const POLLING_INTERVAL: u64 = 2;

    let n = (TIMEOUT_DELAY / POLLING_INTERVAL) as usize;

    for retry_number in 1..n {
        let receipt = rpc
            .get_transaction_receipt(transaction_hash)
            .await
            .map_err(HyperlaneStarknetError::from);

        if receipt.is_err() {
            debug!(
                retry_number,
                "Starknet pending transaction receipt: {:?}", receipt
            );
        }

        let receipt = receipt?;
        match receipt {
            MaybePendingTransactionReceipt::PendingReceipt(pending) => {
                match pending.execution_result() {
                    // Even if the pending transaction succeeded, we still need to wait for the transaction to be sealed
                    ExecutionResult::Succeeded => {
                        debug!(
                            retry_number,
                            "Starknet pending transaction receipt: {:?}", pending
                        );
                        if let PendingTransactionReceipt::Invoke(receipt) = pending {
                            return tx_pending_receipt_to_outcome(receipt);
                        }
                        return Err(HyperlaneStarknetError::InvalidTransactionReceipt.into());
                    }
                    // If the transaction didn't succeed, we can short-circuit and return the error
                    ExecutionResult::Reverted { reason } => {
                        return Err(
                            HyperlaneStarknetError::TransactionReverted(reason.to_owned()).into(),
                        );
                    }
                }
            }
            MaybePendingTransactionReceipt::Receipt(receipt) => {
                if let TransactionReceipt::Invoke(receipt) = receipt {
                    return tx_receipt_to_outcome(receipt);
                }

                // If the receipt is not an Invoke receipt, we return an error
                return Err(HyperlaneStarknetError::InvalidTransactionReceipt.into());
            }
        }
    }

    // If we reach here, it means we didn't get the receipt in time
    debug!(
        "Starknet transaction receipt not available after {} retries",
        n
    );

    Err(ChainCommunicationError::CustomError(format!(
        "Starknet transaction receipt not available after {} retries",
        n
    )))
}

/// Creates a single owner account for a given signer and account address.
///
/// # Arguments
///
/// * `rpc_url` - The rpc url of the chain.
/// * `signer` - The signer of the account.
/// * `account_address` - The address of the account.
/// * `is_legacy` - Whether the account is legacy (Cairo 0) or not.
pub async fn build_single_owner_account(
    rpc_url: &Url,
    signer: LocalWallet,
    account_address: &FieldElement,
    is_legacy: bool,
) -> ChainResult<SingleOwnerAccount<AnyProvider, LocalWallet>> {
    let rpc_client =
        AnyProvider::JsonRpcHttp(JsonRpcClient::new(HttpTransport::new(rpc_url.clone())));

    let execution_encoding = if is_legacy {
        starknet::accounts::ExecutionEncoding::Legacy
    } else {
        starknet::accounts::ExecutionEncoding::New
    };

    let chain_id = rpc_client.chain_id().await.map_err(|_| {
        ChainCommunicationError::from_other_str("Failed to get chain id from rpc client")
    })?;

    Ok(SingleOwnerAccount::new(
        rpc_client,
        signer,
        *account_address,
        chain_id,
        execution_encoding,
    ))
}

/// Converts a starknet module type to a hyperlane module type.
pub fn to_hpl_module_type(module_type: StarknetModuleType) -> ModuleType {
    match module_type {
        StarknetModuleType::UNUSED(_) => ModuleType::Unused,
        StarknetModuleType::ROUTING(_) => ModuleType::Routing,
        StarknetModuleType::AGGREGATION(_) => ModuleType::Aggregation,
        StarknetModuleType::LEGACY_MULTISIG(_) => ModuleType::LegacyMultisig,
        StarknetModuleType::MERKLE_ROOT_MULTISIG(_) => ModuleType::MerkleRootMultisig,
        StarknetModuleType::MESSAGE_ID_MULTISIG(_) => ModuleType::MessageIdMultisig,
        StarknetModuleType::NULL => ModuleType::Null,
        StarknetModuleType::CCIP_READ(_) => ModuleType::CcipRead,
    }
}

/// Parses a hyperlane message from a starknet emitted event.
/// We use the CairoSerde trait to deserialize the message.
pub fn try_parse_hyperlane_message_from_event(
    event: &EmittedEvent,
) -> ChainResult<Indexed<HyperlaneMessage>> {
    if event.data.len() < 6 {
        return Err(HyperlaneStarknetError::InvalidEventData(format!(
            "{}",
            event.transaction_hash
        ))
        .into());
    }

    let sender: HyH256 = (event.data[0], event.data[1])
        .try_into()
        .map_err(Into::<HyperlaneStarknetError>::into)?;
    let destination = event.data[2]
        .try_into()
        .map_err(Into::<HyperlaneStarknetError>::into)?;
    let recipient: HyH256 = (event.data[3], event.data[4])
        .try_into()
        .map_err(Into::<HyperlaneStarknetError>::into)?;
    let message =
        Message::cairo_deserialize(&event.data, 5).map_err(Into::<HyperlaneStarknetError>::into)?;

    Ok(HyperlaneMessage {
        version: message.version,
        nonce: message.nonce,
        origin: message.origin,
        sender: sender.0,
        destination,
        recipient: recipient.0,
        body: u128_vec_to_u8_vec(message.body.data, message.body.size),
    }
    .into())
}

/// Converts a Vec<u128> to a Vec<u8>, respecting the given size and removing trailing zeros.
fn u128_vec_to_u8_vec(input: Vec<u128>, size: u32) -> Vec<u8> {
    let mut output = Vec::with_capacity(size as usize);
    for value in input {
        output.extend_from_slice(&value.to_be_bytes());
    }
    // Truncate to the specified size
    output.truncate(size as usize);
    // Remove trailing zeros
    while output.last() == Some(&0) && output.len() > size as usize {
        output.pop();
    }
    output
}
/// Macro to generate From<&[u8]> implementations for Starknet byte types
///
/// # Example
///
/// ```rust,ignore
/// use hyperlane_starknet::bytes_converter;
///
/// bytes_converter!(
///     crate::contracts::mailbox::Bytes
/// );
/// ```
#[macro_export]
macro_rules! bytes_converter {
    (
        $bytes:path
    ) => {
        impl From<&[u8]> for $bytes {
            fn from(bytes: &[u8]) -> Self {
                Self {
                    size: bytes.len() as u32,
                    data: $crate::utils::to_packed_bytes(bytes),
                }
            }
        }
    };
}

/// Macro to generate From<&HyperlaneMessage> implementations for Starknet message types
///
/// # Example
///
/// ```rust,ignore
/// use hyperlane_starknet::message_converter;
///
/// message_converter!(
///     crate::contracts::mailbox::Message
/// );
/// ```
#[macro_export]
macro_rules! message_converter {
    (
        $msg:path
    ) => {
        impl From<&hyperlane_core::HyperlaneMessage> for $msg {
            fn from(message: &hyperlane_core::HyperlaneMessage) -> Self {
                Self {
                    version: message.version,
                    nonce: message.nonce,
                    origin: message.origin,
                    sender: cainome::cairo_serde::U256::from_bytes_be(
                        &message.sender.to_fixed_bytes(),
                    ),
                    destination: message.destination,
                    recipient: cainome::cairo_serde::U256::from_bytes_be(
                        &message.recipient.to_fixed_bytes(),
                    ),
                    body: message.body.as_slice().into(),
                }
            }
        }
    };
}
// Use the macro for each message/bytes pair
bytes_converter!(validator_announce::Bytes);
bytes_converter!(mailbox::Bytes);
bytes_converter!(interchain_security_module::Bytes);
bytes_converter!(aggregation_ism::Bytes);
bytes_converter!(multisig_ism::Bytes);
bytes_converter!(routing_ism::Bytes);

message_converter!(mailbox::Message);
message_converter!(interchain_security_module::Message);
message_converter!(aggregation_ism::Message);
message_converter!(multisig_ism::Message);
message_converter!(routing_ism::Message);

/// Convert a byte slice to a starknet bytes by padding the bytes to 16 bytes chunks
pub fn to_packed_bytes(bytes: &[u8]) -> Vec<u128> {
    // Calculate the required padding
    let padding = (16 - (bytes.len() % 16)) % 16;
    let total_len = bytes.len() + padding;

    // Create a new byte vector with the necessary padding
    let mut padded_bytes = Vec::with_capacity(total_len);
    padded_bytes.extend_from_slice(bytes);
    padded_bytes.extend(std::iter::repeat(0).take(padding));

    let mut result = Vec::with_capacity(total_len / 16);
    for chunk in padded_bytes.chunks_exact(16) {
        // Convert each 16-byte chunk into a u128
        let mut array = [0u8; 16];
        array.copy_from_slice(chunk);
        result.push(u128::from_be_bytes(array));
    }

    result
}

/// Convert a string to a cairo long string
/// We need to split the string in 31 bytes chunks
pub fn string_to_cairo_long_string(
    s: &str,
) -> Result<Vec<FieldElement>, CairoShortStringToFeltError> {
    let chunk_size = 31;
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < s.len() {
        let end = std::cmp::min(start + chunk_size, s.len());
        let chunk = s[start..end].to_string();
        chunks.push(cairo_short_string_to_felt(&chunk)?);
        start += chunk_size;
    }

    Ok(chunks)
}

/// Given a `reorg_period`, returns the block height at the moment.
/// If the `reorg_period` is None, a block height of None is given,
/// indicating that the tip directly can be used.
pub(crate) async fn get_block_height_for_reorg_period(
    provider: &AnyProvider,
    reorg_period: &ReorgPeriod,
) -> ChainResult<u64> {
    let block_height = match reorg_period {
        ReorgPeriod::Blocks(blocks) => {
            let tip = provider
                .block_number()
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?;
            tip - blocks.get() as u64
        }
        ReorgPeriod::None => provider
            .block_number()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?,
        ReorgPeriod::Tag(_) => {
            return Err(ChainCommunicationError::InvalidReorgPeriod(
                reorg_period.clone(),
            ))
        }
    };

    Ok(block_height)
}

pub(crate) async fn get_block_height_u32(
    provider: &AnyProvider,
    reorg_period: &ReorgPeriod,
) -> ChainResult<u32> {
    let height = get_block_height_for_reorg_period(provider, reorg_period).await?;
    height
        .try_into()
        .map_err(ChainCommunicationError::from_other)
}

/// Sends a transaction and gets the transaction receipt.
/// Returns the transaction outcome if the receipt is available.
pub async fn send_and_confirm(
    rpc_client: &Arc<AnyProvider>,
    contract_call: Execution<'_, SingleOwnerAccount<AnyProvider, LocalWallet>>,
) -> ChainResult<TxOutcome> {
    let tx = contract_call
        .send()
        .await
        .map_err(HyperlaneStarknetError::from)?;

    get_transaction_receipt(rpc_client, tx.transaction_hash).await
}

#[cfg(test)]
mod tests {
    use super::{to_packed_bytes, u128_vec_to_u8_vec};

    #[test]
    fn test_u128_vec_to_u8_vec() {
        let input: Vec<u128> = vec![
            0x01020304050607080910111213141516,
            0x01020304050607080910111213141516,
            0x01020304050607080910000000000000,
        ];
        let output = u128_vec_to_u8_vec(input.clone(), 42);
        let expected: Vec<u8> = vec![
            0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x10, 0x11, 0x12, 0x13, 0x14,
            0x15, 0x16, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x10, 0x11, 0x12,
            0x13, 0x14, 0x15, 0x16, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x10,
        ];
        assert_eq!(output, expected);
    }

    #[test]
    fn test_to_packed_bytes() {
        let more_than_16_bytes: &[u8] = &[
            0, 0, 0, 8, 0, 0, 0, 141, 7, 30, 27, 94, 84, 8, 107, 189, 226, 183, 161, 49, 162, 201,
            19, 244, 66, 72, 89, 116, 195, 45, 245, 110, 228, 127, 148, 86, 179, 39, 13, 174, 190,
            34, 250, 186, 91, 192, 34, 58, 126, 48, 119, 173, 205, 4, 57, 31, 44, 205, 210, 178,
            173, 46, 172, 45, 113, 195, 240, 71, 85, 213, 217, 93, 0, 0, 0, 1, 93, 203, 240, 127,
            161, 137, 139, 13, 139, 100, 153, 31, 9, 158, 132, 120, 38, 143, 179, 110, 14, 95, 231,
            131, 42, 163, 69, 218, 139, 136, 136, 100, 86, 34, 120, 109, 83, 216, 152, 201, 93,
            117, 211, 122, 88, 45, 231, 141, 237, 162, 52, 151, 125, 128, 99, 73, 234, 198, 101,
            62, 145, 144, 209, 26, 28,
        ];
        let result = to_packed_bytes(more_than_16_bytes);
        assert_eq!(
            result,
            vec![
                633825302715618492640915909565,
                301358986773008671761717609911487952238,
                303726413405683088284031432680823333434,
                167734385094773553695181262457930689581,
                151220134841178953442829589507493064831,
                214719872319031779231989441941407249262,
                19107155771253118945685492213253044333,
                111450558651636509550279524233513153687,
                166820127285872904829776859676333309952
            ]
        );
    }
}
