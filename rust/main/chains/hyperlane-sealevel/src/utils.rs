use std::str::FromStr;

use solana_sdk::pubkey::Pubkey;
use solana_sdk::{bs58, instruction::AccountMeta};

use hyperlane_core::{ChainCommunicationError, ChainResult, H256, H512};

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

/// Sanitizes untrusted dynamic account metas.
/// Requires that:
/// - All provided account metas are non-signers (these are made non-signers even if they're requested)
/// - The payer account is not present in the provided account metas (this is a failure condition)
pub fn sanitize_dynamic_accounts(
    mut account_metas: Vec<AccountMeta>,
    payer: &Pubkey,
) -> ChainResult<Vec<AccountMeta>> {
    account_metas.iter_mut().for_each(|meta| {
        if meta.is_signer {
            tracing::warn!(meta = ?meta, "Forcing account meta to be non-signer");
            meta.is_signer = false
        }
    });

    // On SVM, if an instruction specifies the same account twice, if one of them is a signer
    // then the SVM ends up treating the other as a signer as well, even if the other AccountMeta
    // didn't ask for it!
    // This means that if one of the dynamic account metas includes the payer, the
    // CPI made into the program will end up providing the payer account as a signer.
    if account_metas.iter().any(|meta| meta.pubkey == *payer) {
        return Err(ChainCommunicationError::from_other_str(
            "Dynamic account metas contain payer account",
        ));
    }

    Ok(account_metas)
}

#[cfg(test)]
mod test {
    use solana_sdk::pubkey::Pubkey;

    use crate::utils::sanitize_dynamic_accounts;

    #[test]
    fn test_sanitize_dynamic_accounts_forces_non_signer() {
        use solana_sdk::instruction::AccountMeta;

        let account_metas = vec![
            AccountMeta::new_readonly([0u8; 32].into(), false),
            AccountMeta::new_readonly([1u8; 32].into(), true),
            AccountMeta::new([2u8; 32].into(), true),
        ];

        let account_metas =
            sanitize_dynamic_accounts(account_metas.clone(), &Pubkey::new_unique()).unwrap();

        assert_eq!(
            account_metas,
            vec![
                AccountMeta::new_readonly([0u8; 32].into(), false),
                AccountMeta::new_readonly([1u8; 32].into(), false),
                AccountMeta::new([2u8; 32].into(), false),
            ]
        )
    }

    #[test]
    fn test_sanitize_dynamic_accounts_requires_non_payer() {
        use solana_sdk::instruction::AccountMeta;

        let payer = Pubkey::new_unique();

        let account_metas = vec![
            AccountMeta::new_readonly([0u8; 32].into(), false),
            AccountMeta::new_readonly([1u8; 32].into(), true),
            AccountMeta::new(payer, true),
        ];

        assert!(sanitize_dynamic_accounts(account_metas, &payer).is_err());
    }
}
