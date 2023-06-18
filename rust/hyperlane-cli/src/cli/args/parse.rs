use ethers::prelude::{Address, H256};
use ethers::utils::hex;
use std::error::Error;
use std::str::FromStr;

pub trait ParseEthPrimitives {
    fn parse_address(&self, arg_name: String) -> Result<H256, Box<dyn Error>>;
    fn parse_private_key(&self, arg_name: String) -> Result<Vec<u8>, Box<dyn Error>>;
}

impl ParseEthPrimitives for String {
    fn parse_address(&self, arg_name: String) -> Result<H256, Box<dyn Error>> {
        return match Address::from_str(&self) {
            Ok(address) => Ok(H256::from(address)),
            Err(_) => return Err(format!("Could not resolve {} got={}", arg_name, &self).into()),
        };
    }

    fn parse_private_key(&self, arg_name: String) -> Result<Vec<u8>, Box<dyn Error>> {
        match hex::decode(self) {
            Ok(private_key) => Ok(private_key),
            Err(_) => {
                return Err(format!("Could not resolve {} address got={}", arg_name, &self).into())
            }
        }
    }
}
