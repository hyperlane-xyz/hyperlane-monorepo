use std::str::FromStr;

use solana_sdk::pubkey::Pubkey;
use solana_sdk::{bs58, instruction::AccountMeta};

use hyperlane_core::{H256, H512};

use crate::error::HyperlaneSealevelError;

pub fn from_base58(base58: &str) -> Result<Vec<u8>, HyperlaneSealevelError> {
    let binary = bs58::decode(base58)
        .into_vec()
        .map_err(HyperlaneSealevelError::Decoding)?;
    Ok(binary)
}

pub fn decode_h256(base58: &str) -> Result<H256, HyperlaneSealevelError> {
    let binary = from_base58(base58)?;
    let hash = H256::from_slice(&binary);

    Ok(hash)
}

pub fn decode_h512(base58: &str) -> Result<H512, HyperlaneSealevelError> {
    let binary = from_base58(base58)?;
    let hash = H512::from_slice(&binary);

    Ok(hash)
}

pub fn decode_pubkey(address: &str) -> Result<Pubkey, HyperlaneSealevelError> {
    Pubkey::from_str(address).map_err(Into::<HyperlaneSealevelError>::into)
}

/// Force all provided account metas to be non-signers
pub fn force_non_signers(mut account_metas: Vec<AccountMeta>) -> Vec<AccountMeta> {
    account_metas.iter_mut().for_each(|meta| {
        if meta.is_signer {
            tracing::warn!(meta = ?meta, "Forcing account meta to be non-signer");
            meta.is_signer = false
        }
    });

    account_metas
}

#[cfg(test)]
mod test {
    use crate::utils::force_non_signers;

    #[test]
    fn test_force_non_signers() {
        use solana_sdk::instruction::AccountMeta;

        let account_metas = vec![
            AccountMeta::new_readonly([0u8; 32].into(), false),
            AccountMeta::new_readonly([1u8; 32].into(), true),
            AccountMeta::new([2u8; 32].into(), true),
        ];

        let account_metas = force_non_signers(account_metas.clone());

        assert_eq!(
            account_metas,
            vec![
                AccountMeta::new_readonly([0u8; 32].into(), false),
                AccountMeta::new_readonly([1u8; 32].into(), false),
                AccountMeta::new([2u8; 32].into(), false),
            ]
        )
    }
}
