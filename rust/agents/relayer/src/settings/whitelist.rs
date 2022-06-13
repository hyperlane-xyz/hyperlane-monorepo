use std::fmt;
use std::fmt::{Display, Formatter};
use std::marker::PhantomData;
use std::num::ParseIntError;

use ethers::prelude::*;
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
/// - defaults to wildcards
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(transparent)]
pub struct Whitelist(Option<Vec<WhitelistElement>>);

#[derive(Debug, Clone, PartialEq)]
enum Filter<T> {
    Wildcard,
    Enumerated(Vec<T>),
}

impl<T> Default for Filter<T> {
    fn default() -> Self {
        Self::Wildcard
    }
}

impl<T: PartialEq> Filter<T> {
    fn matches(&self, v: &T) -> bool {
        match self {
            Filter::Wildcard => true,
            Filter::Enumerated(list) => list.iter().any(|i| i == v),
        }
    }
}

impl<T: Display> Display for Filter<T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Wildcard => write!(f, "*"),
            Self::Enumerated(l) if l.len() == 1 => write!(f, "{}", l[0]),
            Self::Enumerated(l) => {
                write!(f, "[")?;
                for i in l {
                    write!(f, "{i},")?;
                }
                write!(f, "]")
            }
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

    fn visit_u32<E>(self, v: u32) -> Result<Self::Value, E>
    where
        E: Error,
    {
        Ok(Self::Value::Enumerated(vec![v]))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
    where
        E: Error,
    {
        if v <= u32::MAX as u64 {
            Ok(Self::Value::Enumerated(vec![v as u32]))
        } else {
            Err(E::custom("Domain Id must fit within a u32 value"))
        }
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
            Self::Value::Enumerated(vec![parse_addr(v)?])
        })
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(i) = seq.next_element::<&str>()? {
            values.push(parse_addr(i)?)
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

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
struct WhitelistElement {
    #[serde(default)]
    source_domain: Filter<u32>,
    #[serde(default)]
    source_address: Filter<H256>,
    #[serde(default)]
    destination_domain: Filter<u32>,
    #[serde(default)]
    destination_address: Filter<H256>,
}

impl Display for WhitelistElement {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{{sourceDomain: {}, sourceAddress: {}, destinationDomain: {}, destinationAddress: {}}}", self.source_domain, self.source_address, self.destination_domain, self.destination_address)
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

impl Display for Whitelist {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        if let Some(wl) = &self.0 {
            write!(f, "[")?;
            for i in wl {
                write!(f, "{i},")?;
            }
            write!(f, "]")
        } else {
            write!(f, "null")
        }
    }
}

fn to_serde_err<IE: ToString, OE: Error>(e: IE) -> OE {
    OE::custom(e.to_string())
}

fn parse_addr<E: Error>(addr_str: &str) -> Result<H256, E> {
    if addr_str.len() <= 42 {
        addr_str.parse::<H160>().map(H256::from)
    } else {
        addr_str.parse::<H256>()
    }
    .map_err(to_serde_err)
}

#[cfg(test)]
mod test {
    use ethers::prelude::*;

    use super::{Filter::*, Whitelist};

    #[test]
    fn basic_config() {
        let whitelist: Whitelist = serde_json::from_str(r#"[{"sourceDomain": "*", "sourceAddress": "*", "destinationDomain": "*", "destinationAddress": "*"}, {}]"#).unwrap();
        assert!(whitelist.0.is_some());
        assert_eq!(whitelist.0.as_ref().unwrap().len(), 2);
        let elem = &whitelist.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(elem.destination_address, Wildcard);
        assert_eq!(elem.source_domain, Wildcard);
        assert_eq!(elem.source_address, Wildcard);

        let elem = &whitelist.0.as_ref().unwrap()[1];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(elem.destination_address, Wildcard);
        assert_eq!(elem.source_domain, Wildcard);
        assert_eq!(elem.source_address, Wildcard);
    }

    #[test]
    fn config_with_address() {
        let whitelist: Whitelist = serde_json::from_str(r#"[{"sourceAddress": "0x9d4454B023096f34B160D6B654540c56A1F81688", "destinationAddress": "9d4454B023096f34B160D6B654540c56A1F81688"}]"#).unwrap();
        assert!(whitelist.0.is_some());
        assert_eq!(whitelist.0.as_ref().unwrap().len(), 1);
        let elem = &whitelist.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(
            elem.destination_address,
            Enumerated(vec!["0x9d4454B023096f34B160D6B654540c56A1F81688"
                .parse::<H160>()
                .unwrap()
                .into()])
        );
        assert_eq!(elem.source_domain, Wildcard);
        assert_eq!(
            elem.source_address,
            Enumerated(vec!["0x9d4454B023096f34B160D6B654540c56A1F81688"
                .parse::<H160>()
                .unwrap()
                .into()])
        );
    }

    #[test]
    fn config_with_multiple_domains() {
        let whitelist: Whitelist =
            serde_json::from_str(r#"[{"destinationDomain": ["13372", "13373"]}]"#).unwrap();
        assert!(whitelist.0.is_some());
        assert_eq!(whitelist.0.as_ref().unwrap().len(), 1);
        let elem = &whitelist.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Enumerated(vec![13372, 13373]));
        assert_eq!(elem.destination_address, Wildcard);
        assert_eq!(elem.source_domain, Wildcard);
        assert_eq!(elem.source_address, Wildcard);
    }
}
