use ethers::{
    abi::{decode, ParamType, Token},
    types::{Address, U256 as EthersU256},
    utils::keccak256,
};
use hyperlane_core::{TxnReceiptLog, H256, U256};

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
    pub destination_sweep_executed: Option<bool>,
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
    sweep: Option<SweepCommand>,
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct SweepCommand {
    token: H256,
    recipient: H256,
    router: Option<H256>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RouterEvents {
    has_swap: bool,
    bridge: Option<BridgeCommand>,
    cross_chain: Option<CrossChainCommand>,
}

pub fn decode_origin_hyperswap_with_logs(
    input: &[u8],
    logs: &[TxnReceiptLog],
) -> Option<OriginHyperswap> {
    let (commands, inputs) = decode_execute_input(input)?;
    let plan = summarize_plan(&commands, &inputs)?;
    let events = summarize_router_events(logs);
    let bridge = events.bridge.or(plan.bridge)?;
    let cross_chain = events.cross_chain.or(plan.cross_chain)?;
    let origin_swap = events.has_swap;
    Some(OriginHyperswap {
        commitment: cross_chain.commitment,
        destination_domain: cross_chain.destination_domain,
        origin_token_address: if origin_swap {
            plan.first_swap_token_in.unwrap_or(bridge.token)
        } else {
            bridge.token
        },
        bridge_token_address: bridge.token,
        bridge_amount: bridge.amount,
        origin_swap,
    })
}

pub fn decode_destination_hyperswap_from_process_with_logs(
    input: &[u8],
    logs: &[TxnReceiptLog],
) -> Option<DestinationHyperswap> {
    let metadata = decode_process_metadata(input)?;
    decode_destination_hyperswap_from_metadata_with_logs(&metadata, logs)
}

pub fn decode_destination_hyperswap_from_metadata_with_logs(
    metadata: &[u8],
    logs: &[TxnReceiptLog],
) -> Option<DestinationHyperswap> {
    if metadata.len() < 52 {
        return None;
    }
    let calls = decode_ica_calls(&metadata[52..])?;
    let mut aggregate = PlanSummary::default();
    for call in calls {
        let Some((commands, inputs)) = decode_execute_input(&call.data) else {
            continue;
        };
        let Some(mut plan) = summarize_plan(&commands, &inputs) else {
            continue;
        };
        if let Some(sweep) = &mut plan.sweep {
            sweep.router = Some(call.to);
        }
        aggregate.merge(plan);
    }

    if !aggregate.has_swap && aggregate.sweep.is_none() {
        return None;
    }

    let has_swap_event = summarize_router_events(logs).has_swap;
    let sweep_executed = aggregate
        .sweep
        .as_ref()
        .map(|sweep| has_erc20_sweep_transfer(logs, sweep));
    let sweep_token = aggregate.sweep.as_ref().map(|sweep| sweep.token);

    Some(DestinationHyperswap {
        destination_token_address: if has_swap_event {
            aggregate.last_swap_token_out
        } else {
            sweep_token
        },
        destination_swap: has_swap_event,
        destination_sweep: aggregate.sweep.is_some(),
        destination_sweep_executed: sweep_executed,
        destination_sweep_token: sweep_token,
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
                if let Some(sweep) = decode_sweep(input) {
                    summary.sweep = Some(sweep);
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

fn decode_sweep(input: &[u8]) -> Option<SweepCommand> {
    let tokens = decode(
        &[ParamType::Address, ParamType::Address, ParamType::Uint(256)],
        input,
    )
    .ok()?;
    Some(SweepCommand {
        token: tokens
            .first()?
            .clone()
            .into_address()
            .map(address_to_h256)?,
        recipient: tokens.get(1)?.clone().into_address().map(address_to_h256)?,
        router: None,
    })
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
            sweep: None,
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
        if other.sweep.is_some() {
            self.sweep = other.sweep;
        }
    }
}

fn summarize_router_events(logs: &[TxnReceiptLog]) -> RouterEvents {
    let swap_topic = topic_for("UniversalRouterSwap(address,address)");
    let bridge_topic = topic_for("UniversalRouterBridge(address,bytes32,address,uint256,uint32)");
    let cross_chain_topic = topic_for("CrossChainSwap(address,address,uint32,bytes32)");

    let mut events = RouterEvents {
        has_swap: false,
        bridge: None,
        cross_chain: None,
    };

    for log in logs {
        match log.topics.first() {
            Some(topic) if *topic == swap_topic => {
                events.has_swap = true;
            }
            Some(topic) if *topic == bridge_topic => {
                let Some(token) = log.topics.get(3).copied() else {
                    continue;
                };
                let Ok(values) = decode(&[ParamType::Uint(256), ParamType::Uint(32)], &log.data)
                else {
                    continue;
                };
                let Some(amount) = values.first().cloned().and_then(Token::into_uint) else {
                    continue;
                };
                events.bridge = Some(BridgeCommand {
                    token,
                    amount: ethers_u256_to_core(amount),
                });
            }
            Some(topic) if *topic == cross_chain_topic => {
                let Some(destination_topic) = log.topics.get(3) else {
                    continue;
                };
                let Ok(values) = decode(&[ParamType::FixedBytes(32)], &log.data) else {
                    continue;
                };
                let Some(commitment) = values.first().cloned().and_then(Token::into_fixed_bytes)
                else {
                    continue;
                };
                events.cross_chain = Some(CrossChainCommand {
                    destination_domain: u32::from_be_bytes(
                        destination_topic.as_bytes()[28..32]
                            .try_into()
                            .expect("topic has 32 bytes"),
                    ),
                    commitment: H256::from_slice(&commitment),
                });
            }
            _ => {}
        }
    }

    events
}

fn has_erc20_sweep_transfer(logs: &[TxnReceiptLog], sweep: &SweepCommand) -> bool {
    let transfer_topic = topic_for("Transfer(address,address,uint256)");
    let recipient = mapped_recipient(logs, sweep);
    let Some(recipient) = recipient else {
        return false;
    };

    logs.iter().any(|log| {
        log.address == sweep.token
            && log.topics.first() == Some(&transfer_topic)
            && log.topics.get(2) == Some(&recipient)
    })
}

fn mapped_recipient(logs: &[TxnReceiptLog], sweep: &SweepCommand) -> Option<H256> {
    let msg_sender = low_address_to_h256(1);
    let address_this = low_address_to_h256(2);
    if sweep.recipient == address_this {
        return sweep.router;
    }
    if sweep.recipient != msg_sender {
        return Some(sweep.recipient);
    }

    let router = sweep.router?;
    let swap_topic = topic_for("UniversalRouterSwap(address,address)");
    logs.iter()
        .find(|log| log.address == router && log.topics.first() == Some(&swap_topic))
        .and_then(|log| log.topics.get(1).copied())
}

fn selector_for(signature: &str) -> [u8; 4] {
    keccak256(signature.as_bytes())[..4]
        .try_into()
        .expect("selector length")
}

fn topic_for(signature: &str) -> H256 {
    H256::from_slice(&keccak256(signature.as_bytes()))
}

fn address_to_h256(address: Address) -> H256 {
    address_slice_to_h256(address.as_bytes())
}

fn address_slice_to_h256(address: &[u8]) -> H256 {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    H256::from(out)
}

fn low_address_to_h256(value: u8) -> H256 {
    let mut out = [0u8; 32];
    out[31] = value;
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
