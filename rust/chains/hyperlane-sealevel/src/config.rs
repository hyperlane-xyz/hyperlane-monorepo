#![allow(warnings)]

use derive_new::new;
use hyperlane_core::H256;

#[derive(Debug, Default, Clone, new, PartialEq)]
pub struct SealevelConf {
    pub relayer_account: Option<H256>,
}
