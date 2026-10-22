//! Oracle: renders the golden cases against the on-chain program crates and checks
//! them against `../testdata/golden/*.json`. Run with `GOLDEN_UPDATE=1` to regenerate.

mod prelude {
    pub use account_utils::DiscriminatorData;
    #[allow(unused_imports)]
    pub use hyperlane_core::{H160, H256, U256};
    pub use hyperlane_sealevel_interface_goldens::*;
    pub use solana_program::pubkey::Pubkey;

    pub use account_utils;
    pub use hyperlane_sealevel_composite_ism as composite_ism;
    pub use hyperlane_sealevel_connection_client as connection_client;
    pub use hyperlane_sealevel_fee as fee;
    pub use hyperlane_sealevel_hello_world as helloworld;
    pub use hyperlane_sealevel_igp as igp;
    pub use hyperlane_sealevel_interchain_security_module_interface as ism_interface;
    pub use hyperlane_sealevel_mailbox as mailbox;
    pub use hyperlane_sealevel_message_recipient_interface as message_recipient_interface;
    pub use hyperlane_sealevel_multisig_ism_message_id as multisig_ism_message_id;
    pub use hyperlane_sealevel_token as token_synthetic;
    pub use hyperlane_sealevel_token_collateral as token_collateral;
    pub use hyperlane_sealevel_token_cross_collateral as token_cross_collateral;
    pub use hyperlane_sealevel_token_lib as token;
    pub use hyperlane_sealevel_token_native as token_native;
    pub use hyperlane_sealevel_validator_announce as validator_announce;
    pub use multisig_ism;
    pub use quote_verifier;
    pub use serializable_account_meta;
}

macro_rules! golden_tests {
    ($($name:ident),* $(,)?) => {$(
        mod $name {
            #[allow(unused_imports)]
            use crate::prelude::*;
            include!(concat!("../cases/", stringify!($name), ".rs"));
        }

        #[test]
        fn $name() {
            $name::cases().check(true);
        }
    )*};
}

golden_tests!(
    mailbox,
    igp,
    validator_announce,
    multisig_ism_message_id,
    composite_ism,
    token,
    helloworld,
    interfaces,
    fee,
    token_cross_collateral
);
