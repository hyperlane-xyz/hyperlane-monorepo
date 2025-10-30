use std::sync::OnceLock;

use anyhow::{anyhow, bail, Result};
use snarkvm::prelude::{
    Access, Address, Boolean, Identifier, Literal, Network, Plaintext, U128, U32, U64, U8,
};

/// Generic trait every type participating in parsing must implement.
pub trait AleoSerialize<N: Network>: Sized {
    /// Parses a plaintext value into the desired native type
    fn parse_value(value: Plaintext<N>) -> Result<Self>;

    /// Converts the struct back to a plaintext value
    fn to_plaintext(&self) -> Result<Plaintext<N>>;
}

/// Helper: fetch a named field from a struct-like Plaintext.
pub fn fetch_field<N: Network>(root: &Plaintext<N>, name: &str) -> Result<Plaintext<N>> {
    let ident = Identifier::try_from(name)?;
    let path = [Access::from(ident)];
    let found = root.find(&path)?;
    Ok(found)
}

impl<N: Network> AleoSerialize<N> for Address<N> {
    fn parse_value(value: Plaintext<N>) -> Result<Self> {
        match value {
            Plaintext::Literal(Literal::Address(addr), _) => Ok(addr),
            other => bail!("Expected Address, got {other}"),
        }
    }

    fn to_plaintext(&self) -> Result<Plaintext<N>> {
        Ok(Plaintext::Literal(
            Literal::Address(self.clone()),
            OnceLock::new(),
        ))
    }
}

impl<N: Network> AleoSerialize<N> for U128<N> {
    fn parse_value(value: Plaintext<N>) -> Result<Self> {
        match value {
            Plaintext::Literal(Literal::U128(v), _) => Ok(v),
            other => bail!("Expected U128, got {other}"),
        }
    }

    fn to_plaintext(&self) -> Result<Plaintext<N>> {
        Ok(Plaintext::Literal(
            Literal::U128(self.clone()),
            OnceLock::new(),
        ))
    }
}

impl<N: Network> AleoSerialize<N> for U64<N> {
    fn parse_value(value: Plaintext<N>) -> Result<Self> {
        match value {
            Plaintext::Literal(Literal::U64(v), _) => Ok(v),
            other => bail!("Expected U64, got {other}"),
        }
    }

    fn to_plaintext(&self) -> Result<Plaintext<N>> {
        Ok(Plaintext::Literal(
            Literal::U64(self.clone()),
            OnceLock::new(),
        ))
    }
}

impl<N: Network> AleoSerialize<N> for U32<N> {
    fn parse_value(value: Plaintext<N>) -> Result<Self> {
        match value {
            Plaintext::Literal(Literal::U32(v), _) => Ok(v),
            other => bail!("Expected U32, got {other}"),
        }
    }

    fn to_plaintext(&self) -> Result<Plaintext<N>> {
        Ok(Plaintext::Literal(
            Literal::U32(self.clone()),
            OnceLock::new(),
        ))
    }
}

impl<N: Network> AleoSerialize<N> for U8<N> {
    fn parse_value(value: Plaintext<N>) -> Result<Self> {
        match value {
            Plaintext::Literal(Literal::U8(v), _) => Ok(v),
            other => bail!("Expected U8, got {other}"),
        }
    }

    fn to_plaintext(&self) -> Result<Plaintext<N>> {
        Ok(Plaintext::Literal(
            Literal::U8(self.clone()),
            OnceLock::new(),
        ))
    }
}

impl<N: Network> AleoSerialize<N> for Boolean<N> {
    fn parse_value(value: Plaintext<N>) -> Result<Self> {
        match value {
            Plaintext::Literal(Literal::Boolean(v), _) => Ok(v),
            other => bail!("Expected Boolean, got {other}"),
        }
    }

    fn to_plaintext(&self) -> Result<Plaintext<N>> {
        Ok(Plaintext::Literal(
            Literal::Boolean(self.clone()),
            OnceLock::new(),
        ))
    }
}

impl<N: Network> AleoSerialize<N> for Plaintext<N> {
    fn parse_value(value: Plaintext<N>) -> Result<Self> {
        Ok(value)
    }

    fn to_plaintext(&self) -> Result<Plaintext<N>> {
        Ok(self.clone())
    }
}

impl<N: Network, T, const LEN: usize> AleoSerialize<N> for [T; LEN]
where
    T: AleoSerialize<N>,
{
    fn parse_value(value: Plaintext<N>) -> Result<Self> {
        let Plaintext::Array(items, _) = value else {
            bail!("Expected Array for fixed-size array field, got {value}");
        };
        if items.len() != LEN {
            bail!("Expected array length {LEN}, got {}", items.len());
        }
        let mut parsed: Vec<T> = Vec::with_capacity(LEN);
        for item in items.into_iter() {
            parsed.push(T::parse_value(item)?);
        }
        let arr: [T; LEN] = parsed.try_into().map_err(|v: Vec<T>| {
            anyhow!(
                "Length mismatch when forming fixed array, expected {LEN}, got {}",
                v.len()
            )
        })?;
        Ok(arr)
    }

    fn to_plaintext(&self) -> Result<Plaintext<N>> {
        let items = self
            .into_iter()
            .map(|t| t.to_plaintext())
            .collect::<Result<Vec<_>>>()?;
        Ok(Plaintext::Array(items, OnceLock::new()))
    }
}
