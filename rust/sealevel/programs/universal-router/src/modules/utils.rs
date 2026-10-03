use solana_program::{instruction::Instruction, program_error::ProgramError, pubkey::Pubkey};

/// Read token amount (u64 LE at bytes [64..72]) from an SPL Token or Token-2022
/// account data buffer. Both formats share the same base layout, but Token-2022
/// accounts are longer than 165 bytes due to extensions, so
/// `spl_token::state::Account::unpack` (which requires exactly 165 bytes) fails.
pub fn read_token_amount(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    let bytes: [u8; 8] = data[64..72]
        .try_into()
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}

/// Read decimals (u8 at byte offset 44) from an SPL Token or Token-2022 mint
/// account data buffer. Both formats share the same base mint layout.
pub fn read_mint_decimals(data: &[u8]) -> Result<u8, ProgramError> {
    if data.len() < 45 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(data[44])
}

/// Build a TransferChecked instruction for either SPL Token or Token-2022.
/// TransferChecked includes the mint address and validates decimals, which is
/// required by Token-2022 mints that have extensions (e.g. PermanentDelegate,
/// TransferFee, TransferHook).
pub fn build_token_transfer_checked_ix(
    token_program_id: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    dest: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
) -> Result<Instruction, ProgramError> {
    if token_program_id == &spl_token_2022::ID {
        spl_token_2022::instruction::transfer_checked(
            token_program_id,
            source,
            mint,
            dest,
            authority,
            &[],
            amount,
            decimals,
        )
    } else {
        spl_token::instruction::transfer_checked(
            token_program_id,
            source,
            mint,
            dest,
            authority,
            &[],
            amount,
            decimals,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::pubkey::Pubkey;

    // -----------------------------------------------------------------------
    // read_token_amount
    // -----------------------------------------------------------------------

    #[test]
    fn test_read_token_amount_ok() {
        let mut data = vec![0u8; 72];
        let amount: u64 = 123_456_789;
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        assert_eq!(read_token_amount(&data).unwrap(), amount);
    }

    #[test]
    fn test_read_token_amount_exactly_72_bytes() {
        let mut data = vec![0u8; 72];
        let amount: u64 = u64::MAX;
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        assert_eq!(read_token_amount(&data).unwrap(), amount);
    }

    #[test]
    fn test_read_token_amount_longer_data_token_2022() {
        // Token-2022 accounts have extensions beyond the base 165 bytes
        let mut data = vec![0u8; 300];
        let amount: u64 = 999_000;
        data[64..72].copy_from_slice(&amount.to_le_bytes());
        assert_eq!(read_token_amount(&data).unwrap(), amount);
    }

    #[test]
    fn test_read_token_amount_too_short() {
        assert!(read_token_amount(&[0u8; 71]).is_err());
        assert!(read_token_amount(&[0u8; 0]).is_err());
        assert!(read_token_amount(&[0u8; 64]).is_err());
    }

    #[test]
    fn test_read_token_amount_zero() {
        let data = vec![0u8; 72];
        assert_eq!(read_token_amount(&data).unwrap(), 0);
    }

    // -----------------------------------------------------------------------
    // read_mint_decimals
    // -----------------------------------------------------------------------

    #[test]
    fn test_read_mint_decimals_ok() {
        let mut data = vec![0u8; 82]; // standard SPL Token mint = 82 bytes
        data[44] = 6;
        assert_eq!(read_mint_decimals(&data).unwrap(), 6);
    }

    #[test]
    fn test_read_mint_decimals_exactly_45_bytes() {
        let mut data = vec![0u8; 45];
        data[44] = 9;
        assert_eq!(read_mint_decimals(&data).unwrap(), 9);
    }

    #[test]
    fn test_read_mint_decimals_too_short() {
        assert!(read_mint_decimals(&[0u8; 44]).is_err());
        assert!(read_mint_decimals(&[0u8; 0]).is_err());
    }

    #[test]
    fn test_read_mint_decimals_max_value() {
        let mut data = vec![0u8; 82];
        data[44] = u8::MAX;
        assert_eq!(read_mint_decimals(&data).unwrap(), u8::MAX);
    }

    // -----------------------------------------------------------------------
    // build_token_transfer_checked_ix
    // -----------------------------------------------------------------------

    #[test]
    fn test_build_token_transfer_checked_ix_spl_token() {
        let source = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let dest = Pubkey::new_unique();
        let authority = Pubkey::new_unique();

        let ix = build_token_transfer_checked_ix(
            &spl_token::ID,
            &source,
            &mint,
            &dest,
            &authority,
            1_000_000,
            6,
        );
        assert!(ix.is_ok(), "SPL Token transfer_checked should succeed");
        let ix = ix.unwrap();
        assert_eq!(ix.program_id, spl_token::ID);
    }

    #[test]
    fn test_build_token_transfer_checked_ix_spl_token_2022() {
        let source = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let dest = Pubkey::new_unique();
        let authority = Pubkey::new_unique();

        let ix = build_token_transfer_checked_ix(
            &spl_token_2022::ID,
            &source,
            &mint,
            &dest,
            &authority,
            500_000,
            9,
        );
        assert!(ix.is_ok(), "Token-2022 transfer_checked should succeed");
        let ix = ix.unwrap();
        assert_eq!(ix.program_id, spl_token_2022::ID);
    }

    #[test]
    fn test_build_token_transfer_checked_ix_different_program_ids_produce_different_program_ids_in_ix(
    ) {
        let source = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let dest = Pubkey::new_unique();
        let authority = Pubkey::new_unique();

        let spl = build_token_transfer_checked_ix(
            &spl_token::ID,
            &source,
            &mint,
            &dest,
            &authority,
            100,
            6,
        )
        .unwrap();

        let spl2022 = build_token_transfer_checked_ix(
            &spl_token_2022::ID,
            &source,
            &mint,
            &dest,
            &authority,
            100,
            6,
        )
        .unwrap();

        assert_ne!(spl.program_id, spl2022.program_id);
        assert_eq!(spl.program_id, spl_token::ID);
        assert_eq!(spl2022.program_id, spl_token_2022::ID);
    }
}
