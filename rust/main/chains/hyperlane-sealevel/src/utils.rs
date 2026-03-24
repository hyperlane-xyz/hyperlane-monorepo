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
/// - The payer account is not present as a writable account in the provided account metas
///   (this is a failure condition — a writable payer in a CPI can be used to drain funds)
///
/// Note: the payer may appear as a readonly account (e.g. trusted-relayer ISM returns the relayer
/// pubkey readonly so the mailbox CPI propagates its signer status to the ISM verify call).
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

    // Security: on SVM, if a transaction lists the same account twice and one entry has
    // is_signer=true, the runtime treats ALL entries for that account as signers — even
    // those where is_signer=false.  Because the payer already signs the outer process
    // transaction, any account meta whose pubkey matches the payer will inherit signer
    // status in every CPI the mailbox makes.
    //
    // A *writable* payer in an ISM verify CPI is the threat: the ISM program could
    // transfer lamports out of the payer, effectively stealing funds.  We reject that.
    //
    // A *readonly* payer is safe: read-only signer status cannot move lamports.  We
    // allow it because the trusted-relayer ISM legitimately returns the relayer pubkey
    // (which may equal the payer) as a readonly account so the mailbox CPI propagates
    // the required signer proof into the verify call.
    if account_metas
        .iter()
        .any(|meta| meta.pubkey == *payer && meta.is_writable)
    {
        return Err(ChainCommunicationError::from_other_str(
            "Dynamic account metas contain payer account as writable",
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
    fn test_sanitize_dynamic_accounts_rejects_writable_payer() {
        use solana_sdk::instruction::AccountMeta;

        let payer = Pubkey::new_unique();

        let account_metas = vec![
            AccountMeta::new_readonly([0u8; 32].into(), false),
            AccountMeta::new_readonly([1u8; 32].into(), true),
            AccountMeta::new(payer, true),
        ];

        assert!(sanitize_dynamic_accounts(account_metas, &payer).is_err());
    }

    #[test]
    fn test_sanitize_dynamic_accounts_allows_readonly_payer() {
        use solana_sdk::instruction::AccountMeta;

        let payer = Pubkey::new_unique();

        let account_metas = vec![
            AccountMeta::new_readonly([0u8; 32].into(), false),
            // payer as readonly — trusted-relayer ISM returns relayer (==payer) as readonly signer
            AccountMeta::new_readonly(payer, true),
        ];

        let result = sanitize_dynamic_accounts(account_metas, &payer).unwrap();
        assert_eq!(
            result,
            vec![
                AccountMeta::new_readonly([0u8; 32].into(), false),
                AccountMeta::new_readonly(payer, false),
            ]
        );
    }
}
