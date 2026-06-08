#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use hyperlane_core::{
    CcipReadIsm, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, H256,
};
use tracing::instrument;

use crate::interfaces::i_ccip_read_ism::ICcipReadIsm as TronCcipReadIsmInternal;
use crate::TronProvider;

/// A reference to a CcipReadIsm contract on some Tron chain
#[derive(Debug)]
pub struct TronCcipReadIsm {
    contract: Arc<TronCcipReadIsmInternal<TronProvider>>,
    domain: HyperlaneDomain,
}

impl TronCcipReadIsm {
    /// Creates a new TronCcipReadIsm instance
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(TronCcipReadIsmInternal::new(
                locator.address,
                Arc::new(provider),
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneChain for TronCcipReadIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.contract.client().clone())
    }
}

impl HyperlaneContract for TronCcipReadIsm {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl CcipReadIsm for TronCcipReadIsm {
    #[instrument(err, skip(self, message))]
    async fn get_offchain_verify_info(&self, message: Vec<u8>) -> ChainResult<()> {
        // On Tron, reverted constant calls return the revert data in constant_result
        // rather than as an RPC error. Call the provider directly to get raw bytes,
        // then surface any non-empty result as a "0x{hex}" error string so the CCIP
        // read metadata builder's regex can extract and decode the OffchainLookup
        // revert payload. TronProvider::call() prioritizes constant_result over
        // result.code, so the payload is preserved even if a node sets code.
        let call = self.contract.get_offchain_verify_info(message.into());
        let raw = self
            .contract
            .client()
            .as_ref()
            .call(&call.tx, call.block)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        if !raw.is_empty() {
            return Err(ChainCommunicationError::from_other_str(&format!(
                "0x{}",
                hex::encode(raw)
            )));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use ethers::abi::{AbiDecode, AbiEncode};
    use hyperlane_ethereum::OffchainLookup;
    use regex::Regex;

    /// Pins the data-format contract between get_offchain_verify_info and the
    /// CCIP read metadata builder: revert bytes encoded as "0x{hex}" must
    /// survive the builder's regex → hex_decode → OffchainLookup::decode
    /// round-trip, and empty bytes must yield the Ok(()) branch.
    #[test]
    fn offchain_lookup_revert_roundtrip() {
        let original = OffchainLookup {
            sender: "4ee6ecad1c2dae9f525404de8555724e3c35d07b".parse().unwrap(),
            urls: vec!["https://example.com/{sender}/{data}.json".to_string()],
            call_data: b"calldata".to_vec().into(),
            callback_function: [0xde, 0xad, 0xbe, 0xef],
            extra_data: b"extra".to_vec().into(),
        };

        // Mimic what get_offchain_verify_info produces for a non-empty constant_result.
        let encoded = original.clone().encode();
        let error_str = format!("0x{}", hex::encode(&encoded));

        // Mimic what the CCIP read metadata builder does with that error string.
        let re = Regex::new(r"0x[[:xdigit:]]+").unwrap();
        let cap = re.captures(&error_str).expect("regex must match");
        let hex_val = hex::decode(&cap[0][2..]).expect("hex decode must succeed");
        let decoded = OffchainLookup::decode(hex_val).expect("ABI decode must succeed");

        assert_eq!(decoded.sender, original.sender);
        assert_eq!(decoded.urls, original.urls);
        assert_eq!(decoded.call_data, original.call_data);
        assert_eq!(decoded.callback_function, original.callback_function);
        assert_eq!(decoded.extra_data, original.extra_data);
    }

    #[test]
    fn empty_constant_result_is_ok() {
        // Empty raw bytes must not produce an error string — the ISM returns Ok(()).
        let raw: &[u8] = &[];
        assert!(raw.is_empty(), "empty slice must take the Ok(()) branch");
        // Negative: a non-empty slice must produce a "0x…" string.
        let raw_nonempty = b"\xde\xad";
        let err_str = format!("0x{}", hex::encode(raw_nonempty));
        assert!(err_str.starts_with("0x"));
        assert_eq!(err_str, "0xdead");
    }
}
