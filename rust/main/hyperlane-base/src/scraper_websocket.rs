//! Wire types shared by agents consuming scraper-proxy WebSocket streams.

use std::collections::HashMap;

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
    pub cursors: Option<Vec<StreamCursor>>,
    /// Domains included in the stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains: Option<Vec<u32>>,
    /// Scraper event type.
    pub event_type: &'a str,
    /// Versioned logical cursor semantics requested for this stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_cursor_version: Option<u32>,
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

/// Durable gas-payment stream cursor for one contract and domain.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GasPaymentCursor {
    /// Contract address encoded for scraper-proxy.
    pub address: String,
    /// Last processed logical stream cursor, encoded as a decimal string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_stream_cursor: Option<String>,
    /// Hyperlane domain identifier.
    pub domain: u32,
}

/// A cursor accepted by scraper-proxy.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum StreamCursor {
    /// Native contract sequence cursor.
    Sequence(SequenceCursor),
    /// Versioned gas-payment stream cursor.
    GasPayment(GasPaymentCursor),
}

/// Messages emitted by scraper-proxy.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage<T> {
    /// The connection is ready to receive a subscription.
    Ready {
        /// Logical cursor versions supported by event type.
        #[serde(default, rename = "streamCursorVersions")]
        stream_cursor_versions: HashMap<String, u32>,
    },
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
        /// Immutable upper bound of sparse legacy gas-payment cursors.
        #[serde(default)]
        legacy_max_stream_cursor: Option<String>,
        /// Last available row ID, encoded as a decimal string.
        row_id: Option<String>,
        /// Last available logical stream cursor, encoded as a decimal string.
        stream_cursor: Option<String>,
        /// Last available sequence, encoded as a decimal string.
        sequence: Option<String>,
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
    /// Versioned logical cursor semantics accepted for this stream.
    pub stream_cursor_version: Option<u32>,
}

/// One durable cursor echoed by scraper-proxy after subscription.
#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscribedCursor {
    /// Contract address encoded for scraper-proxy.
    pub address: String,
    /// Last processed logical stream cursor, encoded as a decimal string.
    pub after_stream_cursor: Option<String>,
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
                cursors: Some(vec![StreamCursor::Sequence(SequenceCursor {
                    address: "0x1234".to_owned(),
                    allow_replay: Some(true),
                    after_sequence: Some("41".to_owned()),
                    domain: 5,
                })]),
                domains: Some(vec![5]),
                event_type: "dispatch",
                stream_cursor_version: None,
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
                stream_cursor_version: None,
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
    fn serializes_gas_payment_stream_cursor() {
        let message = SubscribeMessage {
            streams: vec![SubscribeStream {
                cursors: Some(vec![StreamCursor::GasPayment(GasPaymentCursor {
                    address: "0x1234".to_owned(),
                    after_stream_cursor: Some("41".to_owned()),
                    domain: 5,
                })]),
                domains: Some(vec![5]),
                event_type: "gas_payment",
                stream_cursor_version: Some(1),
            }],
            message_type: "subscribe",
        };
        assert_eq!(
            serde_json::to_value(message).expect("subscription should serialize"),
            serde_json::json!({
                "streams": [{
                    "cursors": [{ "address": "0x1234", "afterStreamCursor": "41", "domain": 5 }],
                    "domains": [5],
                    "eventType": "gas_payment",
                    "streamCursorVersion": 1
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
    fn deserializes_gas_payment_event_and_caught_up_marker() {
        let event: ServerMessage<TestData> = serde_json::from_value(serde_json::json!({
            "type": "event",
            "data": { "value": "payload" },
            "domain": 5,
            "eventType": "gas_payment",
            "legacyMaxStreamCursor": "20",
            "rowId": "52",
            "streamCursor": "42"
        }))
        .expect("gas payment event should deserialize");
        match event {
            ServerMessage::Event(event) => {
                assert_eq!(event.legacy_max_stream_cursor.as_deref(), Some("20"));
                assert_eq!(event.row_id.as_deref(), Some("52"));
                assert_eq!(event.stream_cursor.as_deref(), Some("42"));
            }
            _ => panic!("expected event"),
        }

        let marker: ServerMessage<TestData> = serde_json::from_value(serde_json::json!({
            "type": "caught_up",
            "address": "0x1234",
            "domain": 5,
            "eventType": "gas_payment",
            "legacyMaxStreamCursor": "20",
            "streamCursor": "42"
        }))
        .expect("gas payment marker should deserialize");
        match marker {
            ServerMessage::CaughtUp {
                legacy_max_stream_cursor,
                row_id,
                stream_cursor,
                sequence,
                ..
            } => {
                assert_eq!(legacy_max_stream_cursor.as_deref(), Some("20"));
                assert_eq!(row_id, None);
                assert_eq!(stream_cursor.as_deref(), Some("42"));
                assert_eq!(sequence, None);
            }
            _ => panic!("expected caught-up marker"),
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
                    stream_cursor_version: None,
                }]
            ),
            _ => panic!("expected subscription confirmation"),
        }
    }

    #[test]
    fn deserializes_ready_cursor_capabilities() {
        let message: ServerMessage<TestData> = serde_json::from_value(serde_json::json!({
            "streamCursorVersions": { "gas_payment": 1 },
            "type": "ready"
        }))
        .expect("ready message should deserialize");

        match message {
            ServerMessage::Ready {
                stream_cursor_versions,
            } => assert_eq!(stream_cursor_versions.get("gas_payment"), Some(&1)),
            _ => panic!("expected ready message"),
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
