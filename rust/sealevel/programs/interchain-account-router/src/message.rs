//! The Solidity InterchainAccountMessage CALLS wire format.

use borsh::{BorshDeserialize, BorshSerialize};
use ethabi::{ParamType, Token};
use hyperlane_core::{H256, U256};
use serializable_account_meta::SerializableAccountMeta;
use solana_program::program_error::ProgramError;

/// Equivalent to Solidity `CallLib.Call`.
#[derive(BorshDeserialize, BorshSerialize, Debug, Clone, PartialEq, Eq)]
pub struct Call {
    /// Destination contract or program ID, without truncating non-EVM addresses.
    pub to: H256,
    /// EVM native value. Sealevel execution currently requires zero.
    pub value: U256,
    /// EVM calldata, or Borsh-encoded [`SealevelCallData`] for Sealevel targets.
    pub data: Vec<u8>,
}

/// Sealevel-specific contents of `Call.data`.
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct SealevelCallData {
    /// Ordered CPI account metas. Only this message's ICA may be a signer.
    pub accounts: Vec<SerializableAccountMeta>,
    /// Native instruction bytes passed unchanged to the target program.
    pub data: Vec<u8>,
}

/// `0x00 || owner || ism || salt || abi.encode(Call[])`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterchainAccountMessage {
    /// Account that initiated the call on the origin chain.
    pub owner: H256,
    /// Destination ISM. Incoming Sealevel messages currently require zero.
    pub ism: H256,
    /// User-selected salt separating accounts with otherwise equal identities.
    pub salt: H256,
    /// Calls executed sequentially and atomically.
    pub calls: Vec<Call>,
}

impl InterchainAccountMessage {
    /// Encodes a CALLS message understood by the standard EVM ICA router.
    pub fn encode(&self) -> Vec<u8> {
        let mut body = vec![0];
        body.extend_from_slice(self.owner.as_bytes());
        body.extend_from_slice(self.ism.as_bytes());
        body.extend_from_slice(self.salt.as_bytes());
        let calls = self
            .calls
            .iter()
            .map(|call| {
                let mut value = [0; 32];
                call.value.to_big_endian(&mut value);
                Token::Tuple(vec![
                    Token::FixedBytes(call.to.as_bytes().to_vec()),
                    Token::Uint(ethabi::Uint::from_big_endian(&value)),
                    Token::Bytes(call.data.clone()),
                ])
            })
            .collect();
        body.extend_from_slice(&ethabi::encode(&[Token::Array(calls)]));
        body
    }

    /// Decodes EVM CALLS messages. Commitment/reveal messages are not supported.
    pub fn decode(body: &[u8]) -> Result<Self, ProgramError> {
        if body.len() < 97 || body[0] != 0 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let call_type = ParamType::Tuple(vec![
            ParamType::FixedBytes(32),
            ParamType::Uint(256),
            ParamType::Bytes,
        ]);
        let mut tokens = ethabi::decode(&[ParamType::Array(Box::new(call_type))], &body[97..])
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let calls = tokens
            .pop()
            .and_then(Token::into_array)
            .ok_or(ProgramError::InvalidInstructionData)?
            .into_iter()
            .map(|token| {
                let mut fields = token
                    .into_tuple()
                    .ok_or(ProgramError::InvalidInstructionData)?;
                let data = fields
                    .pop()
                    .and_then(Token::into_bytes)
                    .ok_or(ProgramError::InvalidInstructionData)?;
                let value = fields
                    .pop()
                    .and_then(Token::into_uint)
                    .ok_or(ProgramError::InvalidInstructionData)?;
                let to = fields
                    .pop()
                    .and_then(Token::into_fixed_bytes)
                    .ok_or(ProgramError::InvalidInstructionData)?;
                let to: [u8; 32] = to
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?;
                let mut value_bytes = [0; 32];
                value.to_big_endian(&mut value_bytes);
                Ok(Call {
                    to: to.into(),
                    value: U256::from_big_endian(&value_bytes),
                    data,
                })
            })
            .collect::<Result<Vec<_>, ProgramError>>()?;
        Ok(Self {
            owner: H256::from_slice(&body[1..33]),
            ism: H256::from_slice(&body[33..65]),
            salt: H256::from_slice(&body[65..97]),
            calls,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solidity_wire_format() {
        // Generated independently with ethers' defaultAbiCoder:
        // 0x00 || 0x11*32 || 0x22*32 || 0x33*32 ||
        // abi.encode([(0x44*32, uint256.max, hex"123456"), (0x55*32, 0, hex"")]).
        let fixture = include_str!("../tests/fixtures/evm-calls.hex").trim();
        let bytes = hex::decode(fixture.strip_prefix("0x").unwrap()).unwrap();
        let expected = InterchainAccountMessage {
            owner: [0x11; 32].into(),
            ism: [0x22; 32].into(),
            salt: [0x33; 32].into(),
            calls: vec![
                Call {
                    to: [0x44; 32].into(),
                    value: U256::MAX,
                    data: vec![0x12, 0x34, 0x56],
                },
                Call {
                    to: [0x55; 32].into(),
                    value: U256::zero(),
                    data: vec![],
                },
            ],
        };
        assert_eq!(InterchainAccountMessage::decode(&bytes).unwrap(), expected);
        assert_eq!(expected.encode(), bytes);
    }

    #[test]
    fn rejects_malformed_and_unsupported_messages() {
        let valid = InterchainAccountMessage {
            owner: H256::zero(),
            ism: H256::zero(),
            salt: H256::zero(),
            calls: vec![],
        }
        .encode();
        assert_eq!(
            InterchainAccountMessage::decode(&valid).unwrap().calls,
            vec![]
        );
        for len in [0, 1, 96, 97, 128, 160] {
            assert!(InterchainAccountMessage::decode(&valid[..len]).is_err());
        }
        for kind in [1, 2, 255] {
            let mut unsupported = valid.clone();
            unsupported[0] = kind;
            assert!(InterchainAccountMessage::decode(&unsupported).is_err());
        }
        let mut bad_offset = valid;
        bad_offset[97..129].fill(255);
        assert!(InterchainAccountMessage::decode(&bad_offset).is_err());
    }
}
