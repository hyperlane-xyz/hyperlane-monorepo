use ethers::prelude::H256;

pub fn parse_h256<T: AsRef<[u8]>>(data: T) -> eyre::Result<H256> {
    if data.as_ref().len() == 40 {
        Ok(H256(hex::parse_h256_raw::<40>(
            data.as_ref().try_into().unwrap(),
        )?))
    } else {
        Ok(H256(hex::parse_h256_raw::<64>(data.as_ref().try_into()?)?))
    }
}

pub fn format_h256(data: &H256) -> String {
    if hex::is_h160(data.as_fixed_bytes()) {
        hex::format_h160_raw(data.as_fixed_bytes()[12..32].try_into().unwrap())
    } else {
        hex::format_h256_raw(data.as_fixed_bytes())
    }
}
