use std::io::{Error, ErrorKind};

use crate::{GasPaymentKey, HyperlaneProtocolError, H160, H256, H512, U256};

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
            Err(ethers_core::types::SignatureError::InvalidLength(len).into())
        } else {
            Ok(Self::try_from(buf.as_ref())?)
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
