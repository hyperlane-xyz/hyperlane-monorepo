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

macro_rules! impl_aleo_literal {
    // implement for the Aleo literal wrapper type.
    ($type:ident, $variant:ident) => {
        impl<N: Network> AleoSerialize<N> for $type<N> {
            fn parse_value(value: Plaintext<N>) -> Result<Self> {
                match value {
                    Plaintext::Literal(Literal::$variant(inner), _) => Ok(inner),
                    other => bail!("Expected {}, got {other}", stringify!($variant)),
                }
            }

            fn to_plaintext(&self) -> Result<Plaintext<N>> {
                Ok(Plaintext::Literal(
                    Literal::$variant(self.clone()),
                    OnceLock::new(),
                ))
            }
        }
    };

    // also implement for a native Rust type that the wrapper can convert into/from.
    ($type:ident, $variant:ident, $native:ty) => {
        impl_aleo_literal!($type, $variant);

        impl<N: Network> AleoSerialize<N> for $native {
            fn parse_value(value: Plaintext<N>) -> Result<Self> {
                match value {
                    Plaintext::Literal(Literal::$variant(inner), _) => Ok(*inner),
                    other => bail!("Expected {}, got {other}", stringify!($variant)),
                }
            }

            fn to_plaintext(&self) -> Result<Plaintext<N>> {
                let wrapped: $type<N> = $variant::new(*self);
                Ok(Plaintext::Literal(
                    Literal::$variant(wrapped),
                    OnceLock::new(),
                ))
            }
        }
    };
}

// Wrapper-only impls.
impl_aleo_literal!(Address, Address);

// Wrapper + native primitive impls.
impl_aleo_literal!(U128, U128, u128);
impl_aleo_literal!(U64, U64, u64);
impl_aleo_literal!(U32, U32, u32);
impl_aleo_literal!(U8, U8, u8);
impl_aleo_literal!(Boolean, Boolean, bool);

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
            .iter()
            .map(|t| t.to_plaintext())
            .collect::<Result<Vec<_>>>()?;
        Ok(Plaintext::Array(items, OnceLock::new()))
    }
}

#[cfg(test)]
mod tests;
