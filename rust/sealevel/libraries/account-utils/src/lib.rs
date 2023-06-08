use solana_program::{
    account_info::AccountInfo,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
};
use spl_type_length_value::discriminator::Discriminator;

/// Creates associated token account using Program Derived Address for the given seeds.
/// Required to allow PDAs to be created even if they already have a lamport balance.
///
/// Borrowed from https://github.com/solana-labs/solana-program-library/blob/cf77ed0c187d1becd0db56edff4491c28f18dfc8/associated-token-account/program/src/tools/account.rs#L18
pub fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    rent: &Rent,
    space: usize,
    owner: &Pubkey,
    system_program: &AccountInfo<'a>,
    new_pda_account: &AccountInfo<'a>,
    new_pda_signer_seeds: &[&[u8]],
) -> Result<(), ProgramError> {
    if new_pda_account.lamports() > 0 {
        let required_lamports = rent
            .minimum_balance(space)
            .max(1)
            .saturating_sub(new_pda_account.lamports());

        if required_lamports > 0 {
            invoke(
                &system_instruction::transfer(payer.key, new_pda_account.key, required_lamports),
                &[
                    payer.clone(),
                    new_pda_account.clone(),
                    system_program.clone(),
                ],
            )?;
        }

        invoke_signed(
            &system_instruction::allocate(new_pda_account.key, space as u64),
            &[new_pda_account.clone(), system_program.clone()],
            &[new_pda_signer_seeds],
        )?;

        invoke_signed(
            &system_instruction::assign(new_pda_account.key, owner),
            &[new_pda_account.clone(), system_program.clone()],
            &[new_pda_signer_seeds],
        )
    } else {
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                new_pda_account.key,
                rent.minimum_balance(space).max(1),
                space as u64,
                owner,
            ),
            &[
                payer.clone(),
                new_pda_account.clone(),
                system_program.clone(),
            ],
            &[new_pda_signer_seeds],
        )
    }
}

/// Returns Ok() if the account is rent exempt, Err() otherwise.
pub fn verify_rent_exempt<'a>(account: &AccountInfo<'a>, rent: &Rent) -> Result<(), ProgramError> {
    if !rent.is_exempt(account.lamports(), account.data_len()) {
        return Err(ProgramError::AccountNotRentExempt);
    }
    Ok(())
}

/// Returns Ok if the account data is empty and the owner is the system program.
/// Returns Err otherwise.
pub fn verify_account_uninitialized(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.data_is_empty() && account.owner == &system_program::id() {
        return Ok(());
    }
    Err(ProgramError::AccountAlreadyInitialized)
}

pub const PROGRAM_INSTRUCTION_DISCRIMINATOR: [u8; Discriminator::LENGTH] = [1, 1, 1, 1, 1, 1, 1, 1];

pub trait DiscriminatorData: Sized {
    const DISCRIMINATOR_LENGTH: usize = Discriminator::LENGTH;

    const DISCRIMINATOR: [u8; Discriminator::LENGTH];
    const DISCRIMINATOR_SLICE: &'static [u8] = &Self::DISCRIMINATOR;
}

pub trait DiscriminatorEncode: DiscriminatorData + borsh::BorshSerialize {
    fn encode(self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = vec![];
        buf.extend_from_slice(Self::DISCRIMINATOR_SLICE);
        buf.extend_from_slice(
            &self
                .try_to_vec()
                .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
        );
        Ok(buf)
    }
}

// Auto-implement
impl<T> DiscriminatorEncode for T where T: DiscriminatorData + borsh::BorshSerialize {}

pub trait DiscriminatorDecode: DiscriminatorData + borsh::BorshDeserialize {
    fn decode(data: &[u8]) -> Result<Self, ProgramError> {
        let (discriminator, rest) = data.split_at(Discriminator::LENGTH);
        if discriminator != Self::DISCRIMINATOR_SLICE {
            return Err(ProgramError::InvalidInstructionData);
        }
        Self::try_from_slice(rest).map_err(|_| ProgramError::InvalidInstructionData)
    }
}

// Auto-implement
impl<T> DiscriminatorDecode for T where T: DiscriminatorData + borsh::BorshDeserialize {}
