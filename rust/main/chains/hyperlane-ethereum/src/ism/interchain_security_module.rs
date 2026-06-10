#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use ethers_core::abi::ethereum_types::H160;
use tracing::{instrument, warn};

use futures_util::future::{join_all, try_join};
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, Metadata, ModuleType,
    RawHyperlaneMessage, H256, U256,
};
use num_traits::cast::FromPrimitive;

use crate::interfaces::i_aggregation_ism::IAggregationIsm;
use crate::interfaces::i_interchain_security_module::{
    IInterchainSecurityModule as EthereumInterchainSecurityModuleInternal,
    IINTERCHAINSECURITYMODULE_ABI,
};
use crate::interfaces::i_rate_limited_ism::IRateLimitedIsm;
use crate::interfaces::i_routing_ism::IRoutingIsm;
use crate::interfaces::i_trusted_relayer_ism::ITrustedRelayerIsm;
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider};

pub struct InterchainSecurityModuleBuilder {}

#[async_trait]
impl BuildableWithProvider for InterchainSecurityModuleBuilder {
    type Output = Box<dyn InterchainSecurityModule>;
    const NEEDS_SIGNER: bool = true;

    fn uses_ethers_submission_middleware(&self) -> bool {
        false
    }

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInterchainSecurityModule::new(
            Arc::new(provider),
            locator,
        ))
    }
}

/// A reference to an InterchainSecurityModule contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumInterchainSecurityModule<M>
where
    M: Middleware,
{
    contract: Arc<EthereumInterchainSecurityModuleInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumInterchainSecurityModuleInternal::new(
                locator.address,
                provider,
            )),
            domain: locator.domain.clone(),
        }
    }

    async fn dry_run_verify_inner(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
        depth: usize,
    ) -> ChainResult<Option<U256>> {
        if depth == 0 {
            warn!("Max ISM depth reached in dry_run_verify");
            return Ok(None);
        }

        let mut current_address = self.contract.address();

        for _ in 0..MAX_ISM_DEPTH {
            let locator = ContractLocator {
                domain: &self.domain,
                address: current_address.into(),
            };
            let ism = EthereumInterchainSecurityModule::new(self.contract.client(), &locator);

            let mut tx = ism.contract.verify(
                metadata.to_owned().into(),
                RawHyperlaneMessage::from(message).to_vec().into(),
            );
            if self.domain.is_zksync_stack() {
                // We use a random from address to ensure compatibility with zksync,
                // but intentionally do not set this for other chains which may have assumptions
                // around the presence of funds in the from address (which defaults to address(0)).
                // Context here: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/4585
                tx = tx.from(RANDOM_ADDRESS);
            }
            match try_join(tx.call(), tx.estimate_gas()).await {
                Ok((true, gas_estimate)) => return Ok(Some(gas_estimate.into())),
                Ok((false, _)) => {}
                Err(err) => {
                    tracing::debug!(
                        ?err,
                        "verify() dry-run failed; falling through to Null-ISM checks"
                    );
                }
            }

            let module_type = ism.module_type().await?;
            // For Null-typed ISMs (e.g. TrustedRelayerIsm, RateLimitedIsm), verify()
            // returns false or reverts during a dry run because the simulation skips
            // the EFFECTS performed by Mailbox.process() (e.g. _isDelivered) before
            // verify() runs on-chain.
            if module_type == ModuleType::Null {
                // TrustedRelayerIsm: verify() returns false if sender != trusted relayer.
                if let Some(sender) = ism.contract.client().default_sender() {
                    let tr = ITrustedRelayerIsm::new(ism.contract.address(), ism.contract.client());
                    if let Ok(trusted_relayer) = tr.trusted_relayer().call().await {
                        if trusted_relayer == sender {
                            return Ok(Some(U256::zero()));
                        }
                    }
                }
                // RateLimitedIsm: verify() reverts because the mailbox sets delivery
                // state before calling verify() on-chain, but simulation skips that.
                let rate_limited =
                    IRateLimitedIsm::new(ism.contract.address(), ism.contract.client());
                if let Ok(ism_recipient) = rate_limited.recipient().call().await {
                    let msg_recipient =
                        ethers::types::H160::from_slice(&message.recipient.as_bytes()[12..]);
                    if msg_recipient == ism_recipient {
                        let body = message.body.as_slice();
                        if body.len() < 64 {
                            return Ok(None);
                        }
                        let token_amount = ethers::types::U256::from_big_endian(&body[32..64]);
                        let current_level = match rate_limited
                            .calculate_current_level()
                            .call()
                            .await
                        {
                            Ok(v) => v,
                            Err(err) => {
                                tracing::debug!(
                                        ?err,
                                        "calculateCurrentLevel() failed; rate limit may not be configured"
                                    );
                                return Ok(None);
                            }
                        };
                        if token_amount <= current_level {
                            return Ok(Some(U256::zero()));
                        }
                    }
                }
            }

            // For Aggregation ISMs, verify() fails during dry-run when any sub-ISM (e.g.
            // TrustedRelayerIsm) depends on mailbox state set by process() before verify() runs.
            // Recursively check each sub-ISM: if threshold of them pass, the aggregation passes.
            if module_type == ModuleType::Aggregation {
                let aggregation =
                    IAggregationIsm::new(ism.contract.address(), ism.contract.client());
                let raw_msg: ethers::types::Bytes =
                    RawHyperlaneMessage::from(message).to_vec().into();
                if let Ok((sub_addrs, thresh)) =
                    aggregation.modules_and_threshold(raw_msg).call().await
                {
                    let threshold = thresh as usize;
                    let sub_isps: Vec<_> = sub_addrs
                        .into_iter()
                        .map(|addr| {
                            let sub_locator = ContractLocator {
                                domain: &self.domain,
                                address: addr.into(),
                            };
                            EthereumInterchainSecurityModule::new(
                                self.contract.client(),
                                &sub_locator,
                            )
                        })
                        .collect();
                    let sub_results = join_all(sub_isps.iter().enumerate().map(|(i, s)| {
                        let sub_metadata = aggregation_sub_metadata(metadata, i)
                            .unwrap_or_else(|| Metadata::new(vec![]));
                        async move {
                            s.dry_run_verify_inner(message, &sub_metadata, depth.saturating_sub(1))
                                .await
                        }
                    }))
                    .await;
                    let valid_count = sub_results
                        .iter()
                        .filter(|r| matches!(r, Ok(Some(_))))
                        .count();
                    if valid_count >= threshold {
                        return Ok(Some(U256::zero()));
                    }
                }
            }

            // If verify() returned false above, the routed sub-ISM may be a Null/TrustedRelayer ISM
            // whose verify depends on mailbox state set during process(). Iterate to discover it.
            if module_type == ModuleType::Routing {
                let routing = IRoutingIsm::new(ism.contract.address(), ism.contract.client());
                let raw_message: ethers::types::Bytes =
                    RawHyperlaneMessage::from(message).to_vec().into();
                match routing.route(raw_message).call().await {
                    Ok(routed_address) => {
                        current_address = routed_address;
                        continue;
                    }
                    Err(err) => {
                        warn!(?err, ism = %ism.contract.address(), "routing ISM dry-run failed");
                    }
                }
            }

            return Ok(None);
        }

        warn!(
            max_depth = MAX_ISM_DEPTH,
            "Max ISM depth reached in dry_run_verify"
        );
        Ok(None)
    }
}

impl<M> HyperlaneChain for EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.contract.client(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

// The address 0x69BE704F62F7CbC1a30E35E0153D89e2b0A6Aa55 as a byte array.
// This address was randomly generated in order to estimate gas better than
// using a fixed address like repeating the 0xab byte, as required by ZkSync chains.
// This is due to some compression optimizations that ZkSync does when an address is low entropy.
const RANDOM_ADDRESS: H160 = H160([
    0x69, 0xBE, 0x70, 0x4F, 0x62, 0xF7, 0xCB, 0xC1, 0xA3, 0x0E, 0x35, 0xE0, 0x15, 0x3D, 0x89, 0xE2,
    0xB0, 0xA6, 0xAA, 0x55,
]);

// Caps both routing hops per level and aggregation nesting depth, preventing
// multiplicative fan-out from nested AggregationISMs and cycles.
const MAX_ISM_DEPTH: usize = 10;

// Byte width of each range field in AggregationIsmMetadata: (start: u32, end: u32) per sub-ISM.
const AGGREGATION_RANGE_SIZE: usize = 4;

/// Extracts the per-sub-ISM metadata slice from a packed AggregationIsmMetadata blob.
/// Format: [index * 8 .. index * 8 + 8] holds (start: u32, end: u32) big-endian.
/// When start == 0 the sub-ISM has no metadata; returns None in that case.
fn aggregation_sub_metadata(metadata: &Metadata, index: usize) -> Option<Metadata> {
    let bytes = metadata.as_ref();
    let range_start = index
        .saturating_mul(AGGREGATION_RANGE_SIZE)
        .saturating_mul(2);
    let range_mid = range_start.saturating_add(AGGREGATION_RANGE_SIZE);
    let range_end = range_mid.saturating_add(AGGREGATION_RANGE_SIZE);
    if bytes.len() < range_end {
        return None;
    }
    let start = u32::from_be_bytes(bytes[range_start..range_mid].try_into().ok()?) as usize;
    let end = u32::from_be_bytes(bytes[range_mid..range_end].try_into().ok()?) as usize;
    if start == 0 || end > bytes.len() || start > end {
        return None;
    }
    Some(Metadata::new(bytes[start..end].to_vec()))
}

#[async_trait]
impl<M> InterchainSecurityModule for EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    #[instrument]
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let module = self.contract.module_type().call().await?;
        if let Some(module_type) = ModuleType::from_u8(module) {
            Ok(module_type)
        } else {
            warn!(%module, "Unknown module type");
            Ok(ModuleType::Unused)
        }
    }

    #[instrument]
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
    ) -> ChainResult<Option<U256>> {
        self.dry_run_verify_inner(message, metadata, MAX_ISM_DEPTH)
            .await
    }
}

pub struct EthereumInterchainSecurityModuleAbi;

impl HyperlaneAbi for EthereumInterchainSecurityModuleAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IINTERCHAINSECURITYMODULE_ABI)
    }
}
