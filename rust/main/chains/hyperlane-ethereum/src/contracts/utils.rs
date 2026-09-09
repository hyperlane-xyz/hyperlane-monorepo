use std::{ops::Deref, sync::Arc};

use ethers::{
    abi::RawLog,
    providers::Middleware,
    types::{H160 as EthersH160, H256 as EthersH256},
};
use ethers_contract::{ContractError, EthEvent, LogMeta as EthersLogMeta};
use hyperlane_core::{ChainCommunicationError, ChainResult, LogMeta, H512};

use crate::EthereumReorgPeriod;

/// Returns `Ok(None)` when the RPC returns no receipt for the tx hash.
/// Returns `Err` for transient RPC failures.
/// Callers that need retry-on-missing-receipt must convert `None` to `Err` inside their retry closure.
pub async fn fetch_raw_logs_and_meta<T: EthEvent, M>(
    tx_hash: H512,
    provider: Arc<M>,
    contract_address: EthersH160,
) -> ChainResult<Option<Vec<(T, LogMeta)>>>
where
    M: Middleware + 'static,
{
    let ethers_tx_hash: EthersH256 = tx_hash.into();
    let receipt = provider
        .get_transaction_receipt(ethers_tx_hash)
        .await
        .map_err(|err| ContractError::<M>::MiddlewareError(err))?;
    let Some(receipt) = receipt else {
        return Ok(None);
    };

    let mut logs = Vec::new();
    for log in receipt
        .logs
        .into_iter()
        .filter(|log| log.address == contract_address)
    {
        let raw_log = RawLog {
            topics: log.topics.clone(),
            data: log.data.to_vec(),
        };
        let Ok(event) = T::decode_log(&raw_log) else {
            continue;
        };
        // ethers' From<&Log> panics on missing mined metadata. Matching events
        // must instead fail the receipt read so callers can retry; silently
        // skipping them would turn incomplete RPC data into a successful result.
        let missing = |field| {
            ChainCommunicationError::from_other_str(&format!(
                "Matching receipt log is missing {field}"
            ))
        };
        let meta = EthersLogMeta {
            address: log.address,
            block_number: log.block_number.ok_or_else(|| missing("block number"))?,
            block_hash: log.block_hash.ok_or_else(|| missing("block hash"))?,
            transaction_hash: log
                .transaction_hash
                .ok_or_else(|| missing("transaction hash"))?,
            transaction_index: log
                .transaction_index
                .ok_or_else(|| missing("transaction index"))?,
            log_index: log.log_index.ok_or_else(|| missing("log index"))?,
        };
        logs.push((event, meta.into()));
    }
    Ok(Some(logs))
}

pub async fn get_finalized_block_number<M, T>(
    provider: T,
    reorg_period: &EthereumReorgPeriod,
) -> ChainResult<u32>
where
    M: Middleware + 'static,
    T: Deref<Target = M>,
{
    let number = match *reorg_period {
        EthereumReorgPeriod::Blocks(blocks) => provider
            .get_block_number()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .as_u32()
            .saturating_sub(blocks),

        EthereumReorgPeriod::Tag(tag) => provider
            .get_block(tag)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .and_then(|block| block.number)
            .ok_or(ChainCommunicationError::CustomError(
                "Unable to get finalized block number".into(),
            ))?
            .as_u32(),
    };

    Ok(number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interfaces::i_interchain_gas_paymaster::GasPaymentFilter;
    use ethers::{
        abi::{encode, Token},
        providers::Provider,
        types::{Log, TransactionReceipt, U256},
    };

    fn gas_log() -> Log {
        Log {
            address: EthersH160::from_low_u64_be(3),
            topics: vec![
                GasPaymentFilter::signature(),
                EthersH256::from_low_u64_be(7),
                EthersH256::from_low_u64_be(6),
            ],
            data: encode(&[
                Token::Uint(U256::from(50000)),
                Token::Uint(U256::from(1000)),
            ])
            .into(),
            block_number: Some(100.into()),
            block_hash: Some(EthersH256::from_low_u64_be(8)),
            transaction_hash: Some(EthersH256::from_low_u64_be(9)),
            transaction_index: Some(4.into()),
            log_index: Some(5.into()),
            ..Default::default()
        }
    }

    async fn read_receipt(
        receipt: Option<TransactionReceipt>,
    ) -> ChainResult<Option<Vec<(GasPaymentFilter, LogMeta)>>> {
        let (provider, mock) = Provider::mocked();
        mock.push(receipt).unwrap();
        fetch_raw_logs_and_meta::<GasPaymentFilter, _>(
            H512::zero(),
            Arc::new(provider),
            gas_log().address,
        )
        .await
    }

    #[tokio::test]
    async fn receipt_metadata_preserves_complete_payment_and_identity() {
        let log = gas_log();
        let expected: LogMeta = EthersLogMeta::from(&log).into();
        let result = read_receipt(Some(TransactionReceipt {
            logs: vec![log],
            ..Default::default()
        }))
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].1, expected);
        assert_eq!(result[0].0.message_id, EthersH256::from_low_u64_be(7).0);
        assert_eq!(result[0].0.destination_domain, 6);
        assert_eq!(result[0].0.gas_amount, U256::from(50000));
        assert_eq!(result[0].0.payment, U256::from(1000));
    }

    #[tokio::test]
    async fn incomplete_matching_receipt_metadata_is_an_error_not_a_panic_or_empty_success() {
        for missing_field in 0..5 {
            let mut log = gas_log();
            match missing_field {
                0 => log.block_number = None,
                1 => log.block_hash = None,
                2 => log.transaction_hash = None,
                3 => log.transaction_index = None,
                _ => log.log_index = None,
            }
            let error = read_receipt(Some(TransactionReceipt {
                logs: vec![gas_log(), log],
                ..Default::default()
            }))
            .await
            .unwrap_err();
            assert!(error
                .to_string()
                .contains("Matching receipt log is missing"));
        }
    }

    #[tokio::test]
    async fn absent_receipts_and_irrelevant_logs_preserve_lookup_semantics() {
        assert!(read_receipt(None).await.unwrap().is_none());
        let mut wrong_contract = gas_log();
        wrong_contract.address = EthersH160::zero();
        wrong_contract.block_hash = None;
        let undecodable = Log {
            address: gas_log().address,
            ..Default::default()
        };
        let result = read_receipt(Some(TransactionReceipt {
            logs: vec![wrong_contract, undecodable],
            ..Default::default()
        }))
        .await
        .unwrap()
        .unwrap();
        assert!(result.is_empty());
    }
}
