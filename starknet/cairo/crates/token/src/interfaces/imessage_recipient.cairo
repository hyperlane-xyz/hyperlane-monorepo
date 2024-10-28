use alexandria_bytes::Bytes;
use starknet::ContractAddress;

#[starknet::interface]
pub trait IMessageRecipient<TState> {
    fn handle(ref self: TState, origin: u32, sender: u256, message: Bytes);
}
