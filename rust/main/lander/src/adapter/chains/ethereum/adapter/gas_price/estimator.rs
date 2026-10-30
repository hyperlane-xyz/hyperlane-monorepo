use std::{str::FromStr, sync::Arc};

use ethers::{
    abi::Detokenize,
    contract::builders::ContractCall,
    providers::{Middleware, ProviderError},
    types::{
        transaction::eip2718::TypedTransaction, Block, Eip1559TransactionRequest, H160,
        H256 as TxHash,
    },
};
use ethers_core::{
    types::{BlockNumber, FeeHistory, U256 as EthersU256},
    utils::{
        eip1559_default_estimator, EIP1559_FEE_ESTIMATION_PAST_BLOCKS,
        EIP1559_FEE_ESTIMATION_REWARD_PERCENTILE,
    },
};
use futures_util::{future::join_all, try_join};
use tracing::{debug, warn};

use hyperlane_core::{ChainCommunicationError, ChainResult, HyperlaneDomain, U256};
use hyperlane_ethereum::{EvmProviderForLander, TransactionOverrides, ZksyncEstimateFeeResponse};

use crate::{adapter::EthereumTxPrecursor, LanderError};

use super::super::super::gas_price::GasPrice;

type FeeEstimator = fn(EthersU256, Vec<Vec<EthersU256>>) -> (EthersU256, EthersU256);

const EVM_RELAYER_ADDRESS: &str = "0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5";

// If p5 rewards are zero, try higher percentiles up to the gas-weighted median.
// Never use p100: a block's highest tip can be an extreme MEV outlier, even when
// ordinary transactions pay little or nothing. This applies to every chain using
// this estimator.
const FALLBACK_REWARD_PERCENTILES: [f64; 4] = [10.0, 15.0, 20.0, 50.0];

/// Default priority fee ceiling for all EIP-1559 chains.
const MAX_PRIORITY_FEE_BASE_FEE_MULTIPLIER: u64 = 4;

/// The default priority fee cap never goes below this value (5 gwei).
/// This is a floor for the cap, not a minimum tip.
const MAX_PRIORITY_FEE_FLOOR_WEI: u64 = 5_000_000_000;

pub type Eip1559Fee = (
    EthersU256, // base fee
    EthersU256, // max fee
    EthersU256, // max priority fee
);

/// Estimate and escalate fees while respecting the chain's priority fee ceiling.
pub async fn estimate_gas_price(
    provider: &Arc<dyn EvmProviderForLander>,
    tx_precursor: &EthereumTxPrecursor,
    transaction_overrides: &TransactionOverrides,
    domain: &HyperlaneDomain,
) -> Result<GasPrice, LanderError> {
    let tx = &tx_precursor.tx;
    let old = tx_precursor.extract_gas_price();
    let escalate = |estimate: GasPrice| match super::escalate_gas_price_if_needed(
        &old,
        &estimate,
        transaction_overrides,
    ) {
        GasPrice::None => estimate,
        price => price,
    };

    if let Some(gas_price) = transaction_overrides.gas_price {
        // If the gas price is set, we treat as a non-EIP-1559 chain.
        debug!(
            ?gas_price,
            "Using gas price override for transaction, which assumes a non-EIP-1559 chain",
        );
        return Ok(escalate(GasPrice::NonEip1559 { gas_price }));
    }

    let eip1559_fee_result = estimate_eip1559_fees(provider, None, domain, tx).await;
    let ((base_fee, max_fee, max_priority_fee), _) = match eip1559_fee_result {
        Ok(result) => result,
        Err(err) => {
            warn!(?err, "Failed to estimate EIP-1559 fees");
            // Only use legacy fees when the block confirms that fee model.
            // An RPC failure must not bypass the priority fee ceiling.
            let block = latest_block(provider)
                .await
                .map_err(|_| LanderError::TxSubmissionDeferred)?;
            if block.base_fee_per_gas.is_some_and(|fee| !fee.is_zero()) {
                return Err(LanderError::TxSubmissionDeferred);
            }
            return Ok(escalate(apply_legacy_overrides(
                tx_precursor,
                transaction_overrides,
            )));
        }
    };

    // If the base fee is zero, just treat the chain as a non-EIP-1559 chain.
    // This is useful for BSC, where the base fee is zero, there's a minimum gas price
    // generally enforced by nodes of 3 gwei, but EIP 1559 estimation suggests a priority
    // fee lower than 3 gwei because of privileged transactions being included by block
    // producers that have a lower priority fee.
    if base_fee.is_zero() {
        debug!("Base fee is zero, assuming non-EIP-1559 chain",);
        let gas_price = apply_legacy_overrides(tx_precursor, transaction_overrides);
        return Ok(escalate(gas_price));
    }

    let cap = priority_fee_cap(base_fee, transaction_overrides);
    let (max_fee, max_priority_fee) = cap_priority_fee(max_fee, max_priority_fee, cap);

    // Apply overrides for EIP 1559 tx params if they exist.
    let (max_fee, max_priority_fee) =
        apply_1559_overrides(max_fee, max_priority_fee, transaction_overrides);

    if max_priority_fee > cap {
        return Err(LanderError::TxGasCapReached);
    }
    let price = escalate(GasPrice::Eip1559 {
        max_fee: max_fee.into(),
        max_priority_fee: max_priority_fee.into(),
    });
    if matches!(&price, GasPrice::Eip1559 { max_priority_fee, .. } if *max_priority_fee > cap.into())
    {
        // At the ceiling, rebroadcast unchanged fees; never resend fees above it.
        // Clamping a replacement's tip alone can violate the required fee bump.
        warn!(?cap, ?price, "Priority fee cap prevents escalation");
        return match old {
            GasPrice::Eip1559 {
                max_priority_fee, ..
            } if max_priority_fee <= cap.into() => Ok(old),
            _ => Err(LanderError::TxGasCapReached),
        };
    }
    Ok(price)
}

fn apply_legacy_overrides(
    tx_precursor: &EthereumTxPrecursor,
    transaction_overrides: &TransactionOverrides,
) -> GasPrice {
    let gas_price = tx_precursor.tx.gas_price();
    // if no gas price was set in the tx, leave the tx as is and return early
    let Some(mut gas_price) = gas_price else {
        return GasPrice::None;
    };

    let min_price_override = transaction_overrides
        .min_gas_price
        .map(Into::into)
        .unwrap_or(0.into());
    gas_price = gas_price.max(min_price_override);
    gas_price = apply_gas_price_cap(gas_price, transaction_overrides);

    GasPrice::NonEip1559 {
        gas_price: gas_price.into(),
    }
}

fn apply_1559_overrides(
    max_fee: EthersU256,
    max_priority_fee: EthersU256,
    transaction_overrides: &TransactionOverrides,
) -> (EthersU256, EthersU256) {
    let base_fee_allowance = max_fee.saturating_sub(max_priority_fee);
    let mut max_priority_fee = transaction_overrides
        .max_priority_fee_per_gas
        .map(Into::into)
        .unwrap_or(max_priority_fee);

    if let Some(min_priority_fee) = transaction_overrides.min_priority_fee_per_gas {
        max_priority_fee = max_priority_fee.max(min_priority_fee.into());
    }

    // A tip override must retain the estimated base-fee allowance, particularly
    // when it raises a capped tip. Explicit total-fee settings still take precedence.
    let mut max_fee = transaction_overrides
        .max_fee_per_gas
        .map(Into::into)
        .unwrap_or_else(|| base_fee_allowance.saturating_add(max_priority_fee));
    if let Some(min_fee) = transaction_overrides.min_fee_per_gas {
        max_fee = max_fee.max(min_fee.into());
    }
    max_fee = apply_gas_price_cap(max_fee, transaction_overrides);
    if max_priority_fee > max_fee {
        warn!(
            ?max_fee,
            ?max_priority_fee,
            "Priority fee override exceeds the total fee limit. Capping it to max fee."
        );
    }
    (max_fee, max_priority_fee.min(max_fee))
}

fn apply_gas_price_cap(
    gas_price: EthersU256,
    transaction_overrides: &TransactionOverrides,
) -> EthersU256 {
    if let Some(gas_price_cap) = transaction_overrides.gas_price_cap {
        if gas_price > gas_price_cap.into() {
            warn!(
                ?gas_price,
                ?gas_price_cap,
                "Gas price for transaction is higher than the gas price cap. Capping it to the gas price cap."
            );
            return gas_price_cap.into();
        }
    }
    gas_price
}

/// Use this to estimate EIP 1559 fees with some chain-specific logic.
pub(crate) async fn estimate_eip1559_fees(
    provider: &Arc<dyn EvmProviderForLander>,
    estimator: Option<FeeEstimator>,
    domain: &HyperlaneDomain,
    tx: &TypedTransaction,
) -> ChainResult<(Eip1559Fee, Block<TxHash>)> {
    if domain.is_zksync_stack() {
        estimate_eip1559_fees_zksync(provider, tx).await
    } else {
        estimate_eip1559_fees_default(provider, estimator).await
    }
}

async fn estimate_eip1559_fees_zksync(
    provider: &Arc<dyn EvmProviderForLander>,
    tx: &TypedTransaction,
) -> ChainResult<(Eip1559Fee, Block<TxHash>)> {
    let latest_block = latest_block(provider).await?;

    let base_fee_per_gas = latest_block
        .base_fee_per_gas
        .ok_or_else(|| ProviderError::CustomError("EIP-1559 not activated".into()))?;

    let response = zksync_estimate_fee(provider, tx).await?;
    let max_fee_per_gas = response.max_fee_per_gas;
    let max_priority_fee_per_gas = response.max_priority_fee_per_gas;

    Ok((
        (base_fee_per_gas, max_fee_per_gas, max_priority_fee_per_gas),
        latest_block,
    ))
}

async fn zksync_estimate_fee(
    provider: &Arc<dyn EvmProviderForLander>,
    tx: &TypedTransaction,
) -> ChainResult<ZksyncEstimateFeeResponse> {
    let mut tx = tx.clone();

    // use the sender in the provider if one is set, otherwise default to the EVM relayer address
    let signer = match provider.get_signer() {
        Some(s) => s,
        None => H160::from_str(EVM_RELAYER_ADDRESS)
            .map_err(|err| ChainCommunicationError::CustomError(err.to_string()))?,
    };
    tx.set_from(signer);

    let result = provider.zk_estimate_fee(&tx).await?;
    Ok(result)
}

/// Logic for a vanilla EVM chain to get EIP-1559 fees.
/// Pretty much a copy of the logic in ethers-rs (https://github.com/hyperlane-xyz/ethers-rs/blob/c9ced035628da59376c369be035facda1648577a/ethers-providers/src/provider.rs#L478)
/// but returns the base fee as well as the max fee and max priority fee.
/// Gets a heuristic recommendation of max fee per gas and max priority fee per gas for
/// EIP-1559 compatible transactions.
async fn estimate_eip1559_fees_default(
    provider: &Arc<dyn EvmProviderForLander>,
    estimator: Option<FeeEstimator>,
) -> ChainResult<((EthersU256, EthersU256, EthersU256), Block<TxHash>)> {
    let latest_block = latest_block(provider);

    let fee_history = provider.fee_history(
        EIP1559_FEE_ESTIMATION_PAST_BLOCKS.into(),
        BlockNumber::Latest,
        &[EIP1559_FEE_ESTIMATION_REWARD_PERCENTILE],
    );

    let (latest_block, fee_history) = try_join!(latest_block, fee_history)?;

    let fee_history = ensure_non_empty_rewards(provider, fee_history).await?;

    let base_fee_per_gas = latest_block
        .base_fee_per_gas
        .ok_or_else(|| ProviderError::CustomError("EIP-1559 not activated".into()))?;

    // use the provided fee estimator function, or fallback to the default implementation.
    let (max_fee_per_gas, max_priority_fee_per_gas) = if let Some(es) = estimator {
        es(base_fee_per_gas, fee_history.reward)
    } else {
        eip1559_default_estimator(base_fee_per_gas, fee_history.reward)
    };

    Ok((
        (base_fee_per_gas, max_fee_per_gas, max_priority_fee_per_gas),
        latest_block,
    ))
}

fn priority_fee_cap(base_fee: EthersU256, overrides: &TransactionOverrides) -> EthersU256 {
    overrides
        .priority_fee_cap
        .map(Into::into)
        .unwrap_or_else(|| {
            base_fee
                .saturating_mul(MAX_PRIORITY_FEE_BASE_FEE_MULTIPLIER.into())
                .max(MAX_PRIORITY_FEE_FLOOR_WEI.into())
        })
}

/// Caps the estimated tip while retaining the estimated base-fee allowance.
/// The max fee is reduced by the same amount, since the estimator computes it as
/// surged base fee + priority fee.
fn cap_priority_fee(
    max_fee: EthersU256,
    max_priority_fee: EthersU256,
    cap: EthersU256,
) -> (EthersU256, EthersU256) {
    if max_priority_fee <= cap {
        return (max_fee, max_priority_fee);
    }

    let capped_max_fee = max_fee.saturating_sub(max_priority_fee.saturating_sub(cap));
    warn!(
        ?max_fee,
        ?max_priority_fee,
        ?capped_max_fee,
        capped_max_priority_fee = ?cap,
        "Estimated priority fee is above the cap. Capping it."
    );
    (capped_max_fee, cap)
}

async fn latest_block(provider: &Arc<dyn EvmProviderForLander>) -> ChainResult<Block<TxHash>> {
    let latest_block = provider
        .get_block(BlockNumber::Latest)
        .await
        .map_err(ChainCommunicationError::from_other)?
        .ok_or_else(|| ProviderError::CustomError("Latest block not found".into()))?;
    Ok(latest_block)
}

async fn ensure_non_empty_rewards(
    provider: &Arc<dyn EvmProviderForLander>,
    default_fee_history: FeeHistory,
) -> ChainResult<FeeHistory> {
    if has_rewards(&default_fee_history) {
        debug!(?default_fee_history, "default rewards non zero");
        return Ok(default_fee_history);
    }

    let fee_history_futures = FALLBACK_REWARD_PERCENTILES
        .into_iter()
        .map(|p| {
            let provider = provider.clone();
            async move {
                provider
                    .fee_history(
                        EIP1559_FEE_ESTIMATION_PAST_BLOCKS.into(),
                        BlockNumber::Latest,
                        &[p],
                    )
                    .await
                    .map_err(ChainCommunicationError::from_other)
            }
        })
        .collect::<Vec<_>>();

    // Results will be ordered by percentile, so we can just take the first non-empty one.
    let fee_histories = join_all(fee_history_futures).await;

    debug!(
        ?fee_histories,
        ?FALLBACK_REWARD_PERCENTILES,
        "fee history for each percentile"
    );

    // We return the first non-empty fee history.
    // If all are empty, we return the default fee history which is empty at this point.
    let mut chosen_fee_history = default_fee_history;
    for fee_history in fee_histories {
        let Ok(fee_history) = fee_history else {
            continue;
        };
        if has_rewards(&fee_history) {
            chosen_fee_history = fee_history;
            break;
        }
    }

    debug!(?chosen_fee_history, "chosen fee history");

    Ok(chosen_fee_history)
}

fn has_rewards(fee_history: &FeeHistory) -> bool {
    fee_history
        .reward
        .iter()
        .filter_map(|r| r.first())
        .any(|r| !r.is_zero())
}

#[cfg(test)]
mod tests {
    use hyperlane_core::{
        HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack, KnownHyperlaneDomain,
    };

    use crate::adapter::chains::ethereum::tests::{
        dummy_tx_precursor, ExpectedTxType, MockEvmProvider,
    };

    use super::*;

    const GWEI: u64 = 1_000_000_000;

    fn gwei_milli(milli_gwei: u64) -> EthersU256 {
        EthersU256::from(milli_gwei) * EthersU256::from(GWEI / 1000)
    }

    #[tokio::test]
    async fn test_fee_history_failure_defers_instead_of_reusing_stored_fees() {
        let mut provider = MockEvmProvider::new();
        provider.expect_get_block().returning(|_| {
            Ok(Some(Block {
                base_fee_per_gas: Some(1.into()),
                ..Default::default()
            }))
        });
        provider.expect_fee_history().returning(|_, _, _| {
            Err(ChainCommunicationError::CustomError(
                "RPC unavailable".into(),
            ))
        });
        let provider: Arc<dyn EvmProviderForLander> = Arc::new(provider);
        let mut precursor = dummy_tx_precursor(ExpectedTxType::Eip1559, H160::zero());
        precursor.tx.set_gas_price(gwei_milli(100_000));
        assert!(matches!(
            estimate_gas_price(
                &provider,
                &precursor,
                &TransactionOverrides::default(),
                &KnownHyperlaneDomain::Ethereum.into()
            )
            .await,
            Err(LanderError::TxSubmissionDeferred)
        ));
    }

    #[tokio::test]
    async fn test_zksync_uses_shared_priority_cap() {
        for custom_cap in [None, Some(20 * GWEI)] {
            let mut provider = MockEvmProvider::new();
            provider.expect_get_block().once().returning(|_| {
                Ok(Some(Block {
                    base_fee_per_gas: Some(GWEI.into()),
                    ..Default::default()
                }))
            });
            provider.expect_get_signer().returning(|| None);
            provider.expect_zk_estimate_fee().once().returning(|_| {
                Ok(ZksyncEstimateFeeResponse {
                    gas_limit: 21_000.into(),
                    gas_per_pubdata_limit: 800.into(),
                    max_fee_per_gas: (102 * GWEI).into(),
                    max_priority_fee_per_gas: (100 * GWEI).into(),
                })
            });
            let provider: Arc<dyn EvmProviderForLander> = Arc::new(provider);
            let domain = HyperlaneDomain::from_config(
                999_999,
                "testzksync",
                HyperlaneDomainProtocol::Ethereum,
                HyperlaneDomainTechnicalStack::ZkSync,
            )
            .unwrap();
            let precursor = dummy_tx_precursor(ExpectedTxType::Eip1559, H160::zero());
            let overrides = TransactionOverrides {
                priority_fee_cap: custom_cap.map(Into::into),
                ..Default::default()
            };
            let result = estimate_gas_price(&provider, &precursor, &overrides, &domain)
                .await
                .unwrap();
            let cap = custom_cap.unwrap_or(5 * GWEI);
            assert_eq!(
                result,
                GasPrice::Eip1559 {
                    max_fee: (2 * GWEI + cap).into(),
                    max_priority_fee: cap.into()
                }
            );
        }
    }

    async fn estimate_with_rewards(
        domain: &HyperlaneDomain,
        base_fee: EthersU256,
        reward: EthersU256,
        use_median_fallback: bool,
        overrides: &TransactionOverrides,
    ) -> GasPrice {
        let mut provider = MockEvmProvider::new();
        provider.expect_get_block().once().returning(move |_| {
            Ok(Some(Block {
                base_fee_per_gas: Some(base_fee),
                ..Default::default()
            }))
        });
        let percentiles = if use_median_fallback {
            vec![5.0, 10.0, 15.0, 20.0, 50.0]
        } else {
            vec![5.0]
        };
        for percentile in percentiles {
            let reward = if use_median_fallback && percentile < 50.0 {
                EthersU256::zero()
            } else {
                reward
            };
            provider
                .expect_fee_history()
                .once()
                .withf(move |_, _, percentiles| percentiles == [percentile])
                .returning(move |_, _, _| {
                    Ok(FeeHistory {
                        oldest_block: 0.into(),
                        reward: vec![vec![reward]; 10],
                        base_fee_per_gas: vec![base_fee; 11],
                        gas_used_ratio: vec![0.5; 10],
                    })
                });
        }
        let provider: Arc<dyn EvmProviderForLander> = Arc::new(provider);
        let precursor = dummy_tx_precursor(ExpectedTxType::Eip1559, H160::zero());
        estimate_gas_price(&provider, &precursor, overrides, domain)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn test_zero_low_percentiles_use_median_on_all_chains() {
        for (domain, tip) in [
            (KnownHyperlaneDomain::Ethereum, 2_000),
            (KnownHyperlaneDomain::Polygon, 2_000),
            (KnownHyperlaneDomain::Sepolia, 2_000),
        ] {
            // The mock expects p5/p10/p15/p20 to return zero and p50 to supply
            // the ordinary tip. Any p100 request fails the test.
            let estimate = estimate_with_rewards(
                &domain.into(),
                gwei_milli(1_000),
                gwei_milli(tip),
                true,
                &TransactionOverrides::default(),
            )
            .await;
            assert_eq!(
                estimate,
                GasPrice::Eip1559 {
                    max_fee: gwei_milli(2_000 + tip).into(),
                    max_priority_fee: gwei_milli(tip).into(),
                }
            );
        }
    }

    #[tokio::test]
    async fn test_ethereum_outlier_rewards_are_capped() {
        let overrides = TransactionOverrides::default();
        for use_median_fallback in [false, true] {
            let estimate = estimate_with_rewards(
                &KnownHyperlaneDomain::Ethereum.into(),
                gwei_milli(470),
                gwei_milli(4_146_000),
                use_median_fallback,
                &overrides,
            )
            .await;
            assert_eq!(
                estimate,
                GasPrice::Eip1559 {
                    max_fee: gwei_milli(5_940).into(),
                    max_priority_fee: gwei_milli(5_000).into(),
                }
            );
        }
    }

    #[tokio::test]
    async fn test_ethereum_cap_does_not_raise_low_or_zero_rewards() {
        for (reward, expected_tip) in [(0, 100_000), (2_000, 2 * GWEI), (5_000, 5 * GWEI)] {
            let estimate = estimate_with_rewards(
                &KnownHyperlaneDomain::Ethereum.into(),
                gwei_milli(1_000),
                gwei_milli(reward),
                reward == 0,
                &TransactionOverrides::default(),
            )
            .await;
            assert_eq!(
                estimate,
                GasPrice::Eip1559 {
                    max_fee: (EthersU256::from(2 * GWEI) + expected_tip).into(),
                    max_priority_fee: expected_tip.into(),
                }
            );
        }
    }

    #[tokio::test]
    async fn test_all_chains_use_default_or_custom_priority_cap() {
        use KnownHyperlaneDomain::{Ethereum, Polygon};

        let flare = HyperlaneDomain::from_config(
            14,
            "flare",
            HyperlaneDomainProtocol::Ethereum,
            HyperlaneDomainTechnicalStack::Other,
        )
        .unwrap();
        for (domain, base_fee, tip, custom_cap, expected_tip) in [
            (Polygon.into(), 1_000, 25_000, None, 5_000),
            (Polygon.into(), 1_000, 300_000, Some(250_000), 250_000),
            (Polygon.into(), 100_000, 300_000, Some(250_000), 250_000),
            (flare.clone(), 500_000, 1_500_000, None, 1_500_000),
            (flare, 1_000, 1_500_000, None, 5_000),
            (Ethereum.into(), 10_000, 100_000, Some(2_000), 2_000),
            (Ethereum.into(), 1_000, 2_000, Some(0), 0),
        ] {
            let overrides = TransactionOverrides {
                priority_fee_cap: custom_cap.map(|cap| gwei_milli(cap).into()),
                ..Default::default()
            };
            for use_median_fallback in [false, true] {
                let estimate = estimate_with_rewards(
                    &domain,
                    gwei_milli(base_fee),
                    gwei_milli(tip),
                    use_median_fallback,
                    &overrides,
                )
                .await;
                assert_eq!(
                    estimate,
                    GasPrice::Eip1559 {
                        max_fee: gwei_milli(base_fee * 2 + expected_tip).into(),
                        max_priority_fee: gwei_milli(expected_tip).into(),
                    }
                );
            }
        }
    }

    #[tokio::test]
    async fn test_priority_overrides_preserve_base_fee_headroom_after_capping() {
        for (overrides, expected_tip) in [
            (
                TransactionOverrides {
                    min_priority_fee_per_gas: Some(gwei_milli(25_000).into()),
                    priority_fee_cap: Some(gwei_milli(25_000).into()),
                    ..Default::default()
                },
                25_000,
            ),
            (
                TransactionOverrides {
                    max_priority_fee_per_gas: Some(gwei_milli(25_000).into()),
                    priority_fee_cap: Some(gwei_milli(25_000).into()),
                    ..Default::default()
                },
                25_000,
            ),
            (
                TransactionOverrides {
                    max_priority_fee_per_gas: Some(gwei_milli(1_000).into()),
                    ..Default::default()
                },
                1_000,
            ),
            (
                TransactionOverrides {
                    min_priority_fee_per_gas: Some(gwei_milli(1_000).into()),
                    ..Default::default()
                },
                5_000,
            ),
        ] {
            let estimate = estimate_with_rewards(
                &KnownHyperlaneDomain::Ethereum.into(),
                gwei_milli(1_000),
                gwei_milli(4_146_000),
                true,
                &overrides,
            )
            .await;
            assert_eq!(
                estimate,
                GasPrice::Eip1559 {
                    max_fee: gwei_milli(2_000 + expected_tip).into(),
                    max_priority_fee: gwei_milli(expected_tip).into(),
                }
            );
        }
    }

    #[test]
    fn test_priority_overrides_respect_explicit_total_fee_limits() {
        for overrides in [
            TransactionOverrides {
                min_priority_fee_per_gas: Some(gwei_milli(25_000).into()),
                max_fee_per_gas: Some(gwei_milli(7_000).into()),
                ..Default::default()
            },
            TransactionOverrides {
                min_priority_fee_per_gas: Some(gwei_milli(25_000).into()),
                gas_price_cap: Some(gwei_milli(7_000).into()),
                ..Default::default()
            },
        ] {
            assert_eq!(
                apply_1559_overrides(gwei_milli(7_000), gwei_milli(5_000), &overrides),
                (gwei_milli(7_000), gwei_milli(7_000))
            );
        }
    }

    #[test]
    fn test_priority_override_does_not_overflow_total_fee() {
        let overrides = TransactionOverrides {
            min_priority_fee_per_gas: Some(U256::MAX),
            ..Default::default()
        };
        assert_eq!(
            apply_1559_overrides(gwei_milli(7_000), gwei_milli(5_000), &overrides),
            (EthersU256::MAX, EthersU256::MAX)
        );
    }

    #[test]
    fn test_cap_priority_fee_outlier_tip_on_low_base_fee() {
        // Ethereum incident: 0.47 gwei base fee, 4146 gwei estimated tip
        let base_fee = gwei_milli(470);
        let priority_fee = gwei_milli(4_146_000);
        let max_fee = base_fee * 2 + priority_fee;

        let (capped_max_fee, capped_priority_fee) = cap_priority_fee(
            max_fee,
            priority_fee,
            priority_fee_cap(base_fee, &TransactionOverrides::default()),
        );

        let cap = EthersU256::from(MAX_PRIORITY_FEE_FLOOR_WEI);
        assert_eq!(capped_priority_fee, cap);
        assert_eq!(capped_max_fee, base_fee * 2 + cap);
    }

    #[test]
    fn test_cap_priority_fee_high_tip_relative_to_high_base_fee_unchanged() {
        // Flare-like: 500 gwei base fee, 1500 gwei tip
        let base_fee = gwei_milli(500_000);
        let priority_fee = gwei_milli(1_500_000);
        let max_fee = base_fee * 2 + priority_fee;

        assert_eq!(
            cap_priority_fee(
                max_fee,
                priority_fee,
                priority_fee_cap(base_fee, &TransactionOverrides::default())
            ),
            (max_fee, priority_fee)
        );
    }

    #[test]
    fn test_cap_priority_fee_below_cap_unchanged() {
        let base_fee = gwei_milli(470);
        let priority_fee = gwei_milli(2_000);
        let max_fee = base_fee * 2 + priority_fee;

        assert_eq!(
            cap_priority_fee(
                max_fee,
                priority_fee,
                priority_fee_cap(base_fee, &TransactionOverrides::default())
            ),
            (max_fee, priority_fee)
        );
    }

    #[test]
    fn test_cap_priority_fee_relative_cap() {
        let base_fee = gwei_milli(10_000);
        let priority_fee = gwei_milli(100_000);
        let max_fee = base_fee * 2 + priority_fee;

        let (capped_max_fee, capped_priority_fee) = cap_priority_fee(
            max_fee,
            priority_fee,
            priority_fee_cap(base_fee, &TransactionOverrides::default()),
        );

        let cap = base_fee * MAX_PRIORITY_FEE_BASE_FEE_MULTIPLIER;
        assert_eq!(capped_priority_fee, cap);
        assert_eq!(capped_max_fee, base_fee * 2 + cap);
    }

    #[test]
    fn test_cap_priority_fee_huge_base_fee_no_overflow() {
        let base_fee = EthersU256::MAX;
        let priority_fee = EthersU256::MAX;
        let max_fee = EthersU256::MAX;

        assert_eq!(
            cap_priority_fee(
                max_fee,
                priority_fee,
                priority_fee_cap(base_fee, &TransactionOverrides::default())
            ),
            (max_fee, priority_fee)
        );
    }
}
