use ethers::types::H160;

pub const NATIVE_FEE_TOKEN_ADDRESS: H160 = H160::repeat_byte(0xEE);

const RELAY_URL: &str = "https://relay.gelato.digital";

pub mod oracle_estimate;
pub mod sponsored_call;
pub mod task_status;
pub mod types;
