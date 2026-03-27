use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H160;
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// A validator set and threshold for a specific origin domain.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Clone)]
pub struct DomainConfig {
    pub origin: u32,
    /// ECDSA secp256k1 validator addresses.
    pub validators: Vec<H160>,
    pub threshold: u8,
}

/// A node in the ISM config tree. Stored inline in the VAM PDA.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone)]
pub enum IsmNode {
    /// Verifies the message was submitted by the trusted relayer (signer check).
    /// ModuleType: Null.
    TrustedRelayer { relayer: Pubkey },

    /// ECDSA threshold multisig over CheckpointWithMessageId.
    /// ModuleType: MessageIdMultisig.
    MultisigMessageId { domain_configs: Vec<DomainConfig> },

    /// m-of-n aggregation: all sub-ISMs with provided metadata must verify,
    /// and at least `threshold` must have metadata provided.
    /// ModuleType: Aggregation.
    Aggregation {
        threshold: u8,
        sub_isms: Vec<IsmNode>,
    },

    /// Routes to a sub-ISM based on the message's origin domain.
    /// ModuleType: Routing.
    Routing {
        routes: Vec<(u32, IsmNode)>,
        default_ism: Option<Box<IsmNode>>,
    },

    /// Always accepts (accept=true) or always rejects (accept=false).
    /// Intended for testing. ModuleType: Unused.
    Test { accept: bool },

    /// Rejects all messages when paused. Emergency circuit breaker.
    /// ModuleType: Null.
    Pausable { paused: bool },
}

/// Data stored in the VAM PDA account (VERIFY_ACCOUNT_METAS_PDA_SEEDS).
/// Contains the complete ISM config tree.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct CompositeIsmStorage {
    pub bump_seed: u8,
    pub owner: Option<Pubkey>,
    pub root: Option<IsmNode>,
}

impl SizedData for CompositeIsmStorage {
    fn size(&self) -> usize {
        // Use borsh serialized length as the canonical size.
        borsh::to_vec(self).map(|v| v.len()).unwrap_or(0)
    }
}

impl AccessControl for CompositeIsmStorage {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

pub type CompositeIsmAccount = AccountData<CompositeIsmStorage>;

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_ism_node_borsh_roundtrip() {
        let node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::TrustedRelayer {
                    relayer: Pubkey::new_unique(),
                },
                IsmNode::MultisigMessageId {
                    domain_configs: vec![DomainConfig {
                        origin: 1,
                        validators: vec![H160::zero()],
                        threshold: 1,
                    }],
                },
            ],
        };
        let encoded = borsh::to_vec(&node).unwrap();
        let decoded: IsmNode = BorshDeserialize::try_from_slice(&encoded).unwrap();
        assert_eq!(node, decoded);
    }

    #[test]
    fn test_routing_node_borsh_roundtrip() {
        let inner = IsmNode::Pausable { paused: false };
        let node = IsmNode::Routing {
            routes: vec![(1234u32, IsmNode::Test { accept: true })],
            default_ism: Some(Box::new(inner)),
        };
        let encoded = borsh::to_vec(&node).unwrap();
        let decoded: IsmNode = BorshDeserialize::try_from_slice(&encoded).unwrap();
        assert_eq!(node, decoded);
    }
}
