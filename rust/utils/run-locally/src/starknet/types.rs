#[derive(Clone)]
pub struct StarknetEndpoint {
    pub rpc_addr: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct DeclaredClasses {
    pub hpl_hook_merkle: String,
    pub hpl_hook_routing: String,
    pub hpl_igp: String,
    pub hpl_igp_oracle: String,
    pub hpl_ism_aggregate: String,
    pub hpl_ism_multisig: String,
    pub hpl_ism_pausable: String,
    pub hpl_ism_routing: String,
    pub hpl_test_mock_ism: String,
    pub hpl_test_mock_hook: String,
    pub hpl_test_mock_msg_receiver: String,
    pub hpl_mailbox: String,
    pub hpl_validator_announce: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Deployments {
    pub hook_merkle: String,
    pub hook_routing: String,
    pub igp: String,
    pub igp_oracle: String,
    pub ism_aggregate: String,
    pub ism_routing: String,
    pub ism_multisig: String,
    pub mailbox: String,
    pub mock_receiver: String,
    pub mock_hook: String,
    pub mock_ism: String,
    pub va: String,
}
