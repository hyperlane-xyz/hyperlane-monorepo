use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::program_error::ProgramError;
use spl_discriminator::ArrayDiscriminator as Discriminator;
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
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut discriminator = [0u8; Discriminator::LENGTH];
        reader.read_exact(&mut discriminator)?;
        if discriminator != T::DISCRIMINATOR {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid discriminator",
            ));
        }
        Ok(Self {
            data: T::deserialize_reader(reader)?,
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

/// A trailing optional field that is self-describing on disk: serializes to
/// nothing when absent, and to `[T::DISCRIMINATOR][value]` when present. On read
/// it is `Some` only if the tail begins with `T::DISCRIMINATOR`; EOF, a short
/// tail, or any non-matching tail (e.g. stale bytes in an over-allocated account)
/// reads as `None`. A matching discriminator with an undecodable payload errors.
///
/// The absent-able counterpart of [`DiscriminatorPrefixed`]; place it LAST so the
/// rest of the struct can derive Borsh, and decode via a reader path
/// (`AccountData::fetch`), not `try_from_slice` (which rejects an over-allocated
/// account's unread tail). Choose a `DISCRIMINATOR` that won't collide with the
/// preceding field's bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct OptionalDiscriminatedData<T>(pub Option<T>);

impl<T> Default for OptionalDiscriminatedData<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<T> From<Option<T>> for OptionalDiscriminatedData<T> {
    fn from(value: Option<T>) -> Self {
        Self(value)
    }
}

impl<T: PartialEq> PartialEq<Option<T>> for OptionalDiscriminatedData<T> {
    fn eq(&self, other: &Option<T>) -> bool {
        self.0 == *other
    }
}

impl<T> Deref for OptionalDiscriminatedData<T> {
    type Target = Option<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> DerefMut for OptionalDiscriminatedData<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl<T> BorshSerialize for OptionalDiscriminatedData<T>
where
    T: DiscriminatorData + BorshSerialize,
{
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        if let Some(value) = &self.0 {
            T::DISCRIMINATOR.serialize(writer)?;
            value.serialize(writer)?;
        }
        Ok(())
    }
}

impl<T> BorshDeserialize for OptionalDiscriminatedData<T>
where
    T: DiscriminatorData + BorshDeserialize,
{
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut discriminator = [0u8; Discriminator::LENGTH];
        match reader.read_exact(&mut discriminator) {
            Ok(()) if discriminator == T::DISCRIMINATOR => {
                Ok(Self(Some(T::deserialize_reader(reader)?)))
            }
            // A non-matching or too-short tail is stale/absent data, not an error.
            Ok(()) => Ok(Self(None)),
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(Self(None)),
            Err(e) => Err(e),
        }
    }
}

impl<T> SizedData for OptionalDiscriminatedData<T>
where
    T: DiscriminatorData + SizedData,
{
    fn size(&self) -> usize {
        match &self.0 {
            Some(value) => Discriminator::LENGTH + value.size(),
            None => 0,
        }
    }
}

/// Encodes the given data with a discriminator prefix.
pub trait DiscriminatorEncode: DiscriminatorData + borsh::BorshSerialize {
    fn encode(self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = vec![];
        buf.extend_from_slice(Self::DISCRIMINATOR_SLICE);
        buf.extend_from_slice(&borsh::to_vec(&self).map_err(|_| ProgramError::BorshIoError)?[..]);
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
        let serialized_prefixed_foo = borsh::to_vec(&prefixed_foo).unwrap();

        assert_eq!(serialized_prefixed_foo.len(), prefixed_foo.size());
        assert_eq!(
            serialized_prefixed_foo[0..Discriminator::LENGTH],
            Foo::DISCRIMINATOR
        );
    }

    #[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone, Default)]
    struct Bar {
        a: u64,
    }

    impl DiscriminatorData for Bar {
        const DISCRIMINATOR: [u8; 8] = *b"BAR_____";
    }

    impl SizedData for Bar {
        fn size(&self) -> usize {
            8
        }
    }

    #[test]
    fn test_optional_discriminated_data_none_writes_nothing() {
        let none = OptionalDiscriminatedData::<Bar>(None);
        assert!(borsh::to_vec(&none).unwrap().is_empty());
        assert_eq!(none.size(), 0);
    }

    #[test]
    fn test_optional_discriminated_data_some_roundtrip() {
        let some = OptionalDiscriminatedData(Some(Bar { a: 7 }));
        let bytes = borsh::to_vec(&some).unwrap();
        // [discriminator][payload]
        assert_eq!(bytes[..Discriminator::LENGTH], Bar::DISCRIMINATOR);
        assert_eq!(bytes.len(), some.size());

        let decoded =
            OptionalDiscriminatedData::<Bar>::deserialize_reader(&mut &bytes[..]).unwrap();
        assert_eq!(decoded, some);
    }

    #[test]
    fn test_optional_discriminated_data_eof_is_none() {
        let decoded = OptionalDiscriminatedData::<Bar>::deserialize_reader(&mut &[][..]).unwrap();
        assert_eq!(decoded, None);
    }

    #[test]
    fn test_optional_discriminated_data_short_tail_is_none() {
        // Fewer bytes than the discriminator can't be a present field.
        let decoded =
            OptionalDiscriminatedData::<Bar>::deserialize_reader(&mut &[0xAB, 0xCD][..]).unwrap();
        assert_eq!(decoded, None);
    }

    #[test]
    fn test_optional_discriminated_data_non_matching_tail_is_none() {
        // A full-length tail that isn't the discriminator (e.g. stale bytes) is
        // absent, not an error — this is the HLSVM-2026Q2-010 fix.
        let stale = [0xFFu8; 64];
        let decoded =
            OptionalDiscriminatedData::<Bar>::deserialize_reader(&mut &stale[..]).unwrap();
        assert_eq!(decoded, None);
    }

    #[test]
    fn test_optional_discriminated_data_ignores_trailing_after_payload() {
        // Discriminator + valid payload, then stale padding: still Some, padding
        // ignored (deserialize_reader does not require full consumption).
        let mut bytes = borsh::to_vec(&OptionalDiscriminatedData(Some(Bar { a: 9 }))).unwrap();
        bytes.extend_from_slice(&[0xFF; 16]);
        let decoded =
            OptionalDiscriminatedData::<Bar>::deserialize_reader(&mut &bytes[..]).unwrap();
        assert_eq!(decoded, Some(Bar { a: 9 }));
    }

    #[test]
    fn test_optional_discriminated_data_matching_discriminator_truncated_payload_errors() {
        let mut bytes = Bar::DISCRIMINATOR.to_vec();
        bytes.extend_from_slice(&[0u8; 3]); // Bar needs a u64; only 3 bytes follow
        assert!(OptionalDiscriminatedData::<Bar>::deserialize_reader(&mut &bytes[..]).is_err());
    }
}
