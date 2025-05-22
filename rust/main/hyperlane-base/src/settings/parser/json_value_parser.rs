use std::{fmt::Debug, str::FromStr};

use convert_case::{Case, Casing};
use derive_new::new;
use eyre::{eyre, Context};
use hyperlane_core::{config::*, utils::hex_or_base58_to_h256, H256, U256};
use itertools::Itertools;
use serde::de::{DeserializeOwned, StdError};
use serde_json::Value;

#[allow(unused_imports)] // TODO: `rustc` 1.80.1 clippy issue
pub use super::super::envs::*;

/// A serde-json value config parsing utility.
#[derive(Debug, Clone, new)]
pub struct ValueParser<'v> {
    /// Path to the current value from the root.
    pub cwp: ConfigPath,
    /// Reference to the serde JSON value.
    pub val: &'v Value,
}

impl<'v> ValueParser<'v> {
    /// Create a new value parser chain.
    pub fn chain<'e>(&self, err: &'e mut ConfigParsingError) -> ParseChain<'e, ValueParser<'v>> {
        ParseChain(Some(self.clone()), err)
    }

    /// Get a value at the given key and verify that it is present.
    pub fn get_key(&self, key: &str) -> ConfigResult<ValueParser<'v>> {
        self.get_opt_key(&key.to_case(Case::Flat))?
            .ok_or_else(|| eyre!("Expected key `{key}` to be defined"))
            .into_config_result(|| &self.cwp + key.to_case(Case::Snake))
    }

    /// Get a value at the given key allowing for it to not be set.
    pub fn get_opt_key(&self, key: &str) -> ConfigResult<Option<ValueParser<'v>>> {
        let cwp = &self.cwp + key.to_case(Case::Snake);
        match self.val {
            Value::Object(obj) => Ok(obj.get(&key.to_case(Case::Flat)).map(|val| Self {
                val,
                cwp: cwp.clone(),
            })),
            _ => Err(eyre!("Expected an object type")),
        }
        .into_config_result(|| cwp)
    }

    /// Create an iterator over all (key, value) tuples.
    /// Be warned that keys will be in flat case.
    pub fn into_obj_iter(
        self,
    ) -> ConfigResult<impl Iterator<Item = (String, ValueParser<'v>)> + 'v> {
        let cwp = self.cwp.clone();
        match self.val {
            Value::Object(obj) => Ok(obj.iter().map(move |(k, v)| {
                (
                    k.clone(),
                    Self {
                        val: v,
                        cwp: &cwp + k.to_case(Case::Snake),
                    },
                )
            })),
            _ => Err(eyre!("Expected an object type")),
        }
        .into_config_result(|| self.cwp)
    }

    /// Create an iterator over all array elements.
    pub fn into_array_iter(self) -> ConfigResult<impl Iterator<Item = ValueParser<'v>>> {
        let cwp = self.cwp.clone();

        match self.val {
            Value::Array(arr) => Ok(arr.iter().enumerate().map(move |(i, v)| Self {
                val: v,
                cwp: &cwp + i.to_string(),
            }))
            .map(|itr| Box::new(itr) as Box<dyn Iterator<Item = ValueParser<'v>>>),
            Value::Object(obj) => obj
                .iter()
                // convert all keys to a usize index of their position in the array
                .map(|(k, v)| k.parse().map(|k| (k, v)))
                // handle any errors during index parsing
                .collect::<Result<Vec<(usize, &'v Value)>, _>>()
                .context("Expected array or array-like object where all keys are indexes; some keys are not indexes")
                // sort by index
                .map(|arr| arr.into_iter().sorted_unstable_by_key(|(k, _)| *k))
                // check that all indexes are present
                .and_then(|itr| {
                    itr.clone()
                        .enumerate()
                        .all(|(expected, (actual, _))| expected == actual)
                        .then_some(itr)
                        .ok_or(eyre!(
                            "Expected array or array-like object where all keys are indexes; some indexes are missing"
                        ))
                })
                // convert to an iterator of value parsers over the values
                .map(|itr| {
                    itr.map(move |(i, v)| Self {
                        val: v,
                        cwp: &cwp + i.to_string(),
                    })
                })
                .map(|itr| Box::new(itr) as Box<dyn Iterator<Item = ValueParser<'v>>>),
            _ => Err(eyre!("Expected an array type")),
        }
        .into_config_result(|| self.cwp)
    }

    /// Parse a u64 value allowing for it to be represented as string or number.
    pub fn parse_u64(&self) -> ConfigResult<u64> {
        match self.val {
            Value::Number(num) => num
                .as_u64()
                .ok_or_else(|| eyre!("Excepted an unsigned integer, got number `{num}`")),
            Value::String(s) => s
                .parse()
                .with_context(|| format!("Expected an unsigned integer, got string `{s}`")),
            _ => Err(eyre!("Expected an unsigned integer, got `{:?}`", self.val)),
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Parse an i64 value allowing for it to be represented as string or number.
    pub fn parse_i64(&self) -> ConfigResult<i64> {
        match self.val {
            Value::Number(num) => num
                .as_i64()
                .ok_or_else(|| eyre!("Excepted a signed integer, got number `{num}`")),
            Value::String(s) => s
                .parse()
                .with_context(|| format!("Expected a signed integer, got string `{s}`")),
            _ => Err(eyre!("Expected an signed integer, got `{:?}`", self.val)),
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Parse an f64 value allowing for it to be represented as string or number and verifying it is
    /// not nan or infinite.
    pub fn parse_f64(&self) -> ConfigResult<f64> {
        let num = self.parse_f64_unchecked()?;
        if num.is_nan() {
            Err(eyre!("Expected a floating point number, got NaN"))
        } else if num.is_infinite() {
            Err(eyre!("Expected a floating point number, got Infinity"))
        } else {
            Ok(num)
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Parse an i64 value allowing for it to be represented as string or number.
    pub fn parse_f64_unchecked(&self) -> ConfigResult<f64> {
        match self.val {
            Value::Number(num) => num
                .as_f64()
                .ok_or_else(|| eyre!("Excepted a floating point number, got number `{num}`")),
            Value::String(s) => s
                .parse()
                .with_context(|| format!("Expected a floating point number, got string `{s}`")),
            _ => Err(eyre!(
                "Expected floating point number, got `{:?}`",
                self.val
            )),
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Parse a u32 value allowing for it to be represented as string or number.
    pub fn parse_u32(&self) -> ConfigResult<u32> {
        self.parse_u64()?
            .try_into()
            .context("Expected a 32-bit unsigned integer")
            .into_config_result(|| self.cwp.clone())
    }

    /// Parse a u16 value allowing for it to be represented as string or number.
    pub fn parse_u16(&self) -> ConfigResult<u16> {
        self.parse_u64()?
            .try_into()
            .context("Expected a 16-bit unsigned integer")
            .into_config_result(|| self.cwp.clone())
    }

    /// Parse an i32 value allowing for it to be represented as string or number.
    pub fn parse_i32(&self) -> ConfigResult<i32> {
        self.parse_i64()?
            .try_into()
            .context("Expected a 32-bit signed integer")
            .into_config_result(|| self.cwp.clone())
    }

    /// Parse a u256 value allowing for it to be represented as string or number.
    pub fn parse_u256(&self) -> ConfigResult<U256> {
        match self.val {
            Value::String(s) => {
                // U256's `parse` assumes the string is hexadecimal - instead, use `from_dec_str`.
                U256::from_dec_str(s).context("Expected a valid U256 string")
            }
            Value::Number(n) => {
                if let Some(n) = n.as_u64() {
                    Ok(n.into())
                } else {
                    Err(eyre!("Expected an unsigned integer"))
                }
            }
            _ => Err(eyre!("Expected a U256, got `{:?}`", self.val)),
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Parse a boolean value allowing for it to be represented as string or bool.
    pub fn parse_bool(&self) -> ConfigResult<bool> {
        match self.val {
            Value::Bool(b) => Ok(*b),
            Value::String(s) => match s.to_ascii_lowercase().as_str() {
                "true" => Ok(true),
                "false" => Ok(false),
                s => Err(eyre!("Expected a boolean, got string `{s}`")),
            },
            _ => Err(eyre!("Expected a boolean, got `{:?}`", self.val)),
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Parse a string value.
    pub fn parse_string(&self) -> ConfigResult<&'v str> {
        match self.val {
            Value::String(s) => Ok(s.as_str()),
            _ => Err(eyre!("Expected a string, got `{:?}`", self.val)),
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Parse an address hash allowing for it to be represented as a hex or base58 string.
    pub fn parse_address_hash(&self) -> ConfigResult<H256> {
        match self.val {
            Value::String(s) => {
                hex_or_base58_to_h256(s).context("Expected a valid address hash in hex or base58")
            }
            _ => Err(eyre!("Expected an address string, got `{:?}`", self.val)),
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Parse a private key allowing for it to be represented as a hex or base58 string.
    pub fn parse_private_key(&self) -> ConfigResult<H256> {
        match self.val {
            Value::String(s) => {
                hex_or_base58_to_h256(s).context("Expected a valid private key in hex or base58")
            }
            _ => Err(eyre!("Expected a private key string")),
        }
        .into_config_result(|| self.cwp.clone())
    }

    /// Use serde to parse a value.
    pub fn parse_value<T: DeserializeOwned>(&self, ctx: &'static str) -> ConfigResult<T> {
        serde_json::from_value(self.val.clone())
            .context(ctx)
            .into_config_result(|| self.cwp.clone())
    }

    /// Use `FromStr`/`str::parse` to parse a value.
    pub fn parse_from_str<T>(&self, ctx: &'static str) -> ConfigResult<T>
    where
        T: FromStr,
        T::Err: StdError + Send + Sync + 'static,
    {
        self.parse_string()?
            .parse()
            .context(ctx)
            .into_config_result(|| self.cwp.clone())
    }

    /// Use FromRawConf to parse a value.
    pub fn parse_from_raw_config<O, T, F>(
        &self,
        filter: F,
        ctx: &'static str,
        agent_name: &'static str,
    ) -> ConfigResult<O>
    where
        O: FromRawConf<T, F>,
        T: Debug + DeserializeOwned,
        F: Default,
    {
        O::from_config_filtered(self.parse_value::<T>(ctx)?, &self.cwp, filter, agent_name)
            .context(ctx)
            .into_config_result(|| self.cwp.clone())
    }
}

pub struct ParseChain<'e, T>(Option<T>, &'e mut ConfigParsingError);
macro_rules! define_basic_parse {
    ($($name:ident: $ty:ty),+) => {
        impl<'v, 'e> ParseChain<'e, ValueParser<'v>> {
            $(pub fn $name(self) -> ParseChain<'e, $ty> {
                self.and_then(|v| v.$name())
            })*
        }
    }
}

define_basic_parse!(
    parse_u64: u64,
    parse_i64: i64,
    parse_f64: f64,
    parse_f64_unchecked: f64,
    parse_u32: u32,
    parse_u16: u16,
    parse_i32: i32,
    parse_u256: U256,
    parse_bool: bool,
    parse_string: &'v str,
    parse_address_hash: H256,
    parse_private_key: H256
);

impl<'v, 'e> ParseChain<'e, ValueParser<'v>> {
    pub fn get_key(self, key: &str) -> Self {
        self.and_then(|v| v.get_key(key))
    }

    pub fn get_opt_key(self, key: &str) -> Self {
        Self(
            self.0
                .and_then(|v| v.get_opt_key(key).take_config_err(self.1))
                .flatten(),
            self.1,
        )
    }

    pub fn parse_value<T: DeserializeOwned>(self, ctx: &'static str) -> ParseChain<'e, T> {
        self.and_then(|v| v.parse_value::<T>(ctx))
    }

    pub fn into_obj_iter(self) -> Option<impl Iterator<Item = (String, ValueParser<'v>)> + 'v> {
        self.and_then(|v| v.into_obj_iter()).end()
    }

    pub fn into_array_iter(self) -> Option<impl Iterator<Item = ValueParser<'v>>> {
        self.and_then(|v| v.into_array_iter()).end()
    }

    pub fn parse_from_str<T>(self, ctx: &'static str) -> ParseChain<'e, T>
    where
        T: FromStr,
        T::Err: StdError + Send + Sync + 'static,
    {
        ParseChain(
            self.0
                .and_then(|v| v.parse_from_str::<T>(ctx).take_config_err(self.1)),
            self.1,
        )
    }

    pub fn parse_from_raw_config<O, T, F>(
        self,
        filter: F,
        ctx: &'static str,
        agent_name: &'static str,
    ) -> ParseChain<'e, O>
    where
        O: FromRawConf<T, F>,
        T: Debug + DeserializeOwned,
        F: Default,
    {
        self.and_then(|v| v.parse_from_raw_config::<O, T, F>(filter, ctx, agent_name))
    }
}

impl<'e, T> ParseChain<'e, T> {
    pub fn from_option(val: Option<T>, err: &'e mut ConfigParsingError) -> Self {
        Self(val, err)
    }

    pub fn and_then<O>(self, f: impl FnOnce(T) -> ConfigResult<O>) -> ParseChain<'e, O> {
        ParseChain(self.0.and_then(|v| f(v).take_config_err(self.1)), self.1)
    }

    pub fn map<O>(self, f: impl FnOnce(T) -> O) -> ParseChain<'e, O> {
        ParseChain(self.0.map(f), self.1)
    }

    pub fn end(self) -> Option<T> {
        self.0
    }

    pub fn unwrap_or(self, default: T) -> T {
        self.0.unwrap_or(default)
    }

    pub fn unwrap_or_else(self, f: impl FnOnce() -> T) -> T {
        self.0.unwrap_or_else(f)
    }
}

impl<'e, T: Default> ParseChain<'e, T> {
    pub fn unwrap_or_default(self) -> T {
        self.0.unwrap_or_default()
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_u256_value_parsing() {
        let num_u64 = 12345u64;
        let num_u256 = U256::from(num_u64);
        let num_str = num_u256.to_string();
        assert_eq!(&num_str, "12345");

        // From String
        let str_value = Value::String(num_str);
        let value_parser = ValueParser::new(Default::default(), &str_value);
        assert_eq!(num_u256, value_parser.parse_u256().unwrap());

        // From Number
        let numeric_value = Value::Number(num_u64.into());
        let value_parser = ValueParser::new(Default::default(), &numeric_value);
        assert_eq!(num_u256, value_parser.parse_u256().unwrap());
    }
}
