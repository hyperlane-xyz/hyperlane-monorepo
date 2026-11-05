//! Checks that this crate reproduces the golden vectors generated from the on-chain
//! program crates (`testdata/golden/*.json`) byte for byte. The case definitions are
//! shared with the program-side oracle in `goldens/tests/programs.rs`.

mod prelude {
    pub use account_utils::DiscriminatorData;
    #[allow(unused_imports)]
    pub use hyperlane_core::{H160, H256, U256};
    pub use hyperlane_sealevel_interface_goldens::*;
    pub use solana_program::pubkey::Pubkey;

    pub use hyperlane_sealevel_interface::{
        composite_ism, connection_client, helloworld, igp, mailbox, multisig_ism_message_id, token,
        token_collateral, token_native, token_synthetic, validator_announce,
    };

    pub use account_utils;
    pub use hyperlane_sealevel_interchain_security_module_interface as ism_interface;
    pub use hyperlane_sealevel_message_recipient_interface as message_recipient_interface;
    pub use multisig_ism;
    pub use quote_verifier;
    pub use serializable_account_meta;
}

macro_rules! golden_tests {
    ($($name:ident),* $(,)?) => {$(
        mod $name {
            #[allow(unused_imports)]
            use crate::prelude::*;
            include!(concat!("../goldens/cases/", stringify!($name), ".rs"));
        }

        #[test]
        fn $name() {
            $name::cases().check(false);
        }
    )*};
}

// `fee` and `token_cross_collateral` goldens are program-side only: this crate doesn't
// mirror those programs.
golden_tests!(
    mailbox,
    igp,
    validator_announce,
    multisig_ism_message_id,
    composite_ism,
    token,
    helloworld,
    interfaces,
);
