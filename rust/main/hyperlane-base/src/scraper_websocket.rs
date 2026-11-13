//! Shared scraper-proxy transport, freshness policy, and event wire types.

mod client;
mod session;
pub use client::*;
pub use session::{ScraperSession, SessionEvent};

use eyre::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// A scraper-proxy stream subscription request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeMessage<'a> {
    /// Streams requested on this connection.
    pub streams: Vec<SubscribeStream<'a>>,
    /// Protocol message type.
    #[serde(rename = "type")]
    pub message_type: &'a str,
}

impl SubscribeMessage<'_> {
    /// Expected acknowledgement for the requested live streams.
    pub fn confirmation(&self) -> Vec<SubscribedStream> {
        self.streams
            .iter()
            .map(|stream| SubscribedStream {
                confirmations: stream.confirmations,
                domains: stream.domains.clone(),
                event_type: stream.event_type.to_owned(),
            })
            .collect()
    }
}

/// Reject acknowledgements that change the requested live streams.
pub fn validate_subscription(
    expected: &[SubscribedStream],
    actual: &[SubscribedStream],
) -> Result<()> {
    if actual != expected {
        bail!("Scraper-proxy subscription confirmation does not match request");
    }
    Ok(())
}

/// One event stream within a subscription request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeStream<'a> {
    /// Custom live confirmation delay; omitted for canonical streams.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmations: Option<u32>,
    /// Domains included in the stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains: Option<Vec<u32>>,
    /// Scraper event type.
    pub event_type: &'a str,
}

/// Messages emitted by scraper-proxy.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage<T> {
    /// The connection is ready to receive a subscription.
    Ready,
    /// The subscription was accepted.
    Subscribed {
        /// Streams accepted by scraper-proxy.
        streams: Vec<SubscribedStream>,
    },
    /// Live stream recovery boundary for this connection.
    LiveStart(LiveStartBoundary),
    /// No safe checkpoint is available; retain RPC indexing for this domain.
    LiveStartUnavailable {
        /// Origin whose checkpoint is unavailable.
        domain: u32,
    },
    /// Provisional history was rolled back; consumers must recover before resuming.
    Rollback,
    /// One event from a requested stream.
    Event(EventMessage<T>),
    /// The server rejected the request or stream.
    Error {
        /// Human-readable server error.
        error: String,
    },
    /// A forwards-compatible protocol message not understood by this client.
    #[serde(other)]
    Other,
}

/// A connection-scoped RPC recovery target, in the chain's native height units.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStartBoundary {
    /// Origin domain.
    pub domain: u32,
    /// Decimal native height, slot, or state version.
    pub height: String,
    /// Checkpoint block hash.
    pub hash: String,
    /// Custom confirmation count, absent for the canonical stream.
    pub confirmations: Option<u32>,
    /// Event types and contract identities covered by the boundary.
    pub streams: Vec<LiveStartStream>,
}

/// One event type covered by a live-start checkpoint.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStartStream {
    /// Event type requested by the agent.
    pub event_type: String,
    /// Contract address in 20- or 32-byte hexadecimal form.
    pub address: String,
}

/// One stream echoed by scraper-proxy after subscription.
#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscribedStream {
    /// Custom confirmation delay accepted by the server.
    pub confirmations: Option<u32>,
    /// Domains accepted for this stream.
    pub domains: Option<Vec<u32>>,
    /// Scraper event type.
    pub event_type: String,
}

/// Common envelope around scraper event-specific data.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMessage<T> {
    /// Event-specific payload.
    pub data: T,
    /// Hyperlane domain identifier.
    pub domain: u32,
    /// Scraper event type.
    pub event_type: String,
    /// Immutable upper bound of sparse legacy gas-payment cursors.
    #[serde(default)]
    pub legacy_max_stream_cursor: Option<String>,
    /// Durable database row ID when the stream uses row cursors.
    pub row_id: Option<String>,
    /// Durable logical cursor when the stream uses versioned cursor semantics.
    pub stream_cursor: Option<String>,
    /// Durable event sequence, encoded as a decimal string when the stream is sequenced.
    pub sequence: Option<String>,
}

/// A non-negative integer accepted in either JSON representation used by scraper-proxy.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum StringOrNumber {
    /// Decimal string representation.
    String(String),
    /// JSON number representation.
    Number(u64),
}

impl StringOrNumber {
    /// Parses this value as a `u32`, naming the field in errors.
    pub fn as_u32(&self, field: &str) -> Result<u32> {
        let value = self.as_u64(field)?;
        value
            .try_into()
            .with_context(|| format!("{field} exceeds u32"))
    }

    /// Parses this value as a `u64`, naming the field in errors.
    pub fn as_u64(&self, field: &str) -> Result<u64> {
        match self {
            Self::String(value) => value
                .parse()
                .with_context(|| format!("Invalid {field} value {value}")),
            Self::Number(value) => Ok(*value),
        }
    }
}

/// Canonical wire projection for Merkle insertion streams consumed by both agents.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MerkleEventData {
    /// Origin block containing the insertion.
    pub block_number: StringOrNumber,
    /// Hyperlane origin domain.
    pub domain: u32,
    /// Merkle leaf index, also the stream sequence.
    pub leaf_index: StringOrNumber,
    /// Configured Merkle hook address.
    pub merkle_tree_hook: String,
    /// Inserted message identifier.
    pub message_id: String,
}

impl MerkleEventData {
    /// Validate the wire projection against its subscription and stream sequence.
    pub fn decode(
        self,
        domain: u32,
        hook: hyperlane_core::H256,
        sequence: u32,
    ) -> Result<(hyperlane_core::MerkleTreeInsertion, u64)> {
        use eyre::bail;
        use hyperlane_core::{MerkleTreeInsertion, H256};
        if self.domain != domain {
            bail!("Merkle payload domain does not match event envelope");
        }
        if parse_address(&self.merkle_tree_hook)? != hook {
            bail!("Merkle event hook does not match configured hook");
        }
        let leaf_index = self.leaf_index.as_u32("Merkle leaf index")?;
        if leaf_index != sequence {
            bail!("Merkle leaf index does not match stream sequence");
        }
        let bytes = parse_hex(&self.message_id)?;
        if bytes.len() != 32 {
            bail!("Invalid Merkle message ID length {}", bytes.len());
        }
        Ok((
            MerkleTreeInsertion::new(leaf_index, H256::from_slice(&bytes)),
            self.block_number.as_u64("Merkle block number")?,
        ))
    }
}

/// Decode an EVM or full-width scraper contract address.
pub fn parse_address(value: &str) -> Result<hyperlane_core::H256> {
    hyperlane_core::bytes_to_address(parse_hex(value)?).context("Invalid scraper event address")
}

fn parse_hex(value: &str) -> Result<Vec<u8>> {
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("\\x"))
        .unwrap_or(value);
    hex::decode(value).context("Invalid hexadecimal WebSocket event field")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct TestData {
        value: String,
    }

    #[test]
    fn custom_confirmation_acknowledgement_must_match_requested_delay() {
        let request = SubscribeMessage {
            streams: vec![SubscribeStream {
                confirmations: Some(3),
                domains: Some(vec![1]),
                event_type: "merkle_tree_insertion",
            }],
            message_type: "subscribe",
        };
        let mut actual = request.confirmation();
        validate_subscription(&request.confirmation(), &actual).expect("test protocol");
        actual[0].confirmations = Some(1);
        assert!(validate_subscription(&request.confirmation(), &actual).is_err());
        actual[0].confirmations = None;
        assert!(validate_subscription(&request.confirmation(), &actual).is_err());
        assert!(matches!(
            serde_json::from_str::<ServerMessage<serde_json::Value>>(
                r#"{"type":"rollback","domain":1,"eventType":"merkle_tree_insertion","toHeight":"12"}"#
            ).expect("test protocol"),
            ServerMessage::Rollback
        ));
    }

    #[test]
    fn serializes_live_subscription() {
        let message = SubscribeMessage {
            streams: vec![SubscribeStream {
                confirmations: None,
                domains: Some(vec![5]),
                event_type: "gas_payment",
            }],
            message_type: "subscribe",
        };

        assert_eq!(
            serde_json::to_value(message).expect("subscription should serialize"),
            serde_json::json!({
                "streams": [{
                    "domains": [5],
                    "eventType": "gas_payment"
                }],
                "type": "subscribe"
            })
        );
    }

    #[test]
    fn deserializes_generic_event_envelope() {
        let message: ServerMessage<TestData> = serde_json::from_value(serde_json::json!({
            "type": "event",
            "data": { "value": "payload" },
            "domain": 5,
            "eventType": "dispatch",
            "sequence": "42"
        }))
        .expect("event should deserialize");

        match message {
            ServerMessage::Event(event) => {
                assert_eq!(
                    event.data,
                    TestData {
                        value: "payload".to_owned()
                    }
                );
                assert_eq!(event.domain, 5);
                assert_eq!(event.event_type, "dispatch");
                assert_eq!(event.row_id, None);
                assert_eq!(event.stream_cursor, None);
                assert_eq!(event.sequence.as_deref(), Some("42"));
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn deserializes_live_event_without_sequence() {
        let message: ServerMessage<TestData> = serde_json::from_value(serde_json::json!({
            "type": "event",
            "data": { "value": "payload" },
            "domain": 5,
            "eventType": "gas_payment"
        }))
        .expect("live event should deserialize");

        match message {
            ServerMessage::Event(event) => {
                assert_eq!(event.row_id, None);
                assert_eq!(event.stream_cursor, None);
                assert_eq!(event.sequence, None);
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn deserializes_subscription_confirmation() {
        let message: ServerMessage<TestData> = serde_json::from_value(serde_json::json!({
            "type": "subscribed",
            "streams": [{
                "domains": [5, 9],
                "eventType": "dispatch"
            }]
        }))
        .expect("subscription confirmation should deserialize");

        match message {
            ServerMessage::Subscribed { streams } => assert_eq!(
                streams,
                vec![SubscribedStream {
                    confirmations: None,
                    domains: Some(vec![5, 9]),
                    event_type: "dispatch".to_owned(),
                }]
            ),
            _ => panic!("expected subscription confirmation"),
        }
    }

    #[test]
    fn deserializes_ready_with_extra_capabilities() {
        let message: ServerMessage<TestData> = serde_json::from_value(serde_json::json!({
            "liveStartVersion": 1, "type": "ready"
        }))
        .expect("ready message");
        assert!(matches!(message, ServerMessage::Ready));
    }

    #[test]
    fn parses_string_or_number() {
        let string: StringOrNumber = serde_json::from_str("\"42\"").expect("string value");
        let number: StringOrNumber = serde_json::from_str("43").expect("number value");

        assert_eq!(string.as_u32("sequence").expect("valid u32"), 42);
        assert_eq!(number.as_u64("sequence").expect("valid u64"), 43);
    }
}
