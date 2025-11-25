use snarkvm_console_account::Itertools;
use url::Url;

/// Aleo connection configuration
#[derive(Debug, Clone)]
pub struct ConnectionConf {
    /// Aleo RPC
    pub rpcs: Vec<Url>,
    /// Plaintext program name of the mailbox
    pub mailbox_program: String,
    /// Hook manager program name
    pub hook_manager_program: String,
    /// Ism Manager program name
    pub ism_manager_program: String,
    /// Validator announce program name
    pub validator_announce_program: String,
    /// Chain Id
    pub chain_id: u16,
}

impl ConnectionConf {
    /// New Aleo Connection Config
    pub fn new(
        rpc_urls: Vec<Url>,
        mailbox_program: String,
        hook_manager_program: String,
        ism_manager_program: String,
        validator_announce_program: String,
        chain_id: u16,
        consensus_heights: Option<Vec<u32>>,
    ) -> Self {
        if let Some(consensus_heights) = consensus_heights {
            // Set the consensus heights in the environment.
            // ZK proof generation is done differently for different chains and relies on these heights. These are hardcoded in the Aleo VM for all known networks, like testnet and mainnet.
            // However, when we want to run the relayer with a local chain, that network is unknown and we need to set the correct heights there as well; this is the only way to set the heights.
            #[allow(unsafe_code)]
            unsafe {
                // SAFETY:
                //  - `CONSENSUS_VERSION_HEIGHTS` is only set once and is only read in `snarkvm::prelude::load_consensus_heights`.
                // WHY:
                //  - This is needed because there is no way to set the desired consensus heights for a particular `VM` instance
                //    without using the environment variable `CONSENSUS_VERSION_HEIGHTS`. Which is itself read once, and stored in a `OnceLock`.
                std::env::set_var(
                    "CONSENSUS_VERSION_HEIGHTS",
                    consensus_heights.iter().format(",").to_string(),
                );
            }
        }

        Self {
            rpcs: rpc_urls,
            mailbox_program,
            hook_manager_program,
            ism_manager_program,
            validator_announce_program,
            chain_id,
        }
    }
}
