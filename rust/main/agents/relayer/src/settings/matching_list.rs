//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.

use std::{
    collections::HashSet,
    fmt,
    fmt::{Debug, Display, Formatter},
    marker::PhantomData,
};

use derive_new::new;
use ethers::utils::hex;
use hyperlane_core::{
    config::StrOrInt, utils::hex_or_base58_or_bech32_to_h256, HyperlaneMessage, QueueOperation,
    H256,
};
use regex::Regex;
use serde::{
    de::{Error, SeqAccess, Visitor},
    Deserialize, Deserializer,
};

/// Defines a set of patterns for determining if a message should or should not
/// be relayed. This is useful for determine if a message matches a given set or
/// rules.
///
/// Valid options for each of the tuple elements are
/// - wildcard "*"
/// - single value in decimal or hex (must start with `0x`) format
/// - list of values in decimal or hex format
#[derive(Debug, Default, Clone)]
pub struct MatchingList(pub Option<Vec<ListElement>>);

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

struct MatchingListVisitor;
impl<'de> Visitor<'de> for MatchingListVisitor {
    type Value = MatchingList;

    fn expecting(&self, fmt: &mut Formatter) -> fmt::Result {
        write!(fmt, "an optional list of matching rules")
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: Error,
    {
        Ok(MatchingList(None))
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        let list: Vec<ListElement> = deserializer.deserialize_seq(MatchingListArrayVisitor)?;
        Ok(if list.is_empty() {
            // this allows for empty matching lists to be treated as if no matching list was set
            MatchingList(None)
        } else {
            MatchingList(Some(list))
        })
    }
}

struct MatchingListArrayVisitor;
impl<'de> Visitor<'de> for MatchingListArrayVisitor {
    type Value = Vec<ListElement>;

    fn expecting(&self, fmt: &mut Formatter) -> fmt::Result {
        write!(fmt, "a list of matching rules")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut rules = seq.size_hint().map(Vec::with_capacity).unwrap_or_default();
        while let Some(rule) = seq.next_element::<ListElement>()? {
            rules.push(rule);
        }
        Ok(rules)
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
            "Expecting either a wildcard \"*\", hex/base58 address string, or list of hex/base58 address strings"
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
        while let Some(i) = seq.next_element::<String>()? {
            values.push(parse_addr(&i)?)
        }
        Ok(Self::Value::Enumerated(values))
    }
}

impl Visitor<'_> for FilterVisitor<RegexWrapper> {
    type Value = RegexWrapper;

    fn expecting(&self, fmt: &mut Formatter) -> fmt::Result {
        write!(fmt, "Expecting a valid regex pattern string")
    }

    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: Error,
    {
        Regex::new(v)
            .map(RegexWrapper)
            .map_err(|err| E::custom(err.to_string()))
    }
}

impl<'de> Deserialize<'de> for MatchingList {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        d.deserialize_option(MatchingListVisitor)
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

/// Wrapper around Regex so we can impl traits for it
#[derive(Clone, Debug)]
pub struct RegexWrapper(pub Regex);

impl<'de> Deserialize<'de> for RegexWrapper {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        d.deserialize_any(FilterVisitor::<RegexWrapper>(Default::default()))
    }
}

impl PartialEq for RegexWrapper {
    fn eq(&self, other: &Self) -> bool {
        self.0.as_str() == other.0.as_str()
    }
}

#[derive(Debug, Deserialize, Clone, PartialEq, new)]
#[serde(tag = "type")]
pub struct ListElement {
    #[serde(default, rename = "messageid")]
    message_id: Filter<H256>,
    #[serde(default, rename = "origindomain")]
    origin_domain: Filter<u32>,
    #[serde(default, rename = "senderaddress")]
    sender_address: Filter<H256>,
    #[serde(default, rename = "destinationdomain")]
    destination_domain: Filter<u32>,
    #[serde(default, rename = "recipientaddress")]
    recipient_address: Filter<H256>,
    #[serde(default, rename = "bodyregex")]
    body_regex: Option<RegexWrapper>,
}

impl Display for ListElement {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{{messageId: {}, originDomain: {}, senderAddress: {}, destinationDomain: {}, recipientAddress: {}}}",
            self.message_id,
            self.origin_domain,
            self.sender_address,
            self.destination_domain,
            self.recipient_address
        )
    }
}

#[derive(Clone, Debug)]
struct MatchInfo<'a> {
    src_msg_id: H256,
    src_domain: u32,
    src_addr: &'a H256,
    dst_domain: u32,
    dst_addr: &'a H256,
    body: String,
}

impl<'a> From<&'a HyperlaneMessage> for MatchInfo<'a> {
    fn from(msg: &'a HyperlaneMessage) -> Self {
        Self {
            src_msg_id: msg.id(),
            src_domain: msg.origin,
            src_addr: &msg.sender,
            dst_domain: msg.destination,
            dst_addr: &msg.recipient,
            body: hex::encode(&msg.body),
        }
    }
}

impl<'a> From<&'a QueueOperation> for MatchInfo<'a> {
    fn from(op: &'a QueueOperation) -> Self {
        Self {
            src_msg_id: op.id(),
            src_domain: op.origin_domain_id(),
            src_addr: op.sender_address(),
            dst_domain: op.destination_domain().id(),
            dst_addr: op.recipient_address(),
            body: hex::encode(op.body()),
        }
    }
}

impl MatchingList {
    pub(crate) fn origin_domains(&self) -> Option<HashSet<u32>> {
        self.domain_filter(|rule| &rule.origin_domain)
    }

    pub(crate) fn destination_domains(&self) -> Option<HashSet<u32>> {
        self.domain_filter(|rule| &rule.destination_domain)
    }

    fn domain_filter<F>(&self, filter: F) -> Option<HashSet<u32>>
    where
        F: Fn(&ListElement) -> &Filter<u32>,
    {
        let rules = match &self.0 {
            Some(rules) => rules,
            None => return None, // No configuration = wildcard (no domain restrictions)
        };

        let mut domains = HashSet::new();
        for rule in rules {
            match filter(rule) {
                Filter::Wildcard => return None,
                Filter::Enumerated(values) => {
                    domains.extend(values.iter().copied());
                }
            }
        }

        Some(domains)
    }

    pub fn with_message_id(message_id: H256) -> Self {
        Self(Some(vec![ListElement {
            message_id: Filter::Enumerated(vec![message_id]),
            origin_domain: Default::default(),
            sender_address: Default::default(),
            destination_domain: Default::default(),
            recipient_address: Default::default(),
            body_regex: Default::default(),
        }]))
    }

    pub fn with_destination_domain(destination_domain: u32) -> Self {
        Self(Some(vec![ListElement {
            message_id: Default::default(),
            origin_domain: Default::default(),
            sender_address: Default::default(),
            destination_domain: Filter::Enumerated(vec![destination_domain]),
            recipient_address: Default::default(),
            body_regex: Default::default(),
        }]))
    }

    /// Check if a message matches any of the rules.
    /// - `default`: What to return if the matching list is empty.
    pub fn msg_matches(&self, msg: &HyperlaneMessage, default: bool) -> bool {
        let info = MatchInfo::from(msg);
        self.matches(&info, default)
    }

    /// Check if queue operation matches any of the rules.
    /// If the matching list is empty, we assume the queue operation does not match.
    pub fn op_matches(&self, op: &QueueOperation) -> bool {
        let info = MatchInfo::from(op);
        self.matches(&info, false)
    }

    fn matches(&self, info: &MatchInfo, default: bool) -> bool {
        if let Some(rules) = &self.0 {
            matches_any_rule(rules.iter(), info)
        } else {
            default
        }
    }
}

fn matches_any_rule<'a>(
    mut rules: impl Iterator<Item = &'a ListElement>,
    info: &MatchInfo,
) -> bool {
    rules.any(|rule| {
        rule.message_id.matches(&info.src_msg_id)
            && rule.origin_domain.matches(&info.src_domain)
            && rule.sender_address.matches(info.src_addr)
            && rule.destination_domain.matches(&info.dst_domain)
            && rule.recipient_address.matches(info.dst_addr)
            && rule
                .body_regex
                .as_ref()
                .map(|regex| regex.0.is_match(&info.body))
                .unwrap_or(true)
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
    hex_or_base58_or_bech32_to_h256(addr_str).map_err(to_serde_err)
}

#[cfg(test)]
mod test {
    use std::collections::HashSet;

    use hyperlane_core::{H160, H256};

    use super::{Filter::*, MatchingList};
    use crate::settings::matching_list::MatchInfo;

    #[test]
    fn basic_config() {
        let list: MatchingList = serde_json::from_str(r#"[{"messageid": "*", "origindomain": "*", "senderaddress": "*", "destinationdomain": "*", "recipientaddress": "*"}, {}]"#).unwrap();
        assert!(list.0.is_some());
        assert_eq!(list.0.as_ref().unwrap().len(), 2);
        let elem = &list.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(elem.message_id, Wildcard);
        assert_eq!(elem.recipient_address, Wildcard);
        assert_eq!(elem.origin_domain, Wildcard);
        assert_eq!(elem.sender_address, Wildcard);

        let elem = &list.0.as_ref().unwrap()[1];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(elem.message_id, Wildcard);
        assert_eq!(elem.recipient_address, Wildcard);
        assert_eq!(elem.origin_domain, Wildcard);
        assert_eq!(elem.sender_address, Wildcard);

        assert!(list.matches(
            &MatchInfo {
                src_msg_id: H256::random(),
                src_domain: 0,
                src_addr: &H256::default(),
                dst_domain: 0,
                dst_addr: &H256::default(),
                body: "".into(),
            },
            false
        ));

        assert!(list.matches(
            &MatchInfo {
                src_msg_id: H256::random(),
                src_domain: 34,
                src_addr: &"0x9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                dst_domain: 5456,
                dst_addr: &H256::default(),
                body: "".into(),
            },
            false
        ))
    }

    #[test]
    fn config_with_address() {
        let list: MatchingList = serde_json::from_str(r#"[{"senderaddress": "0x9d4454B023096f34B160D6B654540c56A1F81688", "recipientaddress": "0x9d4454B023096f34B160D6B654540c56A1F81688"}]"#).unwrap();
        assert!(list.0.is_some());
        assert_eq!(list.0.as_ref().unwrap().len(), 1);
        let elem = &list.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Wildcard);
        assert_eq!(elem.message_id, Wildcard);
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
            &MatchInfo {
                src_msg_id: H256::default(),
                src_domain: 34,
                src_addr: &"0x9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                dst_domain: 5456,
                dst_addr: &"9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                body: "".into(),
            },
            false
        ));

        assert!(!list.matches(
            &MatchInfo {
                src_msg_id: H256::default(),
                src_domain: 34,
                src_addr: &"0x9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                dst_domain: 5456,
                dst_addr: &H256::default(),
                body: "".into(),
            },
            false
        ));
    }

    #[test]
    fn config_with_multiple_domains() {
        let whitelist: MatchingList =
            serde_json::from_str(r#"[{"destinationdomain": ["9913372", "9913373"]}]"#).unwrap();
        assert!(whitelist.0.is_some());
        assert_eq!(whitelist.0.as_ref().unwrap().len(), 1);
        let elem = &whitelist.0.as_ref().unwrap()[0];
        assert_eq!(elem.destination_domain, Enumerated(vec![9913372, 9913373]));
        assert_eq!(elem.message_id, Wildcard);
        assert_eq!(elem.recipient_address, Wildcard);
        assert_eq!(elem.origin_domain, Wildcard);
        assert_eq!(elem.sender_address, Wildcard);
    }

    #[test]
    fn config_with_empty_list_is_none() {
        let whitelist: MatchingList = serde_json::from_str(r#"[]"#).unwrap();
        assert!(whitelist.0.is_none());
    }

    #[test]
    fn matches_empty_list() {
        let info = MatchInfo {
            src_msg_id: H256::default(),
            src_domain: 0,
            src_addr: &H256::default(),
            dst_domain: 0,
            dst_addr: &H256::default(),
            body: "".into(),
        };
        // whitelist use
        assert!(MatchingList(None).matches(&info, true));
        // blacklist use
        assert!(!MatchingList(None).matches(&info, false));
    }

    #[test]
    fn matching_list_domain_methods() {
        let empty = MatchingList(None);
        assert_eq!(empty.origin_domains(), None);
        assert_eq!(empty.destination_domains(), None);

        let wildcard_origin: MatchingList =
            serde_json::from_str(r#"[{"origindomain":"*"}]"#).unwrap();
        assert_eq!(wildcard_origin.origin_domains(), None);

        let wildcard_destination: MatchingList =
            serde_json::from_str(r#"[{"destinationdomain":"*"}]"#).unwrap();
        assert_eq!(wildcard_destination.destination_domains(), None);

        let enumerated_origin: MatchingList =
            serde_json::from_str(r#"[{"origindomain":[1,2]},{"origindomain":[2,3]}]"#).unwrap();
        let expected_origin: HashSet<u32> = [1u32, 2, 3].iter().copied().collect();
        assert_eq!(enumerated_origin.origin_domains(), Some(expected_origin));

        let enumerated_destination: MatchingList = serde_json::from_str(
            r#"[{"destinationdomain":[10,11]},{"destinationdomain":[11,12]}]"#,
        )
        .unwrap();
        let expected_destination: HashSet<u32> = [10u32, 11, 12].iter().copied().collect();
        assert_eq!(
            enumerated_destination.destination_domains(),
            Some(expected_destination)
        );

        // Rule with no domain fields specified (defaults to Wildcard)
        // Critical: many real configs only specify sender/recipient addresses
        let no_domains_specified: MatchingList = serde_json::from_str(
            r#"[{"senderaddress":"0x0000000000000000000000001234567890123456789012345678901234567890"}]"#,
        )
        .unwrap();
        assert_eq!(no_domains_specified.origin_domains(), None);
        assert_eq!(no_domains_specified.destination_domains(), None);

        // Mixed: one rule enumerated, another wildcard → None
        let mixed_origin: MatchingList =
            serde_json::from_str(r#"[{"origindomain":[1,2]},{"origindomain":"*"}]"#).unwrap();
        assert_eq!(mixed_origin.origin_domains(), None);

        // Single scalar domain (common shorthand, not array)
        let single_origin: MatchingList = serde_json::from_str(r#"[{"origindomain":42}]"#).unwrap();
        let expected_single: HashSet<u32> = [42u32].iter().copied().collect();
        assert_eq!(single_origin.origin_domains(), Some(expected_single));

        // Cross-field independence: wildcard dest shouldn't affect origin_domains()
        // Real pattern from mainnet_config.json (e.g., "aave" config)
        let specific_origin_wildcard_dest: MatchingList =
            serde_json::from_str(r#"[{"origindomain":1,"destinationdomain":"*"}]"#).unwrap();
        let expected_specific: HashSet<u32> = [1u32].iter().copied().collect();
        assert_eq!(
            specific_origin_wildcard_dest.origin_domains(),
            Some(expected_specific)
        );
        assert_eq!(specific_origin_wildcard_dest.destination_domains(), None);

        // Multiple rules with same domain (deduplication via HashSet)
        let duplicate_domains: MatchingList =
            serde_json::from_str(r#"[{"origindomain":1},{"origindomain":1},{"origindomain":1}]"#)
                .unwrap();
        let expected_dedup: HashSet<u32> = [1u32].iter().copied().collect();
        assert_eq!(duplicate_domains.origin_domains(), Some(expected_dedup));

        // Bidirectional warp route pattern (from mainnet_config.json)
        let bidirectional: MatchingList = serde_json::from_str(
            r#"[{"origindomain":888888888,"destinationdomain":1},{"origindomain":1,"destinationdomain":888888888}]"#,
        )
        .unwrap();
        let expected_origins: HashSet<u32> = [888888888u32, 1].iter().copied().collect();
        let expected_dests: HashSet<u32> = [1u32, 888888888].iter().copied().collect();
        assert_eq!(bidirectional.origin_domains(), Some(expected_origins));
        assert_eq!(bidirectional.destination_domains(), Some(expected_dests));
    }

    #[test]
    fn supports_base58() {
        serde_json::from_str::<MatchingList>(
            r#"[{"messageid": "*", "origindomain":1399811151,"senderaddress":"DdTMkk9nuqH5LnD56HLkPiKMV3yB3BNEYSQfgmJHa5i7","destinationdomain":11155111,"recipientaddress":"0x6AD4DEBA8A147d000C09de6465267a9047d1c217"}]"#,
        ).unwrap();
    }

    #[test]
    fn supports_sequence_h256s() {
        let json_str = r#"[{"origindomain":1399811151,"senderaddress":["0x6AD4DEBA8A147d000C09de6465267a9047d1c217","0x6AD4DEBA8A147d000C09de6465267a9047d1c218"],"destinationdomain":11155111,"recipientaddress":["0x6AD4DEBA8A147d000C09de6465267a9047d1c217","0x6AD4DEBA8A147d000C09de6465267a9047d1c218"]}]"#;

        // Test parsing directly into MatchingList
        serde_json::from_str::<MatchingList>(json_str).unwrap();

        // Test parsing into a Value and then into MatchingList, which is the path used
        // by the agent config parser.
        let val: serde_json::Value = serde_json::from_str(json_str).unwrap();
        let value_parser =
            hyperlane_base::settings::parser::ValueParser::new(Default::default(), &val);
        crate::settings::parse_matching_list(value_parser).unwrap();
    }

    #[test]
    fn test_matching_list_regex() {
        let list: MatchingList = serde_json::from_str(r#"[{"bodyregex": "0x([0-9]*)$"}]"#).unwrap();
        assert!(list.matches(
            &MatchInfo {
                src_msg_id: H256::default(),
                src_domain: 34,
                src_addr: &"0x9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                dst_domain: 5456,
                dst_addr: &"9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                body: "0x123456789".into(),
            },
            false
        ));

        assert!(!list.matches(
            &MatchInfo {
                src_msg_id: H256::default(),
                src_domain: 34,
                src_addr: &"0x9d4454B023096f34B160D6B654540c56A1F81688"
                    .parse::<H160>()
                    .unwrap()
                    .into(),
                dst_domain: 5456,
                dst_addr: &H256::default(),
                body: "0xdefg".into(),
            },
            false
        ));
    }

    #[test]
    fn test_ica_body_matching_list_regex() {
        // ICA owner-based matching pattern from app-contexts/mainnet_config.json (superswap_ica_v2)
        // Pattern matches: COMMITMENT type + specific owner (Velodrome Universal Router) + any ISM + arbitrary suffix
        // Owner: 0x01D40099fCD87C018969B0e8D4aB1633Fb34763C
        let ica_commitment_owner_pattern =
            r#"^01000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c.{64}"#;
        let commitment_list: MatchingList = serde_json::from_str(&format!(
            r#"[{{"bodyregex": "{}"}}]"#,
            ica_commitment_owner_pattern
        ))
        .unwrap();

        // Test 1: COMMITMENT message with matching owner should match
        // Format: type(01) + owner + ism + salt + commitment
        let commitment_message_body = "01000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000000000001abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        assert!(
            commitment_list.matches(
                &MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453, // Base
                    src_addr: &H256::default(),
                    dst_domain: 10, // Optimism
                    dst_addr: &H256::default(),
                    body: commitment_message_body.into(),
                },
                false
            ),
            "COMMITMENT message with matching owner should match"
        );

        // Test 2: CALLS message should NOT match (wrong type)
        let calls_message_body = "00000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000000000001deadbeef";

        assert!(
            !commitment_list.matches(
                &MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 10,
                    dst_addr: &H256::default(),
                    body: calls_message_body.into(),
                },
                false
            ),
            "CALLS message should NOT match COMMITMENT pattern"
        );

        // Test 3: REVEAL message should NOT match (different layout, no owner field)
        // Real REVEAL message from https://gist.github.com/yorhodes/e4b19fa63c6195cb725efbc3011e3abb
        // Format: type(02) + ism + commitment
        let reveal_message_body = "020000000000000000000000000000000000000000000000000000000000000000002cd4f1bbd58a9c7fc481e3b8d319cea8795011b9dde770fa122c2e585fa01f69";

        assert!(
            !commitment_list.matches(
                &MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 10, // Optimism
                    src_addr: &H256::default(),
                    dst_domain: 1135, // Lisk
                    dst_addr: &H256::default(),
                    body: reveal_message_body.into(),
                },
                false
            ),
            "REVEAL message should NOT match COMMITMENT+owner pattern"
        );

        // Test 4: COMMITMENT message with different owner should NOT match
        let different_owner_commitment = "01000000000000000000000002d40099fcd87c018969b0e8d4ab1633fb34763c000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000000000001abcdef";

        assert!(
            !commitment_list.matches(
                &MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 10,
                    dst_addr: &H256::default(),
                    body: different_owner_commitment.into(),
                },
                false
            ),
            "COMMITMENT message with different owner should NOT match"
        );

        // Test 5: Pattern should match arbitrary suffixes (no end anchor)
        let commitment_with_extra_data = "01000000000000000000000001d40099fcd87c018969b0e8d4ab1633fb34763c000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000000000000000001abcdefcafebabe1234567890extradatahere";

        assert!(
            commitment_list.matches(
                &MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 42220, // Celo
                    dst_addr: &H256::default(),
                    body: commitment_with_extra_data.into(),
                },
                false
            ),
            "Pattern should match messages with arbitrary suffixes"
        );

        // Test 6: REVEAL type matching (no owner filtering)
        let reveal_pattern = r#"^02.{64}"#;
        let reveal_list: MatchingList =
            serde_json::from_str(&format!(r#"[{{"bodyregex": "{}"}}]"#, reveal_pattern)).unwrap();

        assert!(
            reveal_list.matches(
                &MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 10,
                    src_addr: &H256::default(),
                    dst_domain: 1135,
                    dst_addr: &H256::default(),
                    body: reveal_message_body.into(),
                },
                false
            ),
            "REVEAL message should match type-based pattern"
        );

        // Test 7: REVEAL pattern should NOT match CALLS or COMMITMENT
        assert!(
            !reveal_list.matches(
                &MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 10,
                    dst_addr: &H256::default(),
                    body: calls_message_body.into(),
                },
                false
            ),
            "CALLS message should NOT match REVEAL pattern"
        );

        assert!(
            !reveal_list.matches(
                &MatchInfo {
                    src_msg_id: H256::default(),
                    src_domain: 8453,
                    src_addr: &H256::default(),
                    dst_domain: 10,
                    dst_addr: &H256::default(),
                    body: commitment_message_body.into(),
                },
                false
            ),
            "COMMITMENT message should NOT match REVEAL pattern"
        );
    }
}
