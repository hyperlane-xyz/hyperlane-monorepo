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
