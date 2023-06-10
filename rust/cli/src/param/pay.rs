use crate::arg::*;
use color_eyre::{Report, Result};
use hyperlane_core::{H256, U256};

#[derive(Debug, PartialEq)]
pub struct PayParams {
    pub dest_id: u32,
    pub msg_id: H256,
    pub gas: U256,
}

impl TryFrom<PayArgs> for PayParams {
    type Error = Report;

    fn try_from(args: PayArgs) -> Result<Self> {
        Ok(Self {
            dest_id: args.dest,
            msg_id: args.message_id,
            gas: args.gas.into(),
        })
    }
}
