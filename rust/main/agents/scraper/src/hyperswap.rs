use ethers::{
    abi::{decode, ParamType, Token},
    types::{Address, U256 as EthersU256},
    utils::keccak256,
};
use hyperlane_core::{H256, U256};

const COMMAND_TYPE_MASK: u8 = 0x3f;
const V3_SWAP_EXACT_IN: u8 = 0x00;
const V3_SWAP_EXACT_OUT: u8 = 0x01;
const SWEEP: u8 = 0x04;
const V2_SWAP_EXACT_IN: u8 = 0x08;
const V2_SWAP_EXACT_OUT: u8 = 0x09;
const V4_SWAP: u8 = 0x10;
const BRIDGE_TOKEN: u8 = 0x12;
const EXECUTE_CROSS_CHAIN: u8 = 0x13;
const EXECUTE_SUB_PLAN: u8 = 0x21;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginHyperswap {
    pub commitment: H256,
    pub destination_domain: u32,
    pub origin_token_address: H256,
    pub bridge_token_address: H256,
    pub bridge_amount: U256,
    pub origin_swap: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DestinationHyperswap {
    pub destination_token_address: Option<H256>,
    pub destination_swap: bool,
    pub destination_sweep: bool,
    pub destination_sweep_token: Option<H256>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IcaMessageBody {
    Commitment(H256),
    Reveal(H256),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PlanSummary {
    first_swap_token_in: Option<H256>,
    last_swap_token_out: Option<H256>,
    has_swap: bool,
    bridge: Option<BridgeCommand>,
    cross_chain: Option<CrossChainCommand>,
    sweep_token: Option<H256>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BridgeCommand {
    token: H256,
    amount: U256,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CrossChainCommand {
    destination_domain: u32,
    commitment: H256,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IcaCall {
    to: H256,
    data: Vec<u8>,
}

pub fn decode_origin_hyperswap(input: &[u8]) -> Option<OriginHyperswap> {
    let (commands, inputs) = decode_execute_input(input)?;
    let plan = summarize_plan(&commands, &inputs)?;
    let bridge = plan.bridge?;
    let cross_chain = plan.cross_chain?;
    Some(OriginHyperswap {
        commitment: cross_chain.commitment,
        destination_domain: cross_chain.destination_domain,
        origin_token_address: plan.first_swap_token_in.unwrap_or(bridge.token),
        bridge_token_address: bridge.token,
        bridge_amount: bridge.amount,
        origin_swap: plan.has_swap,
    })
}

pub fn decode_destination_hyperswap_from_process(input: &[u8]) -> Option<DestinationHyperswap> {
    let metadata = decode_process_metadata(input)?;
    decode_destination_hyperswap_from_metadata(&metadata)
}

pub fn decode_destination_hyperswap_from_metadata(metadata: &[u8]) -> Option<DestinationHyperswap> {
    if metadata.len() < 52 {
        return None;
    }
    let calls = decode_ica_calls(&metadata[52..])?;
    let mut aggregate = PlanSummary::default();
    for call in calls {
        let Some((commands, inputs)) = decode_execute_input(&call.data) else {
            continue;
        };
        let Some(plan) = summarize_plan(&commands, &inputs) else {
            continue;
        };
        aggregate.merge(plan);
    }

    if !aggregate.has_swap && aggregate.sweep_token.is_none() {
        return None;
    }

    Some(DestinationHyperswap {
        destination_token_address: aggregate.last_swap_token_out.or(aggregate.sweep_token),
        destination_swap: aggregate.has_swap,
        destination_sweep: aggregate.sweep_token.is_some(),
        destination_sweep_token: aggregate.sweep_token,
    })
}

pub fn decode_ica_message_body(body: &[u8]) -> Option<IcaMessageBody> {
    match body.first().copied()? {
        1 if body.len() >= 129 => {
            Some(IcaMessageBody::Commitment(H256::from_slice(&body[97..129])))
        }
        2 if body.len() >= 65 => Some(IcaMessageBody::Reveal(H256::from_slice(&body[33..65]))),
        _ => None,
    }
}

fn decode_execute_input(input: &[u8]) -> Option<(Vec<u8>, Vec<Vec<u8>>)> {
    if input.len() < 4 {
        return None;
    }
    let selector = &input[..4];
    let params = &input[4..];
    let execute_with_deadline = selector_for("execute(bytes,bytes[],uint256)");
    let execute = selector_for("execute(bytes,bytes[])");
    let tokens = if selector == execute_with_deadline {
        decode(
            &[
                ParamType::Bytes,
                ParamType::Array(Box::new(ParamType::Bytes)),
                ParamType::Uint(256),
            ],
            params,
        )
        .ok()?
    } else if selector == execute {
        decode(
            &[
                ParamType::Bytes,
                ParamType::Array(Box::new(ParamType::Bytes)),
            ],
            params,
        )
        .ok()?
    } else {
        return None;
    };

    let commands = tokens.first()?.clone().into_bytes()?;
    let inputs = tokens
        .get(1)?
        .clone()
        .into_array()?
        .into_iter()
        .map(Token::into_bytes)
        .collect::<Option<Vec<_>>>()?;
    Some((commands, inputs))
}

fn decode_process_metadata(input: &[u8]) -> Option<Vec<u8>> {
    if input.len() < 4 || input[..4] != selector_for("process(bytes,bytes)") {
        return None;
    }
    decode(&[ParamType::Bytes, ParamType::Bytes], &input[4..])
        .ok()?
        .first()?
        .clone()
        .into_bytes()
}

fn summarize_plan(commands: &[u8], inputs: &[Vec<u8>]) -> Option<PlanSummary> {
    if commands.len() != inputs.len() {
        return None;
    }
    let mut summary = PlanSummary::default();
    for (command, input) in commands.iter().zip(inputs) {
        match command & COMMAND_TYPE_MASK {
            V3_SWAP_EXACT_IN => {
                if let Some((token_in, token_out)) = decode_v3_swap_tokens(input) {
                    summary.record_swap(token_in, token_out);
                }
            }
            V3_SWAP_EXACT_OUT => {
                if let Some((token_out, token_in)) = decode_v3_swap_tokens(input) {
                    summary.record_swap(token_in, token_out);
                }
            }
            V2_SWAP_EXACT_IN | V2_SWAP_EXACT_OUT => {
                if let Some((token_in, token_out)) = decode_v2_swap_tokens(input) {
                    summary.record_swap(token_in, token_out);
                }
            }
            V4_SWAP => {
                summary.has_swap = true;
            }
            SWEEP => {
                if let Some(token) = decode_sweep_token(input) {
                    summary.sweep_token = Some(token);
                }
            }
            BRIDGE_TOKEN => {
                if let Some(bridge) = decode_bridge(input) {
                    summary.bridge = Some(bridge);
                }
            }
            EXECUTE_CROSS_CHAIN => {
                if let Some(cross_chain) = decode_cross_chain(input) {
                    summary.cross_chain = Some(cross_chain);
                }
            }
            EXECUTE_SUB_PLAN => {
                let tokens = decode(
                    &[
                        ParamType::Bytes,
                        ParamType::Array(Box::new(ParamType::Bytes)),
                    ],
                    input,
                )
                .ok()?;
                let subcommands = tokens.first()?.clone().into_bytes()?;
                let subinputs = tokens
                    .get(1)?
                    .clone()
                    .into_array()?
                    .into_iter()
                    .map(Token::into_bytes)
                    .collect::<Option<Vec<_>>>()?;
                if let Some(subsummary) = summarize_plan(&subcommands, &subinputs) {
                    summary.merge(subsummary);
                }
            }
            _ => {}
        }
    }
    Some(summary)
}

fn decode_v3_swap_tokens(input: &[u8]) -> Option<(H256, H256)> {
    let tokens = decode(
        &[
            ParamType::Address,
            ParamType::Uint(256),
            ParamType::Uint(256),
            ParamType::Bytes,
            ParamType::Bool,
            ParamType::Bool,
        ],
        input,
    )
    .ok()?;
    let path = tokens.get(3)?.clone().into_bytes()?;
    if path.len() < 40 {
        return None;
    }
    Some((
        address_slice_to_h256(&path[..20]),
        address_slice_to_h256(&path[path.len() - 20..]),
    ))
}

fn decode_v2_swap_tokens(input: &[u8]) -> Option<(H256, H256)> {
    let tokens = decode(
        &[
            ParamType::Address,
            ParamType::Uint(256),
            ParamType::Uint(256),
            ParamType::Bytes,
            ParamType::Bool,
            ParamType::Bool,
        ],
        input,
    )
    .ok()?;
    let path = tokens.get(3)?.clone().into_bytes()?;
    if path.len() < 40 {
        return None;
    }
    Some((
        address_slice_to_h256(&path[..20]),
        address_slice_to_h256(&path[path.len() - 20..]),
    ))
}

fn decode_sweep_token(input: &[u8]) -> Option<H256> {
    decode(
        &[ParamType::Address, ParamType::Address, ParamType::Uint(256)],
        input,
    )
    .ok()?
    .first()?
    .clone()
    .into_address()
    .map(address_to_h256)
}

fn decode_bridge(input: &[u8]) -> Option<BridgeCommand> {
    let tokens = decode(
        &[
            ParamType::Uint(8),
            ParamType::FixedBytes(32),
            ParamType::Address,
            ParamType::Address,
            ParamType::Uint(256),
            ParamType::Uint(256),
            ParamType::Uint(256),
            ParamType::Uint(32),
            ParamType::Bool,
        ],
        input,
    )
    .ok()?;
    Some(BridgeCommand {
        token: tokens.get(2)?.clone().into_address().map(address_to_h256)?,
        amount: ethers_u256_to_core(tokens.get(4)?.clone().into_uint()?),
    })
}

fn decode_cross_chain(input: &[u8]) -> Option<CrossChainCommand> {
    let tokens = decode(
        &[
            ParamType::Uint(32),
            ParamType::Address,
            ParamType::FixedBytes(32),
            ParamType::FixedBytes(32),
            ParamType::FixedBytes(32),
            ParamType::FixedBytes(32),
            ParamType::Uint(256),
            ParamType::Address,
            ParamType::Uint(256),
            ParamType::Address,
            ParamType::Bytes,
        ],
        input,
    )
    .ok()?;
    Some(CrossChainCommand {
        destination_domain: tokens.get(0)?.clone().into_uint()?.as_u32(),
        commitment: H256::from_slice(&tokens.get(4)?.clone().into_fixed_bytes()?),
    })
}

fn decode_ica_calls(input: &[u8]) -> Option<Vec<IcaCall>> {
    let calls = decode(
        &[ParamType::Array(Box::new(ParamType::Tuple(vec![
            ParamType::FixedBytes(32),
            ParamType::Uint(256),
            ParamType::Bytes,
        ])))],
        input,
    )
    .ok()?
    .first()?
    .clone()
    .into_array()?;

    calls
        .into_iter()
        .map(|call| {
            let values = call.into_tuple()?;
            Some(IcaCall {
                to: H256::from_slice(&values.first()?.clone().into_fixed_bytes()?),
                data: values.get(2)?.clone().into_bytes()?,
            })
        })
        .collect()
}

impl Default for PlanSummary {
    fn default() -> Self {
        Self {
            first_swap_token_in: None,
            last_swap_token_out: None,
            has_swap: false,
            bridge: None,
            cross_chain: None,
            sweep_token: None,
        }
    }
}

impl PlanSummary {
    fn record_swap(&mut self, token_in: H256, token_out: H256) {
        self.first_swap_token_in.get_or_insert(token_in);
        self.last_swap_token_out = Some(token_out);
        self.has_swap = true;
    }

    fn merge(&mut self, other: PlanSummary) {
        if self.first_swap_token_in.is_none() {
            self.first_swap_token_in = other.first_swap_token_in;
        }
        if other.last_swap_token_out.is_some() {
            self.last_swap_token_out = other.last_swap_token_out;
        }
        self.has_swap |= other.has_swap;
        if other.bridge.is_some() {
            self.bridge = other.bridge;
        }
        if other.cross_chain.is_some() {
            self.cross_chain = other.cross_chain;
        }
        if other.sweep_token.is_some() {
            self.sweep_token = other.sweep_token;
        }
    }
}

fn selector_for(signature: &str) -> [u8; 4] {
    keccak256(signature.as_bytes())[..4]
        .try_into()
        .expect("selector length")
}

fn address_to_h256(address: Address) -> H256 {
    address_slice_to_h256(address.as_bytes())
}

fn address_slice_to_h256(address: &[u8]) -> H256 {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    H256::from(out)
}

fn ethers_u256_to_core(value: EthersU256) -> U256 {
    let mut bytes = [0u8; 32];
    value.to_big_endian(&mut bytes);
    U256::from_big_endian(&bytes)
}

#[cfg(test)]
mod tests {
    use ethers::abi::encode;

    use super::*;

    fn address(byte: u8) -> Address {
        Address::repeat_byte(byte)
    }

    fn h256_address(byte: u8) -> H256 {
        address_to_h256(address(byte))
    }

    fn encode_v3_swap_input(path: Vec<u8>) -> Vec<u8> {
        encode(&[
            Token::Address(address(0xaa)),
            Token::Uint(EthersU256::from(1u64)),
            Token::Uint(EthersU256::from(1u64)),
            Token::Bytes(path),
            Token::Bool(true),
            Token::Bool(false),
        ])
    }

    fn v3_path(first: Address, second: Address) -> Vec<u8> {
        let mut path = Vec::with_capacity(43);
        path.extend_from_slice(first.as_bytes());
        path.extend_from_slice(&[0, 0, 1]);
        path.extend_from_slice(second.as_bytes());
        path
    }

    #[test]
    fn v3_exact_in_uses_path_first_as_input() {
        let input = encode_v3_swap_input(v3_path(address(1), address(2)));
        let summary = summarize_plan(&[V3_SWAP_EXACT_IN], &[input]).unwrap();

        assert_eq!(summary.first_swap_token_in, Some(h256_address(1)));
        assert_eq!(summary.last_swap_token_out, Some(h256_address(2)));
    }

    #[test]
    fn v3_exact_out_uses_path_last_as_input() {
        let input = encode_v3_swap_input(v3_path(address(1), address(2)));
        let summary = summarize_plan(&[V3_SWAP_EXACT_OUT], &[input]).unwrap();

        assert_eq!(summary.first_swap_token_in, Some(h256_address(2)));
        assert_eq!(summary.last_swap_token_out, Some(h256_address(1)));
    }
}
