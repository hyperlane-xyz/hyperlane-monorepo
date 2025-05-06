use std::io::{Error, ErrorKind};

use uuid::Uuid;

use crate::{
    identifiers::UniqueIdentifier, GasPaymentKey, HyperlaneProtocolError, Indexed,
    InterchainGasPayment, H160, H256, H512, U256,
};

/// Simple trait for types with a canonical encoding
pub trait Encode {
    /// Write the canonical encoding to the writer
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write;

    /// Serialize to a vec
    fn to_vec(&self) -> Vec<u8> {
        let mut buf = vec![];
        self.write_to(&mut buf).expect("!alloc");
        buf
    }
}

/// Simple trait for types with a canonical encoding
pub trait Decode {
    /// Try to read from some source
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized;
}

#[cfg(feature = "ethers")]
impl Encode for ethers_core::types::Signature {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.to_vec())?;
        Ok(65)
    }
}

#[cfg(feature = "ethers")]
impl Decode for ethers_core::types::Signature {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let mut buf = [0u8; 65];
        let len = reader.read(&mut buf)?;
        if len != 65 {
            Err(Box::new(ethers_core::types::SignatureError::InvalidLength(len)).into())
        } else {
            Ok(Self::try_from(buf.as_ref()).map_err(Box::new)?)
        }
    }
}

macro_rules! impl_encode_for_primitive_hash {
    ($t:ty) => {
        impl Encode for $t {
            fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
            where
                W: std::io::Write,
            {
                writer.write_all(&self.0)?;
                Ok(<$t>::len_bytes())
            }
        }

        impl Decode for $t {
            fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
            where
                R: std::io::Read,
                Self: Sized,
            {
                let mut h = Self::zero();
                reader.read_exact(&mut h.0)?;
                Ok(h)
            }
        }
    };
}

impl_encode_for_primitive_hash!(H160);
impl_encode_for_primitive_hash!(H256);
impl_encode_for_primitive_hash!(H512);

impl Encode for U256 {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut buf = [0; 32];
        self.to_little_endian(&mut buf);
        writer.write_all(&buf)?;
        Ok(32)
    }
}

impl Decode for U256 {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut buf = [0; 32];
        reader.read_exact(&mut buf)?;
        Ok(U256::from_little_endian(&buf))
    }
}

impl Encode for u32 {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.to_be_bytes())?;
        Ok(4)
    }
}

impl Decode for u32 {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut buf = [0; 4];
        reader.read_exact(&mut buf)?;
        Ok(u32::from_be_bytes(buf))
    }
}

impl Encode for u64 {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.to_be_bytes())?;
        Ok(8)
    }
}

impl Decode for u64 {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut buf = [0; 8];
        reader.read_exact(&mut buf)?;
        Ok(u64::from_be_bytes(buf))
    }
}

impl Encode for bool {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&[u8::from(*self)])?;
        Ok(1)
    }
}

impl Decode for bool {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut buf = [0; 1];
        reader.read_exact(&mut buf)?;
        match buf[0] {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(HyperlaneProtocolError::IoError(Error::new(
                ErrorKind::InvalidData,
                "decoded bool invalid",
            ))),
        }
    }
}

impl Encode for UniqueIdentifier {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let bytes = self.as_bytes();
        writer.write_all(bytes.as_slice())?;
        Ok(bytes.len())
    }
}

impl Decode for UniqueIdentifier {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let mut bytes = [0; 16];
        reader.read_exact(&mut bytes)?;
        Ok(UniqueIdentifier::new(Uuid::from_bytes(bytes)))
    }
}

impl Encode for GasPaymentKey {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = 0;
        written += self.message_id.write_to(writer)?;
        written += self.destination.write_to(writer)?;
        Ok(written)
    }
}

impl Decode for GasPaymentKey {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        Ok(Self {
            message_id: H256::read_from(reader)?,
            destination: u32::read_from(reader)?,
        })
    }
}

impl Encode for InterchainGasPayment {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = 0;
        written += self.message_id.write_to(writer)?;
        written += self.destination.write_to(writer)?;
        written += self.payment.write_to(writer)?;
        written += self.gas_amount.write_to(writer)?;
        Ok(written)
    }
}

impl Decode for InterchainGasPayment {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        Ok(Self {
            message_id: H256::read_from(reader)?,
            destination: u32::read_from(reader)?,
            payment: U256::read_from(reader)?,
            gas_amount: U256::read_from(reader)?,
        })
    }
}

// TODO: Could generalize this implementation to support encoding arbitrary `Option<T>`
// where T: Encode + Decode
impl<T: Encode> Encode for Indexed<T> {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = 0;
        written += self.inner().write_to(writer)?;
        match self.sequence {
            Some(sequence) => {
                let sequence_is_defined = true;
                written += sequence_is_defined.write_to(writer)?;
                written += sequence.write_to(writer)?;
            }
            None => {
                let sequence_is_defined = false;
                written += sequence_is_defined.write_to(writer)?;
            }
        }
        Ok(written)
    }
}

impl<T: Decode> Decode for Indexed<T> {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        let inner = T::read_from(reader)?;
        let sequence_is_defined = bool::read_from(reader)?;
        let mut indexed = Self::new(inner);
        if sequence_is_defined {
            let sequence = u32::read_from(reader)?;
            indexed = indexed.with_sequence(sequence)
        }
        Ok(indexed)
    }
}

impl<T: Encode> Encode for Vec<T> {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = 0;
        // Write the length of the vector as a u32
        written += (self.len() as u64).write_to(writer)?;

        // Write each `T` in the vector using its `Encode` implementation
        written += self.iter().try_fold(0, |acc, item| {
            item.write_to(writer).map(|bytes| acc + bytes)
        })?;
        Ok(written)
    }
}

impl<T: Decode> Decode for Vec<T> {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        // Read the length of the vector
        let len = u64::read_from(reader)? as usize;

        // Read each `T` using its `Decode` implementation
        let vec = (0..len).try_fold(vec![], |mut acc, _| {
            let item = T::read_from(reader)?;
            acc.push(item);
            Ok::<Vec<T>, HyperlaneProtocolError>(acc)
        })?;
        Ok(vec)
    }
}

#[cfg(test)]
mod test {
    use std::io::Cursor;

    use crate::{Decode, Encode, Indexed, H256};

    #[test]
    fn test_encoding_indexed() {
        let indexed: Indexed<H256> = Indexed::new(H256::random()).with_sequence(5);
        let encoded = indexed.to_vec();
        let decoded = Indexed::<H256>::read_from(&mut &encoded[..]).unwrap();
        assert_eq!(indexed, decoded);
    }

    #[test]
    fn test_encoding_interchain_gas_payment() {
        let payment = super::InterchainGasPayment {
            message_id: Default::default(),
            destination: 42,
            payment: 100.into(),
            gas_amount: 200.into(),
        };
        let encoded = payment.to_vec();
        let decoded = super::InterchainGasPayment::read_from(&mut &encoded[..]).unwrap();
        assert_eq!(payment, decoded);
    }

    #[test]
    fn test_encoding_vec_u32() {
        let vec: Vec<u32> = vec![1, 2, 3, 4, 5];
        let mut buf = vec![];
        let encoded_length = vec.write_to(&mut buf).unwrap();
        let decoded = Vec::<u32>::read_from(&mut Cursor::new(buf)).unwrap();
        assert_eq!(vec, decoded);
        assert_eq!(encoded_length, 8 + 4 * vec.len());
    }
}
