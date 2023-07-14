use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
};
use spl_type_length_value::discriminator::Discriminator;

/// Data that has a predictable size when serialized.
pub trait SizedData {
    /// Returns the size of the data when serialized.
    fn size(&self) -> usize;
}

/// Serializable data intended to be used by `AccountData`.
/// Consider removing the `Default` binding in the future.
pub trait Data: BorshDeserialize + BorshSerialize + Default {}

impl<T> Data for T where T: BorshDeserialize + BorshSerialize + Default {}

/// Account data structure wrapper type that handles initialization and (de)serialization.
///
/// (De)serialization is done with borsh and the "on-disk" format is as follows:
/// {
///     initialized: bool,
///     data: T,
/// }
#[derive(Debug, Default)]
pub struct AccountData<T> {
    data: Box<T>,
}

impl<T> From<T> for AccountData<T> {
    fn from(data: T) -> Self {
        Self {
            data: Box::new(data),
        }
    }
}

impl<T> From<Box<T>> for AccountData<T> {
    fn from(data: Box<T>) -> Self {
        Self { data }
    }
}

impl<T> SizedData for AccountData<T>
where
    T: SizedData,
{
    fn size(&self) -> usize {
        // Add an extra byte for the initialized flag.
        1 + self.data.size()
    }
}

impl<T> AccountData<T>
where
    T: Data,
{
    pub fn into_inner(self) -> Box<T> {
        self.data
    }

    /// Deserializes the account data from the given slice.
    pub fn fetch_data(buf: &mut &[u8]) -> Result<Option<Box<T>>, ProgramError> {
        if buf.is_empty() {
            return Ok(None);
        }
        // Account data is zero initialized.
        let initialized = bool::deserialize(buf)?;
        let data = if initialized {
            Some(T::deserialize(buf).map(Box::new)?)
        } else {
            None
        };
        Ok(data)
    }

    /// Deserializes the account data from the given slice and wraps it in an `AccountData`.
    pub fn fetch(buf: &mut &[u8]) -> Result<Self, ProgramError> {
        Ok(Self::from(Self::fetch_data(buf)?.unwrap_or_default()))
    }

    // Optimisically write then realloc on failure.
    // If we serialize and calculate len before realloc we will waste heap space as there is no
    // free(). Tradeoff between heap usage and compute budget.
    pub fn store(
        &self,
        account: &AccountInfo<'_>,
        allow_realloc: bool,
    ) -> Result<(), ProgramError> {
        if !account.is_writable || account.executable {
            return Err(ProgramError::InvalidAccountData);
        }
        let realloc_increment = 1024;
        loop {
            // Create new scope to ensure `guard` is dropped before
            // potential reallocation.
            let data_len = {
                let mut guard = account.try_borrow_mut_data()?;
                let data = &mut *guard;
                let data_len = data.len();

                match self.store_in_slice(data) {
                    Ok(_) => break,
                    Err(err) => match err.kind() {
                        std::io::ErrorKind::WriteZero => {
                            if !allow_realloc {
                                return Err(ProgramError::BorshIoError(err.to_string()));
                            }
                        }
                        _ => return Err(ProgramError::BorshIoError(err.to_string())),
                    },
                };

                data_len
            };

            if cfg!(target_os = "solana") {
                account.realloc(data_len + realloc_increment, false)?;
            } else {
                panic!("realloc() is only supported on the SVM");
            }
        }
        Ok(())
    }

    pub fn store_in_slice(&self, target: &mut [u8]) -> Result<(), Box<std::io::Error>> {
        // Create a new slice so that this new slice
        // is updated to point to the unwritten data during serialization, and not `target` itself.

        let mut writable_target: &mut [u8] = &mut *target;
        true.serialize(&mut writable_target)
            .and_then(|_| self.data.serialize(&mut writable_target))?;
        Ok(())
    }
}

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
pub fn verify_rent_exempt(account: &AccountInfo<'_>, rent: &Rent) -> Result<(), ProgramError> {
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
