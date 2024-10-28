pub mod hyp_erc20;
pub mod hyp_erc20_collateral;
pub mod hyp_erc721;
pub mod hyp_erc721_collateral;
pub mod hyp_native;
pub mod extensions {
    pub mod fast_hyp_erc20;
    pub mod fast_hyp_erc20_collateral;
    pub mod hyp_erc20_collateral_vault_deposit;
    pub mod hyp_erc20_vault;
    pub mod hyp_erc20_vault_collateral;
    pub mod hyp_erc721_URI_collateral;
    pub mod hyp_erc721_URI_storage;
    pub mod hyp_fiat_token;
    pub mod hyp_native_scaled;
    pub mod hyp_xerc20;
    pub mod hyp_xerc20_lockbox;
}
pub mod interfaces {
    pub mod ierc4626;
    pub mod ifiat_token;
    pub mod imessage_recipient;
    pub mod ixerc20;
    pub mod ixerc20_lockbox;
}
pub mod components {
    pub mod erc721_enumerable;
    pub mod erc721_uri_storage;
    pub mod fast_token_router;
    pub mod hyp_erc20_collateral_component;
    pub mod hyp_erc20_component;
    pub mod hyp_erc721_collateral_component;
    pub mod hyp_erc721_component;
    pub mod hyp_native_component;
    pub mod token_message;
    pub mod token_router;
}
