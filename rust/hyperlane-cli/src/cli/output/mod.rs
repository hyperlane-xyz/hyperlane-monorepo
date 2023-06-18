use ethers::prelude::H256;
use ethers::types::H160;
use ethers::utils::hex;

pub trait OutputWriter {
    fn print(&self);

    fn format_address(&self, address: H256) -> String {
        return format!("0x{}", hex::encode(H160::from_slice(&address[12..])));
    }
}

pub mod json;
pub mod table;
