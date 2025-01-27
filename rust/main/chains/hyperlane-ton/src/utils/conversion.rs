use std::{collections::HashMap, sync::Arc};

use anyhow::Error;
use base64::{engine::general_purpose, Engine};
use num_bigint::BigUint;
use tonlib_core::{
    cell::{
        dict::predefined_readers::{key_reader_uint, val_reader_cell},
        ArcCell, BagOfCells, Cell, CellBuilder, TonCellError,
    },
    TonAddress, TonHash,
};
use tracing::info;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneMessage, H160, H256, H512, U256,
};

use crate::{
    error::HyperlaneTonError,
    run_get_method::{StackItem, StackValue},
    t_metadata::TMetadata,
};

pub struct ConversionUtils;

impl ConversionUtils {
    pub fn base64_to_h512(hash: &str) -> Result<H512, Error> {
        let mut padded = [0u8; 64];
        general_purpose::STANDARD
            .decode_slice(hash, &mut padded)
            .map_err(|e| Error::msg(format!("Failed to decode base64 hash: {}", e)))?;

        Ok(H512::from_slice(&padded))
    }
    pub fn base64_to_h256(hash: &str) -> Result<H256, Error> {
        let decoded_bytes = general_purpose::STANDARD
            .decode(hash)
            .map_err(|e| Error::msg(format!("Failed to decode base64: {}", e)))?;

        if decoded_bytes.len() != 32 {
            return Err(Error::msg(format!(
                "Decoded bytes length is {}. Expected 32 bytes.",
                decoded_bytes.len()
            )));
        }

        Ok(H256::from_slice(&decoded_bytes))
    }

    pub fn metadata_to_cell(metadata: &[u8]) -> Result<Cell, TonCellError> {
        let tmetadata = TMetadata::from_bytes(metadata).unwrap();
        let mut writer = CellBuilder::new();
        writer
            .store_slice(&tmetadata.origin_merkle_hook)
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store metadata slice: {:?}", e))
            })?;

        writer.store_slice(&tmetadata.root).map_err(|e| {
            TonCellError::CellBuilderError(format!("Failed to store root slice: {:?}", e))
        })?;

        writer
            .store_uint(32, &BigUint::from(tmetadata.index))
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store index: {:?}", e))
            })?;

        let mut signature_dict = HashMap::new();

        for (key, signature) in &tmetadata.signatures {
            let mut signature_builder = CellBuilder::new();
            if signature.len() != 65 {
                return Err(TonCellError::CellBuilderError(format!(
                    "Invalid signature length: expected 65 bytes, got {}",
                    signature.len()
                )));
            }

            let r = BigUint::from_bytes_be(&signature[0..32]);
            let s = BigUint::from_bytes_be(&signature[32..64]);
            let v = signature[64];

            signature_builder.store_u8(8, v).map_err(|_| {
                TonCellError::CellBuilderError("Failed to store 'v' in signature".to_string())
            })?;

            signature_builder.store_uint(256, &r).map_err(|_| {
                TonCellError::CellBuilderError("Failed to store 'r' in signature".to_string())
            })?;

            signature_builder.store_uint(256, &s).map_err(|_| {
                TonCellError::CellBuilderError("Failed to store 's' in signature".to_string())
            })?;

            let signature_cell = signature_builder.build().map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to build signature cell: {:?}", e))
            })?;
            let data = signature_cell.data().to_vec();

            signature_dict.insert(BigUint::from(*key), data);
        }
        let value_writer =
            |builder: &mut CellBuilder, value: Vec<u8>| -> Result<(), TonCellError> {
                builder.store_slice(&value).map_err(|_| {
                    TonCellError::CellBuilderError(format!("Failed to store signature cell"))
                })?;

                Ok(())
            };

        writer
            .store_dict(32, value_writer, signature_dict)
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store dictionary: {:?}", e))
            })?;

        let cell = writer.build().map_err(|e| {
            TonCellError::CellBuilderError(format!("Failed to build cell: {:?}", e))
        })?;
        info!("metadata cell:{:?}", cell);

        Ok(cell)
    }

    /// Creates a linked list of cells, each containing up to 6 addresses.
    /// If there are more than 6 addresses, the next cell is created with a reference to the previous cell.
    pub fn create_address_linked_cells(addresses: &[H256]) -> Result<Cell, TonCellError> {
        let mut remaining_addresses = addresses;
        let mut current_cell = CellBuilder::new();

        loop {
            let addresses_in_cell = remaining_addresses.len().min(3);
            info!(
                "Creating a new cell segment with {} addresses.",
                addresses_in_cell
            );

            // We write down the addresses ourselves
            for address in &remaining_addresses[..addresses_in_cell] {
                info!("Storing address: {:?}", address);
                current_cell.store_uint(256, &BigUint::from_bytes_be(address.as_bytes()))?;
            }
            remaining_addresses = &remaining_addresses[addresses_in_cell..];

            // If the remaining addresses are greater than 0, create the next cell
            if !remaining_addresses.is_empty() {
                info!("More addresses remaining, creating reference to next cell.");
                let next_cell = ConversionUtils::create_address_linked_cells(remaining_addresses)?;
                current_cell.store_reference(&Arc::new(next_cell))?;
            }
            // We build a cell and return it if only the current addresses remain
            let result_cell = current_cell.build()?;
            info!(
                "Finished creating cell list with root cell hash: {:?}",
                result_cell
            );

            return Ok(result_cell);
        }
    }

    /// Parses the root `root_cell` and extracts a dictionary of addresses with their storage locations.
    /// Uses a nested dictionary to store strings in the `BigUint -> Vec<String>` format.
    pub fn parse_address_storage_locations(
        root_cell: &ArcCell,
    ) -> Result<HashMap<BigUint, Vec<String>>, TonCellError> {
        let mut storage_locations: HashMap<BigUint, Vec<String>> = HashMap::new();

        let parsed = root_cell
            .parser()
            .load_dict(256, key_reader_uint, val_reader_cell)?;

        for (key, value_cell) in &parsed {
            let mut storage_list = Vec::new();
            info!("key:{:?} value_cell:{:?}", key, value_cell);
            if let Some(inner_cell) = value_cell.references().first() {
                info!("inner cell:{:?}", inner_cell);

                let bits_remaining = inner_cell.bit_len();
                let bytes_needed = (bits_remaining + 7) / 8;
                let mut string_bytes = vec![0u8; bytes_needed];
                let mut parser = inner_cell.parser();

                parser.load_slice(&mut string_bytes)?;

                let storage_string = String::from_utf8(string_bytes).map_err(|_| {
                    TonCellError::BagOfCellsDeserializationError(
                        "Invalid UTF-8 string in storage location".to_string(),
                    )
                })?;

                info!("Storage_string:{:?} key:{:?}", storage_string, key);
                storage_list.push(storage_string);
            } else {
                return Err(TonCellError::BagOfCellsDeserializationError(
                    "Expected reference in cell but found none".to_string(),
                ));
            }

            storage_locations.insert(key.clone(), storage_list);
        }
        info!("Parsed storage locations: {:?}", storage_locations);
        Ok(storage_locations)
    }
    /// Decodes a Base64 string into a `BagOfCells` and returns the root cell.
    pub fn parse_root_cell_from_boc(boc_base64: &str) -> Result<Arc<Cell>, TonCellError> {
        let boc_bytes = general_purpose::STANDARD.decode(boc_base64).map_err(|_| {
            TonCellError::BagOfCellsDeserializationError(
                "Failed to decode BOC from Base64".to_string(),
            )
        })?;
        println!("boc_bytes:{:?}", boc_bytes);
        info!("boc_bytes:{:?}", boc_bytes);

        let boc = BagOfCells::parse(&boc_bytes)?;
        let root_cell = boc.single_root()?.clone();

        Ok(root_cell)
    }
    /// Parses the first address from a BOC (Bag of Cells) encoded as a Base64 string.
    /// This function decodes the BOC, extracts the root cell, and retrieves the address stored in it.
    pub async fn parse_address_from_boc(boc: &str) -> Result<TonAddress, TonCellError> {
        let cell = Self::parse_root_cell_from_boc(boc)?;
        let mut parser = cell.parser();
        let address = parser.load_address()?;

        Ok(address)
    }
    pub fn ton_address_to_h256(address: &TonAddress) -> H256 {
        H256::from_slice(address.hash_part.as_slice())
    }

    pub fn u256_to_biguint(value: U256) -> BigUint {
        let mut bytes = [0u8; 32]; // 256 bit = 32 byte
        value.to_little_endian(&mut bytes);
        BigUint::from_bytes_le(&bytes)
    }
    pub fn h256_to_ton_address(h256: &H256, workchain: i32) -> TonAddress {
        TonAddress::new(workchain, &TonHash::from(&h256.0))
    }
    pub fn parse_eth_address_to_h160(address: &str) -> Result<H160, HyperlaneTonError> {
        let trimmed_address = address.trim_start_matches("0x");
        if trimmed_address.len() != 40 {
            return Err(HyperlaneTonError::ConversionFailed(
                "Invalid Ethereum address length".to_string(),
            ));
        }

        let bytes = hex::decode(trimmed_address).map_err(|e| {
            HyperlaneTonError::ConversionFailed(format!("Failed to decode address: {}", e))
        })?;

        if bytes.len() != 20 {
            return Err(HyperlaneTonError::ConversionFailed(
                "Decoded address does not have 20 bytes (expected for H160)".to_string(),
            ));
        }

        Ok(H160::from_slice(&bytes))
    }
    pub fn extract_boc_from_stack_item(
        stack_item: &StackItem,
    ) -> Result<&String, ChainCommunicationError> {
        match &stack_item.value {
            StackValue::String(boc) => Ok(boc),
            _ => Err(ChainCommunicationError::from(
                HyperlaneTonError::ParsingError(format!(
                    "Failed to get boc: unexpected data type: {:?}",
                    stack_item.value
                )),
            )),
        }
    }

    pub fn parse_stack_item_to_u32(stack: &[StackItem], index: usize) -> ChainResult<u32> {
        let stack_item = stack.get(index).ok_or_else(|| {
            ChainCommunicationError::CustomError(format!("No stack item at index {index}"))
        })?;
        let str = match &stack_item.value {
            StackValue::String(value) => value,
            _ => {
                return Err(ChainCommunicationError::from(
                    HyperlaneTonError::ParsingError(
                        "Failed to get boc: unexpected data type".to_string(),
                    ),
                ));
            }
        };

        u32::from_str_radix(&str[2..], 16).map_err(|_| {
            ChainCommunicationError::CustomError(format!(
                "Failed to parse value at index {}: {:?}",
                index, stack_item.value
            ))
        })
    }

    pub fn build_hyperlane_message_cell(message: &HyperlaneMessage) -> Result<Cell, TonCellError> {
        let body = CellBuilder::new()
            .store_slice(message.body.as_slice())
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store body slice: {:?}", e))
            })?
            .build()
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to build body cell: {:?}", e))
            })?;

        let mut writer = CellBuilder::new();

        writer
            .store_uint(8, &BigUint::from(message.version))
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store version: {:?}", e))
            })?;
        writer
            .store_uint(32, &BigUint::from(message.nonce))
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store nonce: {:?}", e))
            })?;
        writer
            .store_uint(32, &BigUint::from(message.origin))
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store origin: {:?}", e))
            })?;
        writer
            .store_uint(256, &BigUint::from_bytes_be(message.sender.as_bytes()))
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store sender: {:?}", e))
            })?;
        writer
            .store_uint(32, &BigUint::from(message.destination))
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store destination: {:?}", e))
            })?;
        writer
            .store_uint(256, &BigUint::from_bytes_be(message.recipient.as_bytes()))
            .map_err(|e| {
                TonCellError::CellBuilderError(format!("Failed to store recipient: {:?}", e))
            })?;
        writer.store_reference(&ArcCell::new(body)).map_err(|e| {
            TonCellError::CellBuilderError(format!("Failed to store body reference: {:?}", e))
        })?;

        writer
            .build()
            .map_err(|e| TonCellError::CellBuilderError(format!("Failed to build cell: {:?}", e)))
    }
    pub fn parse_stack_item_biguint(
        stack: &[StackItem],
        index: usize,
        item_name: &str,
    ) -> ChainResult<BigUint> {
        let item = stack.get(index).ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Stack does not contain value at index {} ({})",
                index, item_name
            )))
        })?;

        match &item.value {
            StackValue::String(val) => {
                BigUint::parse_bytes(val.trim_start_matches("0x").as_bytes(), 16).ok_or_else(|| {
                    ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                        "Failed to parse BigUint from string '{}' for {}",
                        val, item_name
                    )))
                })
            }
            _ => Err(ChainCommunicationError::from(
                HyperlaneTonError::ParsingError(format!(
                    "Unexpected stack value type for {}: {:?}",
                    item_name, item.value
                )),
            )),
        }
    }

    pub fn parse_stack_item_u32(
        stack: &[StackItem],
        index: usize,
        item_name: &str,
    ) -> ChainResult<u32> {
        let biguint = Self::parse_stack_item_biguint(stack, index, item_name)?;
        biguint.clone().try_into().map_err(|_| {
            ChainCommunicationError::CustomError(format!(
                "Value at index {} ({}) is too large for u32: {:?}",
                index, item_name, biguint
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::{H160, H256, H512, U256};
    use num_bigint::BigUint;
    use num_traits::Zero;
    use tonlib_core::TonAddress;

    use super::ConversionUtils;
    use crate::run_get_method::{StackItem, StackValue};

    #[test]
    fn test_base64_to_h512_valid() {
        let hash_str = "emUQnddCZvrUNaMmy0eYGzRtHAVsdniV0x7EBpK6ON4=";
        let expected = H512::from_slice(&[
            0x7a, 0x65, 0x10, 0x9d, 0xd7, 0x42, 0x66, 0xfa, 0xd4, 0x35, 0xa3, 0x26, 0xcb, 0x47,
            0x98, 0x1b, 0x34, 0x6d, 0x1c, 0x05, 0x6c, 0x76, 0x78, 0x95, 0xd3, 0x1e, 0xc4, 0x06,
            0x92, 0xba, 0x38, 0xde, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]);

        let result = ConversionUtils::base64_to_h512(hash_str).expect("Conversion failed");
        assert_eq!(result, expected);
    }

    #[test]
    fn test_base64_to_h512_invalid() {
        let invalid_hash_str = "invalid_base64_string";

        let result = ConversionUtils::base64_to_h512(invalid_hash_str);
        assert!(result.is_err(), "Expected an error for invalid input");
    }

    #[test]
    fn test_parse_root_cell_from_boc() {
        let boc_base64 = "te6cckEBAgEANwABQ6AAAAAAAAAAAAAAAAABcqZ6QdO0UVZJKOpooNx6WOrpGnABACBzdG9yYWdlIGxvY2F0aW9u3GbBUg==";
        let root_cell = ConversionUtils::parse_root_cell_from_boc(boc_base64)
            .expect("Failed to parse root cell from BOC");

        // Ensure the root cell is parsed correctly
        assert!(root_cell.bit_len() > 0);
    }
    #[test]
    fn test_base64_to_h256_invalid_length() {
        let base64_hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let result = ConversionUtils::base64_to_h256(base64_hash);
        assert!(result.is_err());
    }
    #[test]
    fn test_parse_root_cell_from_boc_valid() {
        let boc_base64 = "te6cckEBAgEATQABQ6AGvFm965B0z/96EKlW2xGIv+qjfKDHQWY2NlXkdJEINtABAEz3CxqLkN5V+jk24kdOlIIhNfGZYWH0y0ato9U/6pMBogAAAAAAAZnmUE8="; // Example BOC with one root cell
        let result = ConversionUtils::parse_root_cell_from_boc(boc_base64);
        assert!(result.is_ok());
    }
    #[test]
    fn test_parse_root_cell_from_boc_invalid_base64() {
        let boc_base64 = "invalid_base64";
        let result = ConversionUtils::parse_root_cell_from_boc(boc_base64);
        assert!(result.is_err());
    }
    #[test]
    fn test_u256_to_biguint_zero() {
        // Create a U256 value of 0
        let u256_value = U256::zero();

        // Convert to BigUint
        let biguint_value = ConversionUtils::u256_to_biguint(u256_value);

        // Verify correctness
        assert_eq!(biguint_value, BigUint::zero());
    }
    #[test]
    fn test_u256_to_biguint_conversion() {
        // Create a U256 value
        let u256_value = U256::from_dec_str("1234567890123456789012345678901234567890").unwrap();

        // Convert to BigUint
        let biguint_value = ConversionUtils::u256_to_biguint(u256_value);

        // Verify correctness
        let expected_value =
            BigUint::parse_bytes(b"1234567890123456789012345678901234567890", 10).unwrap();
        assert_eq!(biguint_value, expected_value);
    }
    #[test]
    fn test_ton_address_to_h256() {
        let address =
            TonAddress::from_base64_url("UQCvsB60DElBwHpHOj26K9NfxGJgzes_5pzwV48QGxHar2F3")
                .unwrap();
        let result = ConversionUtils::ton_address_to_h256(&address);
        let expected = H256::from_slice(&[
            0xaf, 0xb0, 0x1e, 0xb4, 0x0c, 0x49, 0x41, 0xc0, 0x7a, 0x47, 0x3a, 0x3d, 0xba, 0x2b,
            0xd3, 0x5f, 0xc4, 0x62, 0x60, 0xcd, 0xeb, 0x3f, 0xe6, 0x9c, 0xf0, 0x57, 0x8f, 0x10,
            0x1b, 0x11, 0xda, 0xaf,
        ]);

        assert_eq!(result, expected);
    }
    #[test]
    fn test_h256_to_ton_address() {
        let h256 = H256::from_slice(&[0x12; 32]);
        let workchain = 0;

        let address = ConversionUtils::h256_to_ton_address(&h256, workchain);

        assert_eq!(address.workchain, workchain);
        assert_eq!(address.hash_part.as_slice(), h256.as_bytes());
    }
    #[test]
    fn test_parse_eth_address_to_h160_valid() {
        let eth_address = "0x1234567890abcdef1234567890abcdef12345678";

        let h160 = ConversionUtils::parse_eth_address_to_h160(eth_address).unwrap();

        assert_eq!(
            h160,
            H160::from_slice(&hex::decode(&eth_address[2..]).unwrap())
        );
    }
    #[test]
    fn test_parse_eth_address_to_h160_invalid_length() {
        let eth_address = "0x123456";

        let result = ConversionUtils::parse_eth_address_to_h160(eth_address);

        assert!(result.is_err());
        assert_eq!(result.unwrap_err().to_string(), "Conversion data failed");
    }
    #[test]
    fn test_extract_boc_from_stack_item() {
        let stack_item = StackItem {
            r#type: "cell".to_string(),
            value: StackValue::String("te6cckEBAgEATQABQ6AGvFm965B0z/96EKlW2xGIv+qjfKDHQWY2NlXkdJEINtABAEz3CxqLkN5V+jk24kdOlIIhNfGZYWH0y0ato9U/6pMBogAAAAAAAZnmUE8=".to_string()),
        };

        let boc = ConversionUtils::extract_boc_from_stack_item(&stack_item).unwrap();

        assert_eq!(boc, "te6cckEBAgEATQABQ6AGvFm965B0z/96EKlW2xGIv+qjfKDHQWY2NlXkdJEINtABAEz3CxqLkN5V+jk24kdOlIIhNfGZYWH0y0ato9U/6pMBogAAAAAAAZnmUE8=");
    }
    #[test]
    fn test_extract_boc_from_stack_item_invalid_type() {
        let stack_item = StackItem {
            r#type: "list".to_string(),
            value: StackValue::List(vec![]),
        };

        let result = ConversionUtils::extract_boc_from_stack_item(&stack_item);

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err().to_string(),
            "Data parsing error: Failed to get boc: unexpected data type: List([])"
        );
    }
    #[test]
    fn test_parse_stack_item_to_u32_valid() {
        let stack = vec![StackItem {
            r#type: "cell".to_string(),
            value: StackValue::String("0x0000002a".to_string()),
        }];

        let value = ConversionUtils::parse_stack_item_to_u32(&stack, 0).unwrap();

        assert_eq!(value, 42);
    }

    #[test]
    fn test_parse_stack_item_to_u32_invalid_index() {
        let stack = vec![StackItem {
            r#type: "cell".to_string(),
            value: StackValue::String("0x0000002a".to_string()),
        }];

        let result = ConversionUtils::parse_stack_item_to_u32(&stack, 1);

        assert!(result.is_err());
        assert_eq!(result.unwrap_err().to_string(), "No stack item at index 1");
    }
    #[test]
    fn test_parse_stack_item_biguint_valid() {
        let stack = vec![StackItem {
            r#type: "string".to_string(),
            value: StackValue::String("0x123abc".to_string()),
        }];

        let result = ConversionUtils::parse_stack_item_biguint(&stack, 0, "test_item");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), BigUint::from(0x123abc_u32));
    }
    #[test]
    fn test_parse_stack_item_biguint_invalid_index() {
        let stack: Vec<StackItem> = vec![];
        let result = ConversionUtils::parse_stack_item_biguint(&stack, 0, "test_item");

        assert!(result.is_err());
    }
}
