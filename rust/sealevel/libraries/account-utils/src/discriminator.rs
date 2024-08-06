use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::program_error::ProgramError;
use spl_type_length_value::discriminator::Discriminator;
use std::ops::{Deref, DerefMut};

use crate::{Data, SizedData};

pub const PROGRAM_INSTRUCTION_DISCRIMINATOR: [u8; Discriminator::LENGTH] = [1, 1, 1, 1, 1, 1, 1, 1];

pub trait DiscriminatorPrefixedData: Data + DiscriminatorData {}

impl<T> DiscriminatorPrefixedData for T where T: Data + DiscriminatorData {}

/// A wrapper type that prefixes data with a discriminator when Borsh (de)serialized.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DiscriminatorPrefixed<T>
where
    T: DiscriminatorPrefixedData,
{
    pub data: T,
}

impl<T> DiscriminatorPrefixed<T>
where
    T: DiscriminatorPrefixedData,
{
    pub fn new(data: T) -> Self {
        Self { data }
    }
}

impl<T> BorshSerialize for DiscriminatorPrefixed<T>
where
    T: DiscriminatorPrefixedData,
{
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        T::DISCRIMINATOR.serialize(writer)?;
        self.data.serialize(writer)
    }
}

impl<T> BorshDeserialize for DiscriminatorPrefixed<T>
where
    T: DiscriminatorPrefixedData,
{
    fn deserialize(buf: &mut &[u8]) -> std::io::Result<Self> {
        let (discriminator, rest) = buf.split_at(Discriminator::LENGTH);
        if discriminator != T::DISCRIMINATOR {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid discriminator",
            ));
        }
        Ok(Self {
            data: T::deserialize(&mut rest.to_vec().as_slice())?,
        })
    }
}

impl<T> SizedData for DiscriminatorPrefixed<T>
where
    T: DiscriminatorPrefixedData + SizedData,
{
    fn size(&self) -> usize {
        // Discriminator prefix + data
        Discriminator::LENGTH + self.data.size()
    }
}

impl<T> Deref for DiscriminatorPrefixed<T>
where
    T: DiscriminatorPrefixedData,
{
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

impl<T> DerefMut for DiscriminatorPrefixed<T>
where
    T: DiscriminatorPrefixedData,
{
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.data
    }
}

impl<T> From<T> for DiscriminatorPrefixed<T>
where
    T: DiscriminatorPrefixedData,
{
    fn from(data: T) -> Self {
        Self::new(data)
    }
}

pub trait DiscriminatorData: Sized {
    const DISCRIMINATOR_LENGTH: usize = Discriminator::LENGTH;

    const DISCRIMINATOR: [u8; Discriminator::LENGTH];
    const DISCRIMINATOR_SLICE: &'static [u8] = &Self::DISCRIMINATOR;
}

/// Encodes the given data with a discriminator prefix.
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

/// Decodes the given data with a discriminator prefix.
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

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_discriminator_prefixed_size() {
        #[derive(BorshSerialize, BorshDeserialize, Default)]
        struct Foo {
            a: u64,
        }

        impl DiscriminatorData for Foo {
            const DISCRIMINATOR: [u8; 8] = [2, 2, 2, 2, 2, 2, 2, 2];
        }

        impl SizedData for Foo {
            fn size(&self) -> usize {
                8
            }
        }

        let prefixed_foo = DiscriminatorPrefixed::new(Foo { a: 1 });
        let serialized_prefixed_foo = prefixed_foo.try_to_vec().unwrap();

        assert_eq!(serialized_prefixed_foo.len(), prefixed_foo.size());
        assert_eq!(
            serialized_prefixed_foo[0..Discriminator::LENGTH],
            Foo::DISCRIMINATOR
        );
    }
}
