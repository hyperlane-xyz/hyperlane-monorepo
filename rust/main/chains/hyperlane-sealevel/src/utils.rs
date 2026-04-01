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
/// - All provided account metas are non-signers, except optionally the `identity` account which
///   is explicitly trusted as a signer (e.g. for TrustedRelayer ISMs)
/// - The payer account is not present in the provided account metas (this is a failure condition)
///
/// `identity` must differ from `payer` (the caller is responsible for ensuring this).
pub fn sanitize_dynamic_accounts(
    mut account_metas: Vec<AccountMeta>,
    payer: &Pubkey,
    identity: Option<&Pubkey>,
) -> ChainResult<Vec<AccountMeta>> {
    // Force all accounts to non-signer, except the explicitly trusted identity.
    account_metas.iter_mut().for_each(|meta| {
        let is_identity = identity.is_some_and(|id| meta.pubkey == *id);
        if meta.is_signer && !is_identity {
            tracing::warn!(meta = ?meta, "Forcing account meta to be non-signer");
            meta.is_signer = false;
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
            sanitize_dynamic_accounts(account_metas.clone(), &Pubkey::new_unique(), None).unwrap();

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

        assert!(sanitize_dynamic_accounts(account_metas, &payer, None).is_err());
    }

    #[test]
    fn test_sanitize_dynamic_accounts_preserves_identity_signer() {
        use solana_sdk::instruction::AccountMeta;

        let payer = Pubkey::new_unique();
        let identity = Pubkey::new_unique();

        let account_metas = vec![
            AccountMeta::new_readonly([0u8; 32].into(), true),
            AccountMeta::new_readonly(identity, true),
        ];

        let result = sanitize_dynamic_accounts(account_metas, &payer, Some(&identity)).unwrap();

        // The identity's is_signer flag is preserved; the other is forced to false.
        assert!(!result[0].is_signer);
        assert!(result[1].is_signer);
    }
}
