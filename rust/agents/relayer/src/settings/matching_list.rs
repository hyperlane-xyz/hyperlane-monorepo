use std::fmt;
use std::fmt::{Debug, Display, Formatter};
use std::marker::PhantomData;

use serde::de::{Error, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use hyperlane_core::config::StrOrInt;
use hyperlane_core::{HyperlaneMessage, H160, H256};

/// Defines a set of patterns for determining if a message should or should not
/// be relayed. This is useful for determine if a message matches a given set or
/// rules.
///
/// Valid options for each of the tuple elements are
/// - wildcard "*"
/// - single value in decimal or hex (must start with `0x`) format
/// - list of values in decimal or hex format
#[derive(Debug, Deserialize, Default, Clone)]
#[serde(transparent)]
pub struct MatchingList(Option<Vec<ListElement>>);

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

impl<T: Debug> Display for Filter<T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Wildcard => write!(f, "*"),
            Self::Enumerated(l) if l.len() == 1 => write!(f, "{:?}", l[0]),
            Self::Enumerated(l) => {
                write!(f, "[")?;
                for i in l {
                    write!(f, "{i:?},")?;
                }
                write!(f, "]")
            }
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
#[serde(tag = "type")]
struct ListElement {
    #[serde(default, rename = "originDomain")]
    origin_domain: Filter<u32>,
    #[serde(default, rename = "senderAddress")]
    sender_address: Filter<H256>,
    #[serde(default, rename = "destinationDomain")]
    destination_domain: Filter<u32>,
    #[serde(default, rename = "recipientAddress")]
    recipient_address: Filter<H256>,
}

impl Display for ListElement {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{{originDomain: {}, senderAddress: {}, destinationDomain: {}, recipientAddress: {}}}",
            self.origin_domain,
            self.sender_address,
            self.destination_domain,
            self.recipient_address
        )
    }
}

#[derive(Copy, Clone, Debug)]
struct MatchInfo<'a> {
    src_domain: u32,
    src_addr: &'a H256,
    dst_domain: u32,
    dst_addr: &'a H256,
}

impl<'a> From<&'a HyperlaneMessage> for MatchInfo<'a> {
    fn from(msg: &'a HyperlaneMessage) -> Self {
        Self {
            src_domain: msg.origin,
            src_addr: &msg.sender,
            dst_domain: msg.destination,
            dst_addr: &msg.recipient,
        }
    }
}

impl MatchingList {
    /// Check if a message matches any of the rules.
    /// - `default`: What to return if the the matching list is empty.
    pub fn msg_matches(&self, msg: &HyperlaneMessage, default: bool) -> bool {
        self.matches(msg.into(), default)
    }

    /// Check if a message matches any of the rules.
    /// - `default`: What to return if the the matching list is empty.
    fn matches(&self, info: MatchInfo, default: bool) -> bool {
        if let Some(rules) = &self.0 {
            matches_any_rule(rules.iter(), info)
        } else {
            default
        }
    }
}

fn matches_any_rule<'a>(mut rules: impl Iterator<Item = &'a ListElement>, info: MatchInfo) -> bool {
    rules.any(|rule| {
        rule.origin_domain.matches(&info.src_domain)
            && rule.sender_address.matches(info.src_addr)
            && rule.destination_domain.matches(&info.dst_domain)
            && rule.recipient_address.matches(info.dst_addr)
    })
}

impl Display for MatchingList {
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
    use hyperlane_core::{H160, H256};

    use crate::settings::matching_list::MatchInfo;

    use super::{Filter::*, MatchingList};

    #[test]
    fn basic_config() {
        let list: MatchingList = serde_json::from_str(r#"[{"originDomain": "*", "senderAddress": "*", "destinationDomain": "*", "recipientAddress": "*"}, {}]"#).unwrap();
        assert!(list.0.is_some());
        assert_eq!(list.0.as_ref().unwrap().len(), 2);
        let elem = &list.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(elem.recipient_address, Wildcard);
        assert_eq!(elem.origin_domain, Wildcard);
        assert_eq!(elem.sender_address, Wildcard);

        let elem = &list.0.as_ref().unwrap()[1];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(elem.recipient_address, Wildcard);
        assert_eq!(elem.origin_domain, Wildcard);
        assert_eq!(elem.sender_address, Wildcard);

        assert!(list.matches(
            MatchInfo {
                src_domain: 0,
                src_addr: &H256::default(),
                dst_domain: 0,
                dst_addr: &H256::default()
            },
            false
        ));

        assert!(list.matches(
            MatchInfo {
                src_domain: 34,
                src_addr: &"0x9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                dst_domain: 5456,
                dst_addr: &H256::default()
            },
            false
        ))
    }

    #[test]
    fn config_with_address() {
        let list: MatchingList = serde_json::from_str(r#"[{"senderAddress": "0x9d4454B023096f34B160D6B654540c56A1F81688", "recipientAddress": "9d4454B023096f34B160D6B654540c56A1F81688"}]"#).unwrap();
        assert!(list.0.is_some());
        assert_eq!(list.0.as_ref().unwrap().len(), 1);
        let elem = &list.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(
            elem.recipient_address,
            Enumerated(vec!["0x9d4454B023096f34B160D6B654540c56A1F81688"
                .parse::<H160>()
                .unwrap()
                .into()])
        );
        assert_eq!(elem.origin_domain, Wildcard);
        assert_eq!(
            elem.sender_address,
            Enumerated(vec!["0x9d4454B023096f34B160D6B654540c56A1F81688"
                .parse::<H160>()
                .unwrap()
                .into()])
        );

        assert!(list.matches(
            MatchInfo {
                src_domain: 34,
                src_addr: &"0x9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                dst_domain: 5456,
                dst_addr: &"9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into()
            },
            false
        ));

        assert!(!list.matches(
            MatchInfo {
                src_domain: 34,
                src_addr: &"0x9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                dst_domain: 5456,
                dst_addr: &H256::default()
            },
            false
        ));
    }

    #[test]
    fn config_with_multiple_domains() {
        let whitelist: MatchingList =
            serde_json::from_str(r#"[{"destinationDomain": ["13372", "13373"]}]"#).unwrap();
        assert!(whitelist.0.is_some());
        assert_eq!(whitelist.0.as_ref().unwrap().len(), 1);
        let elem = &whitelist.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Enumerated(vec![13372, 13373]));
        assert_eq!(elem.recipient_address, Wildcard);
        assert_eq!(elem.origin_domain, Wildcard);
        assert_eq!(elem.sender_address, Wildcard);
    }

    #[test]
    fn matches_empty_list() {
        let info = MatchInfo {
            src_domain: 0,
            src_addr: &H256::default(),
            dst_domain: 0,
            dst_addr: &H256::default(),
        };
        // whitelist use
        assert!(MatchingList(None).matches(info, true));
        // blacklist use
        assert!(!MatchingList(None).matches(info, false));
    }
}
