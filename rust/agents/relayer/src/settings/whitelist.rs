use std::fmt;
use std::fmt::Formatter;
use std::marker::PhantomData;
use std::num::ParseIntError;

use ethers::types::H256;
use serde::de::{Error, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use abacus_core::AbacusMessage;

/// Whitelist defining which messages should be relayed. If no wishlist is provided ALL
/// messages will be relayed.
///
/// Valid options for each of the tuple elements are
/// - wildcard "*"
/// - single value in decimal or hex (must start with `0x`) format
/// - list of values in decimal or hex format
///
/// 4-tuple in the form `(sourceDomain, sourceAddress, destinationDomain, destinationAddress)`.
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(transparent)]
pub struct Whitelist(Option<Vec<WhitelistElement>>);

#[derive(Debug, Clone)]
enum Filter<T> {
    Wildcard,
    Enumerated(Vec<T>),
}

impl<T: PartialEq> Filter<T> {
    fn matches(&self, v: &T) -> bool {
        match self {
            Filter::Wildcard => true,
            Filter::Enumerated(list) => list.iter().any(|i| i == v),
        }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StrOrInt<'a> {
    Str(&'a str),
    Int(u32),
}

impl TryFrom<StrOrInt<'_>> for u32 {
    type Error = ParseIntError;

    fn try_from(v: StrOrInt) -> Result<Self, Self::Error> {
        match v {
            StrOrInt::Str(s) => s.parse(),
            StrOrInt::Int(i) => Ok(i),
        }
    }
}

struct FilterVisitor<T>(PhantomData<T>);
impl<'de> Visitor<'de> for FilterVisitor<u32> {
    type Value = Filter<u32>;

    fn expecting(&self, fmt: &mut Formatter) -> fmt::Result {
        write!(fmt, "Expecting either a wildcard \"*\", decimal/hex value string, or list of decimal/hex value strings")
    }

    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
    where
        E: Error,
    {
        if v <= u32::MAX as u64 {
            Ok(Self::Value::Enumerated(vec![v as u32]))
        } else {
            Err(E::custom("Id must fit within a u32 value"))
        }
    }

    fn visit_u32<E>(self, v: u32) -> Result<Self::Value, E>
    where
        E: Error,
    {
        Ok(Self::Value::Enumerated(vec![v]))
    }

    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: Error,
    {
        Ok(if v == "*" {
            Self::Value::Wildcard
        } else {
            Self::Value::Enumerated(vec![v.parse::<u32>().map_err(to_serde_err)?])
        })
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(i) = seq.next_element::<StrOrInt>()? {
            values.push(i.try_into().map_err(to_serde_err)?);
        }
        Ok(Self::Value::Enumerated(values))
    }
}

fn to_serde_err<IE: ToString, OE: Error>(e: IE) -> OE {
    OE::custom(e.to_string())
}

impl<'de> Visitor<'de> for FilterVisitor<H256> {
    type Value = Filter<H256>;

    fn expecting(&self, fmt: &mut Formatter) -> fmt::Result {
        write!(
            fmt,
            "Expecting either a wildcard \"*\", hex address string, or list of hex address strings"
        )
    }

    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: Error,
    {
        Ok(if v == "*" {
            Self::Value::Wildcard
        } else {
            Self::Value::Enumerated(vec![v.parse::<H256>().map_err(to_serde_err)?])
        })
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(i) = seq.next_element::<&str>()? {
            values.push(i.parse::<H256>().map_err(to_serde_err)?)
        }
        Ok(Self::Value::Enumerated(values))
    }
}

impl<'de> Deserialize<'de> for Filter<u32> {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        d.deserialize_any(FilterVisitor::<u32>(Default::default()))
    }
}

impl<'de> Deserialize<'de> for Filter<H256> {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        d.deserialize_any(FilterVisitor::<H256>(Default::default()))
    }
}

/// The tuple of (sourceDomain, sourceAddress, destinationDomain, destinationAddress).
type FilterTuple = (Filter<u32>, Filter<H256>, Filter<u32>, Filter<H256>);

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", from = "FilterTuple")]
struct WhitelistElement {
    source_domain: Filter<u32>,
    source_address: Filter<H256>,
    destination_domain: Filter<u32>,
    destination_address: Filter<H256>,
}

impl From<FilterTuple> for WhitelistElement {
    fn from(tup: FilterTuple) -> Self {
        Self {
            source_domain: tup.0,
            source_address: tup.1,
            destination_domain: tup.2,
            destination_address: tup.3,
        }
    }
}

impl Whitelist {
    pub fn msg_matches(&self, msg: &AbacusMessage) -> bool {
        self.matches(msg.origin, &msg.sender, msg.destination, &msg.recipient)
    }

    pub fn matches(
        &self,
        src_domain: u32,
        src_addr: &H256,
        dst_domain: u32,
        dst_addr: &H256,
    ) -> bool {
        if let Some(rules) = &self.0 {
            rules.iter().any(|rule| {
                rule.source_domain.matches(&src_domain)
                    && rule.source_address.matches(src_addr)
                    && rule.destination_domain.matches(&dst_domain)
                    && rule.destination_address.matches(dst_addr)
            })
        } else {
            // by default if there is no whitelist, allow everything
            true
        }
    }
}
