//! Wire types shared by agents consuming scraper-proxy WebSocket streams.

use eyre::{Context, Result};
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

/// One event stream within a subscription request.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeStream<'a> {
    /// Durable cursors from which replay should resume.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursors: Option<Vec<SequenceCursor>>,
    /// Domains included in the stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains: Option<Vec<u32>>,
    /// Scraper event type.
    pub event_type: &'a str,
}

/// Durable sequence cursor for one contract and domain.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceCursor {
    /// Contract address encoded for scraper-proxy.
    pub address: String,
    /// Whether scraper-proxy should replay events after the cursor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_replay: Option<bool>,
    /// Last processed sequence, encoded as a decimal string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<String>,
    /// Hyperlane domain identifier.
    pub domain: u32,
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
    /// Historical replay reached the scraper's current cursor.
    #[serde(rename_all = "camelCase")]
    CaughtUp {
        /// Contract address for the cursor.
        address: String,
        /// Hyperlane domain identifier.
        domain: u32,
        /// Scraper event type.
        event_type: String,
        /// Last available sequence, encoded as a decimal string.
        sequence: String,
    },
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

/// One stream echoed by scraper-proxy after subscription.
#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscribedStream {
    /// Durable cursors accepted for this stream.
    pub cursors: Option<Vec<SubscribedCursor>>,
    /// Domains accepted for this stream.
    pub domains: Option<Vec<u32>>,
    /// Scraper event type.
    pub event_type: String,
}

/// One durable cursor echoed by scraper-proxy after subscription.
#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscribedCursor {
    /// Contract address encoded for scraper-proxy.
    pub address: String,
    /// Last processed sequence, encoded as a decimal string.
    pub after_sequence: Option<String>,
    /// Hyperlane domain identifier.
    pub domain: u32,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct TestData {
        value: String,
    }

    #[test]
    fn serializes_subscription_protocol() {
        let message = SubscribeMessage {
            streams: vec![SubscribeStream {
                cursors: Some(vec![SequenceCursor {
                    address: "0x1234".to_owned(),
                    allow_replay: Some(true),
                    after_sequence: Some("41".to_owned()),
                    domain: 5,
                }]),
                domains: Some(vec![5]),
                event_type: "dispatch",
            }],
            message_type: "subscribe",
        };

        assert_eq!(
            serde_json::to_value(message).expect("subscription should serialize"),
            serde_json::json!({
                "streams": [{
                    "cursors": [{
                        "address": "0x1234",
                        "allowReplay": true,
                        "afterSequence": "41",
                        "domain": 5
                    }],
                    "domains": [5],
                    "eventType": "dispatch"
                }],
                "type": "subscribe"
            })
        );
    }

    #[test]
    fn omits_optional_cursor_fields_for_live_streams() {
        let message = SubscribeMessage {
            streams: vec![SubscribeStream {
                cursors: None,
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
            ServerMessage::Event(event) => assert_eq!(event.sequence, None),
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
                    cursors: None,
                    domains: Some(vec![5, 9]),
                    event_type: "dispatch".to_owned(),
                }]
            ),
            _ => panic!("expected subscription confirmation"),
        }
    }

    #[test]
    fn parses_string_or_number() {
        let string: StringOrNumber = serde_json::from_str("\"42\"").expect("string value");
        let number: StringOrNumber = serde_json::from_str("43").expect("number value");

        assert_eq!(string.as_u32("sequence").expect("valid u32"), 42);
        assert_eq!(number.as_u64("sequence").expect("valid u64"), 43);
    }
}
