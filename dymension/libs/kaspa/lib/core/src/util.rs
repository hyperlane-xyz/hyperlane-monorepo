use hyperlane_core::H256;
use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::hashing::sighash_type::{
    SigHashType, SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY,
};
use kaspa_consensus_core::tx::ScriptPublicKey;
use kaspa_txscript::pay_to_address_script;
use std::collections::HashSet;
use std::hash::Hash;

pub fn get_recipient_address(recipient: H256, prefix: Prefix) -> Address {
    Address::new(
        prefix,
        Version::PubKey, // should always be PubKey
        recipient.as_bytes(),
    )
}

pub fn get_recipient_script_pubkey(recipient: H256, prefix: Prefix) -> ScriptPublicKey {
    ScriptPublicKey::from(pay_to_address_script(&get_recipient_address(
        recipient, prefix,
    )))
}

pub fn get_recipient_script_pubkey_address(address: &Address) -> ScriptPublicKey {
    ScriptPublicKey::from(pay_to_address_script(address))
}

pub fn input_sighash_type() -> SigHashType {
    SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap()
}

pub fn check_sighash_type(t: SigHashType) -> bool {
    t.is_sighash_all() && t.is_sighash_anyone_can_pay()
}

/// Find the first duplicate if any.
pub fn find_duplicate<T>(v: &[T]) -> Option<T>
where
    T: Eq + Hash + Clone,
{
    let mut seen = HashSet::new();
    v.iter().find(|&item| !seen.insert(item)).cloned()
}

/// Refactored copy
/// https://github.com/kaspanet/rusty-kaspa/blob/v1.0.0/wallet/core/src/storage/transaction/record.rs
pub mod maturity {
    use eyre::Result;
    use kaspa_consensus_core::network::NetworkId;
    use kaspa_wallet_core::prelude::DynRpcApi;
    use kaspa_wallet_core::utxo::NetworkParams;
    use std::sync::Arc;

    pub async fn validate_maturity(
        client: &Arc<DynRpcApi>,
        block_daa_score: u64,
        network_id: NetworkId,
    ) -> Result<bool> {
        let dag_info = client
            .get_block_dag_info()
            .await
            .map_err(|e| eyre::eyre!("Get block DAG info: {}", e))?;

        Ok(is_mature(
            block_daa_score,
            dag_info.virtual_daa_score,
            network_id,
        ))
    }

    pub fn is_mature(block_daa_score: u64, current_daa_score: u64, network_id: NetworkId) -> bool {
        let params = NetworkParams::from(network_id);
        let maturity = params.user_transaction_maturity_period_daa();

        current_daa_score >= block_daa_score + maturity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_input_sighash_type() {
        assert!(check_sighash_type(input_sighash_type()));
    }
}
