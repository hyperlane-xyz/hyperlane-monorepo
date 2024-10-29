use base64::Engine;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{ChainCommunicationError, ChainResult};

use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    message::Message,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use solana_transaction_status::UiReturnDataEncoding;

use crate::client::RpcClientWithDebug;

/// Simulates an instruction, and attempts to deserialize it into a T.
/// If no return data at all was returned, returns Ok(None).
/// If some return data was returned but deserialization was unsuccessful,
/// an Err is returned.
pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
    rpc_client: &RpcClient,
    payer: &Keypair,
    instruction: Instruction,
) -> ChainResult<Option<T>> {
    let commitment = CommitmentConfig::finalized();
    let (recent_blockhash, _) = rpc_client
        .get_latest_blockhash_with_commitment(commitment)
        .await
        .map_err(ChainCommunicationError::from_other)?;
    let return_data = rpc_client
        .simulate_transaction(&Transaction::new_unsigned(Message::new_with_blockhash(
            &[instruction],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .map_err(ChainCommunicationError::from_other)?
        .value
        .return_data;

    if let Some(return_data) = return_data {
        let bytes = match return_data.data.1 {
            UiReturnDataEncoding::Base64 => base64::engine::general_purpose::STANDARD
                .decode(return_data.data.0)
                .map_err(ChainCommunicationError::from_other)?,
        };

        let decoded_data =
            T::try_from_slice(bytes.as_slice()).map_err(ChainCommunicationError::from_other)?;

        return Ok(Some(decoded_data));
    }

    Ok(None)
}

/// Simulates an Instruction that will return a list of AccountMetas.
pub async fn get_account_metas(
    rpc_client: &RpcClient,
    payer: &Keypair,
    instruction: Instruction,
) -> ChainResult<Vec<AccountMeta>> {
    // If there's no data at all, default to an empty vec.
    let account_metas = simulate_instruction::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
        rpc_client,
        payer,
        instruction,
    )
    .await?
    .map(|serializable_account_metas| {
        serializable_account_metas
            .return_data
            .into_iter()
            .map(|serializable_account_meta| serializable_account_meta.into())
            .collect()
    })
    .unwrap_or_else(Vec::new);

    Ok(account_metas)
}

pub async fn get_finalized_block_number(rpc_client: &RpcClientWithDebug) -> ChainResult<u32> {
    let height = rpc_client
        .get_block_height()
        .await
        .map_err(ChainCommunicationError::from_other)?
        .try_into()
        // FIXME solana block height is u64...
        .expect("sealevel block height exceeds u32::MAX");
    Ok(height)
}
