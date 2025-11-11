use std::error::Error;
use std::fmt;

use gateway_api_client::models::ProgrammaticScryptoSborValue;
use hex::FromHex;
use scrypto::math::Decimal;

use hyperlane_core::ChainResult;

use crate::events::Bytes32;
use crate::events::{DispatchEvent, InsertedIntoTreeEvent, ProcessIdEvent};
use crate::{GasPayment, HyperlaneRadixError};

/// Radix event parse errors
#[derive(Debug)]
pub enum EventParseError {
    /// Invalid event type
    InvalidEventType(&'static str),
    /// Missing field
    MissingField(&'static str),
    /// Missing field type
    InvalidFieldType(&'static str),
    /// Hex decoding error
    HexDecodeError(hex::FromHexError),
    /// Others
    Other(String),
}

impl fmt::Display for EventParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidEventType(expected) => {
                write!(f, "Invalid event type, expected {expected}")
            }
            Self::MissingField(field) => write!(f, "Missing field: {field}"),
            Self::InvalidFieldType(field) => write!(f, "Invalid field type for: {field}"),
            Self::HexDecodeError(e) => write!(f, "Hex decode error: {e}"),
            Self::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl Error for EventParseError {}

impl From<hex::FromHexError> for EventParseError {
    fn from(err: hex::FromHexError) -> Self {
        EventParseError::HexDecodeError(err)
    }
}

/// parses an inserted into tree event from the sbor value to a usable type
pub fn parse_inserted_into_tree_event(
    value: ProgrammaticScryptoSborValue,
) -> ChainResult<InsertedIntoTreeEvent> {
    match value {
        ProgrammaticScryptoSborValue::Tuple(tuple) => {
            // Verify the tuple represents an InsertedIntoTreeEvent
            if let Some(Some(type_name)) = tuple.type_name.as_ref() {
                if type_name != "InsertedIntoTreeEvent" {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidEventType("InsertedIntoTreeEvent"),
                    )
                    .into());
                }
            }

            // Extract the fields
            if tuple.fields.len() != 2 {
                return Err(
                    Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                        "Expected 2 fields, got {}",
                        tuple.fields.len()
                    )))
                    .into(),
                );
            }

            // Parse the id field (Bytes32)
            let id = match &tuple.fields[0] {
                ProgrammaticScryptoSborValue::Bytes(bytes) => {
                    // Verify field name
                    if let Some(Some(field_name)) = bytes.field_name.as_ref() {
                        if field_name != "id" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("id"),
                            )
                            .into());
                        }
                    }

                    // Decode hex string to bytes
                    let bytes_array = <[u8; 32]>::from_hex(&bytes.hex)
                        .map_err(|e| Into::<HyperlaneRadixError>::into(EventParseError::from(e)))?;
                    Bytes32(bytes_array)
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("id"),
                    )
                    .into())
                }
            };

            // Parse the index field (u32)
            let index = match &tuple.fields[1] {
                ProgrammaticScryptoSborValue::U32(u32_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = u32_val.field_name.as_ref() {
                        if field_name != "index" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("index"),
                            )
                            .into());
                        }
                    }

                    // Parse the string value to u32
                    u32_val.value.parse::<u32>().map_err(|_| {
                        Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                            "Failed to parse index value: {}",
                            u32_val.value
                        )))
                    })?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("index"),
                    )
                    .into())
                }
            };

            Ok(InsertedIntoTreeEvent { id, index })
        }
        _ => Err(
            Into::<HyperlaneRadixError>::into(EventParseError::InvalidEventType("Tuple")).into(),
        ),
    }
}

/// parses an dispatch event from the sbor value to a usable type
pub fn parse_dispatch_event(value: ProgrammaticScryptoSborValue) -> ChainResult<DispatchEvent> {
    match value {
        ProgrammaticScryptoSborValue::Tuple(tuple) => {
            // Verify the tuple represents a DispatchEvent
            if let Some(Some(type_name)) = tuple.type_name.as_ref() {
                if type_name != "DispatchEvent" {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidEventType("DispatchEvent"),
                    )
                    .into());
                }
            }

            // Extract the fields
            if tuple.fields.len() != 4 {
                return Err(
                    Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                        "Expected 4 fields, got {}",
                        tuple.fields.len()
                    )))
                    .into(),
                );
            }

            // Parse the destination field (u32)
            let destination = match &tuple.fields[0] {
                ProgrammaticScryptoSborValue::U32(u32_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = u32_val.field_name.as_ref() {
                        if field_name != "destination" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("destination"),
                            )
                            .into());
                        }
                    }

                    // Parse the string value to u32
                    u32_val.value.parse::<u32>().map_err(|_| {
                        Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                            "Failed to parse destination value: {}",
                            u32_val.value
                        )))
                    })?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("destination"),
                    )
                    .into())
                }
            };

            // Parse the recipient field (Bytes32)
            let recipient = match &tuple.fields[1] {
                ProgrammaticScryptoSborValue::Bytes(bytes) => {
                    // Verify field name
                    if let Some(Some(field_name)) = bytes.field_name.as_ref() {
                        if field_name != "recipient" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("recipient"),
                            )
                            .into());
                        }
                    }

                    // Decode hex string to bytes
                    let bytes_array = <[u8; 32]>::from_hex(&bytes.hex)
                        .map_err(|e| Into::<HyperlaneRadixError>::into(EventParseError::from(e)))?;
                    Bytes32(bytes_array)
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("recipient"),
                    )
                    .into())
                }
            };

            // Parse the message field (Vec<u8>)
            let message = match &tuple.fields[2] {
                ProgrammaticScryptoSborValue::Bytes(bytes) => {
                    // Verify field name
                    if let Some(Some(field_name)) = bytes.field_name.as_ref() {
                        if field_name != "message" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("message"),
                            )
                            .into());
                        }
                    }

                    // Decode hex string to Vec<u8>
                    Vec::from_hex(&bytes.hex)
                        .map_err(|e| Into::<HyperlaneRadixError>::into(EventParseError::from(e)))?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("message"),
                    )
                    .into())
                }
            };

            // Parse the sequence field (u32)
            let sequence = match &tuple.fields[3] {
                ProgrammaticScryptoSborValue::U32(u32_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = u32_val.field_name.as_ref() {
                        if field_name != "sequence" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("sequence"),
                            )
                            .into());
                        }
                    }

                    // Parse the string value to u32
                    u32_val.value.parse::<u32>().map_err(|_| {
                        Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                            "Failed to parse sequence value: {}",
                            u32_val.value
                        )))
                    })?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("sequence"),
                    )
                    .into())
                }
            };

            Ok(DispatchEvent {
                destination,
                recipient,
                message,
                sequence,
            })
        }
        _ => Err(
            Into::<HyperlaneRadixError>::into(EventParseError::InvalidEventType("Tuple")).into(),
        ),
    }
}

/// parses an process event from the sbor value to a usable type
pub fn parse_process_id_event(value: ProgrammaticScryptoSborValue) -> ChainResult<ProcessIdEvent> {
    match value {
        ProgrammaticScryptoSborValue::Tuple(tuple) => {
            // Verify the tuple represents a ProcessIdEvent
            if let Some(Some(type_name)) = tuple.type_name.as_ref() {
                if type_name != "ProcessIdEvent" {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidEventType("ProcessIdEvent"),
                    )
                    .into());
                }
            }

            // Extract the fields
            if tuple.fields.len() != 2 {
                return Err(
                    Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                        "Expected 2 fields, got {}",
                        tuple.fields.len()
                    )))
                    .into(),
                );
            }

            // Parse the message_id field (Bytes32)
            let message_id = match &tuple.fields[0] {
                ProgrammaticScryptoSborValue::Bytes(bytes) => {
                    // Verify field name
                    if let Some(Some(field_name)) = bytes.field_name.as_ref() {
                        if field_name != "message_id" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("message_id"),
                            )
                            .into());
                        }
                    }

                    // Decode hex string to bytes
                    let bytes_array = <[u8; 32]>::from_hex(&bytes.hex)
                        .map_err(|e| Into::<HyperlaneRadixError>::into(EventParseError::from(e)))?;
                    Bytes32(bytes_array)
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("message_id"),
                    )
                    .into())
                }
            };

            // Parse the sequence field (u32)
            let sequence = match &tuple.fields[1] {
                ProgrammaticScryptoSborValue::U32(u32_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = u32_val.field_name.as_ref() {
                        if field_name != "sequence" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("sequence"),
                            )
                            .into());
                        }
                    }

                    // Parse the string value to u32
                    u32_val.value.parse::<u32>().map_err(|_| {
                        Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                            "Failed to parse sequence value: {}",
                            u32_val.value
                        )))
                    })?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("sequence"),
                    )
                    .into())
                }
            };

            Ok(ProcessIdEvent {
                message_id,
                sequence,
            })
        }
        _ => Err(
            Into::<HyperlaneRadixError>::into(EventParseError::InvalidEventType("Tuple")).into(),
        ),
    }
}

/// parses a gas payment event from the sbor value to a usable type
pub fn parse_gas_payment_event(value: ProgrammaticScryptoSborValue) -> ChainResult<GasPayment> {
    match value {
        ProgrammaticScryptoSborValue::Tuple(tuple) => {
            // Verify the tuple represents a GasPayment
            if let Some(Some(type_name)) = tuple.type_name.as_ref() {
                if type_name != "GasPayment" {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidEventType("GasPayment"),
                    )
                    .into());
                }
            }

            // Extract the fields
            if tuple.fields.len() != 6 {
                return Err(
                    Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                        "Expected 6 fields, got {}",
                        tuple.fields.len()
                    )))
                    .into(),
                );
            }

            // Parse the message_id field (Bytes32)
            let message_id = match &tuple.fields[0] {
                ProgrammaticScryptoSborValue::Bytes(bytes) => {
                    // Verify field name
                    if let Some(Some(field_name)) = bytes.field_name.as_ref() {
                        if field_name != "message_id" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("message_id"),
                            )
                            .into());
                        }
                    }

                    // Decode hex string to bytes
                    let bytes_array = <[u8; 32]>::from_hex(&bytes.hex)
                        .map_err(|e| Into::<HyperlaneRadixError>::into(EventParseError::from(e)))?;
                    Bytes32(bytes_array)
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("message_id"),
                    )
                    .into())
                }
            };

            // Parse the destination_domain field (u32)
            let destination_domain = match &tuple.fields[1] {
                ProgrammaticScryptoSborValue::U32(u32_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = u32_val.field_name.as_ref() {
                        if field_name != "destination_domain" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("destination_domain"),
                            )
                            .into());
                        }
                    }

                    // Parse the string value to u32
                    u32_val.value.parse::<u32>().map_err(|_| {
                        Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                            "Failed to parse destination_domain value: {}",
                            u32_val.value
                        )))
                    })?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("destination_domain"),
                    )
                    .into())
                }
            };

            // Parse the gas_amount field (Decimal)
            let gas_amount = match &tuple.fields[2] {
                ProgrammaticScryptoSborValue::Decimal(decimal_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = decimal_val.field_name.as_ref() {
                        if field_name != "gas_amount" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("gas_amount"),
                            )
                            .into());
                        }
                    }

                    // Parse the string value to Decimal
                    decimal_val.value.parse::<Decimal>().map_err(|_| {
                        Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                            "Failed to parse gas_amount value: {}",
                            decimal_val.value
                        )))
                    })?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("gas_amount"),
                    )
                    .into())
                }
            };

            // Parse the payment field (Decimal)
            let payment = match &tuple.fields[3] {
                ProgrammaticScryptoSborValue::Decimal(decimal_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = decimal_val.field_name.as_ref() {
                        if field_name != "payment" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("payment"),
                            )
                            .into());
                        }
                    }

                    // Parse the string value to Decimal
                    decimal_val.value.parse::<Decimal>().map_err(|_| {
                        Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                            "Failed to parse payment value: {}",
                            decimal_val.value
                        )))
                    })?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("payment"),
                    )
                    .into())
                }
            };

            // Parse the resource_address field (ResourceAddress)
            let resource_address = match &tuple.fields[4] {
                ProgrammaticScryptoSborValue::Reference(custom_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = custom_val.field_name.as_ref() {
                        if field_name != "resource_address" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("resource_address"),
                            )
                            .into());
                        }
                    }

                    custom_val.value.clone()
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("resource_address"),
                    )
                    .into())
                }
            };

            // Parse the sequence field (u32)
            let sequence = match &tuple.fields[5] {
                ProgrammaticScryptoSborValue::U32(u32_val) => {
                    // Verify field name
                    if let Some(Some(field_name)) = u32_val.field_name.as_ref() {
                        if field_name != "sequence" {
                            return Err(Into::<HyperlaneRadixError>::into(
                                EventParseError::InvalidFieldType("sequence"),
                            )
                            .into());
                        }
                    }

                    // Parse the string value to u32
                    u32_val.value.parse::<u32>().map_err(|_| {
                        Into::<HyperlaneRadixError>::into(EventParseError::Other(format!(
                            "Failed to parse sequence value: {}",
                            u32_val.value
                        )))
                    })?
                }
                _ => {
                    return Err(Into::<HyperlaneRadixError>::into(
                        EventParseError::InvalidFieldType("sequence"),
                    )
                    .into())
                }
            };

            Ok(GasPayment {
                message_id,
                destination_domain,
                gas_amount,
                payment,
                resource_address,
                sequence,
            })
        }
        _ => Err(
            Into::<HyperlaneRadixError>::into(EventParseError::InvalidEventType("Tuple")).into(),
        ),
    }
}
