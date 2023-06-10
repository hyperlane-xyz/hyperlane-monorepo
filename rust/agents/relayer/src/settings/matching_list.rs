use std::fmt;
use std::fmt::{Debug, Display, Formatter};
use std::marker::PhantomData;

use eyre::{Report, Result};

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
#[derive(Debug, Deserialize, Default, Clone, PartialEq)]
#[serde(transparent)]
pub struct MatchingList(pub Option<Vec<MatchItem>>);

impl MatchingList {
    /// Create a new [MatchingList] from a list of elements.
    /// - `elements`: The list of elements to use.
    #[allow(dead_code)] // False positive, due being in both bin and lib?
    pub fn from_elements(elements: Vec<MatchItem>) -> Self {
        // What is the significance of MatchingList(None) vs MatchingList(Some(empty vec))?
        // Implementing this scenrio as MatchingList(None) for now, potentially revisit later.
        Self(if elements.is_empty() {
            None
        } else {
            Some(elements)
        })
    }

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

#[derive(Debug, Clone, PartialEq)]
pub enum Filter<T> {
    Wildcard,
    Enumerated(Vec<T>),
}

impl<T> Default for Filter<T> {
    fn default() -> Self {
        Self::Wildcard
    }
}

// Cannot do generic Filter<T> as underlying conversion methods are not from Traits.
// Could create a macro for implementations, but overkill for now.
#[allow(dead_code)] // False positive, due being in both bin and lib?
impl Filter<u32> {
    pub fn from_csv(csv: &str) -> Result<Self> {
        let items = csv_to_u32_vec(csv)?;

        Ok(if items.is_empty() {
            Filter::Wildcard
        } else {
            Filter::Enumerated(items)
        })
    }
}

#[allow(dead_code)] // False positive, due being in both bin and lib?
impl Filter<H256> {
    pub fn from_csv(csv: &str) -> Result<Self> {
        let items: Vec<H256> = csv_to_h160_vec(csv)?.iter().map(|h| H256::from(*h)).collect();

        Ok(if items.is_empty() {
            Filter::Wildcard
        } else {
            Filter::Enumerated(items)
        })
    }
}

impl<T: PartialEq> Filter<T> {
    pub fn matches(&self, v: &T) -> bool {
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

#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(tag = "type")]
pub struct MatchItem {
    #[serde(default, rename = "originDomain")]
    pub origin_domain: Filter<u32>,

    #[serde(default, rename = "senderAddress")]
    pub sender_address: Filter<H256>,

    #[serde(default, rename = "destinationDomain")]
    pub destination_domain: Filter<u32>,

    #[serde(default, rename = "recipientAddress")]
    pub recipient_address: Filter<H256>,
}

impl MatchItem {
    #[allow(dead_code)] // False positive, due being in both bin and lib?
    pub fn from_csv(csv: &str) -> Result<Self> {
        let item = csv.split(':').collect::<Vec<_>>();
        if item.len() != 4 {
            return Err(Report::msg(format!(
                "Invalid format; need four ':' separated items: '{csv}'"
            )));
        }

        Ok(Self {
            origin_domain: Filter::<u32>::from_csv(item[0])?,
            sender_address: Filter::<H256>::from_csv(item[1])?,
            destination_domain: Filter::<u32>::from_csv(item[2])?,
            recipient_address: Filter::<H256>::from_csv(item[3])?,
        })
    }
}

impl Display for MatchItem {
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

fn matches_any_rule<'a>(mut rules: impl Iterator<Item = &'a MatchItem>, info: MatchInfo) -> bool {
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

fn csv_to_u32_vec(csv: &str) -> Result<Vec<u32>> {
    let csv = csv.trim();

    if csv == "*" || csv.is_empty() {
        Ok(vec![])
    } else {
        csv.split(',')
            .map(|s| {
                let s = s.trim();
                let radix = if s.starts_with("0x") { 16 } else { 10 };
                let s = s.trim_start_matches("0x");
                u32::from_str_radix(s, radix)
                    .map_err(|_| Report::msg(format!("Error parsing '{s}' in '{csv}'")))
            })
            .collect::<Result<Vec<_>, _>>()
    }
}

pub fn csv_to_h160_vec(csv: &str) -> Result<Vec<H160>> {
    let csv = csv.trim();

    if csv == "*" || csv.is_empty() {
        Ok(vec![])
    } else {
        csv.split(',')
            .map(|s| {
                let s = s.trim().trim_start_matches("0x");
                s.parse::<H160>()
                    .map_err(|_| Report::msg(format!("Error parsing '{s}' in '{csv}'")))
            })
            .collect::<Result<Vec<_>, _>>()
    }
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
