use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// Singleton program data account: just an owner for access control on
/// `SetRemoteConfig`.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct ProgramData {
    pub bump_seed: u8,
    pub owner: Option<Pubkey>,
}

impl SizedData for ProgramData {
    fn size(&self) -> usize {
        borsh::to_vec(self).map(|v| v.len()).unwrap_or(0)
    }
}

impl AccessControl for ProgramData {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

pub type ProgramDataAccount = AccountData<ProgramData>;

/// Per-Hyperlane-destination-domain config for forwarding a message ID via
/// Circle CCTP v2.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Clone)]
pub struct RemoteConfig {
    pub bump_seed: u8,
    /// Circle's domain ID for this Hyperlane destination (distinct numbering
    /// from Hyperlane's own domain IDs).
    pub circle_domain: u32,
    /// The CCTP message `recipient` field (32 bytes) — semantically the
    /// destination chain's ISM/hook address, generically padded to 32 bytes.
    /// Circle only uses this to route its own message bookkeeping; nothing
    /// on the Solana side calls back into it (see module docs).
    pub recipient: [u8; 32],
    /// The CCTP message `destination_caller` field. Left as all-zero for
    /// permissionless delivery, matching Hyperlane's own permissionless
    /// relaying model — a destination composite-ism `CctpV2` node never
    /// calls Circle's program itself, so restricting the caller would only
    /// break relaying, not add security.
    pub destination_caller: [u8; 32],
    /// Circle's v2 finality threshold: <2000 = fast (fee, soft finality),
    /// 2000 = standard (no fee, hard finality). See
    /// developers.circle.com/cctp/cctp-finality-and-fees.
    pub min_finality_threshold: u32,
}

impl SizedData for RemoteConfig {
    fn size(&self) -> usize {
        borsh::to_vec(self).map(|v| v.len()).unwrap_or(0)
    }
}

pub type RemoteConfigAccount = AccountData<RemoteConfig>;

/// Derives the program data PDA.
pub fn derive_program_data_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(crate::cctp_hook_program_data_pda_seeds!(), program_id)
}

/// Derives the per-destination-domain remote config PDA.
pub fn derive_remote_config_pda(program_id: &Pubkey, destination_domain: u32) -> (Pubkey, u8) {
    let domain_bytes = destination_domain.to_le_bytes();
    Pubkey::find_program_address(
        crate::cctp_hook_remote_config_pda_seeds!(&domain_bytes),
        program_id,
    )
}

/// Derives this program's CCTP `sender_authority` PDA — the signer Circle's
/// `send_message` requires, seeded under this program's own ID.
pub fn derive_sender_authority_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(crate::cctp_hook_sender_authority_pda_seeds!(), program_id)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_pda_derivations_are_deterministic_and_distinct() {
        let program_id = Pubkey::new_unique();

        let (program_data, _) = derive_program_data_pda(&program_id);
        let (program_data_again, _) = derive_program_data_pda(&program_id);
        assert_eq!(program_data, program_data_again);

        let (remote_config_1, _) = derive_remote_config_pda(&program_id, 1);
        let (remote_config_2, _) = derive_remote_config_pda(&program_id, 2);
        assert_ne!(
            remote_config_1, remote_config_2,
            "different destination domains must derive different PDAs"
        );

        let (sender_authority, _) = derive_sender_authority_pda(&program_id);
        assert_ne!(sender_authority, program_data);
        assert_ne!(sender_authority, remote_config_1);
    }

    #[test]
    fn test_remote_config_borsh_roundtrip() {
        let config = RemoteConfig {
            bump_seed: 254,
            circle_domain: 0,
            recipient: [0xBB; 32],
            destination_caller: [0u8; 32],
            min_finality_threshold: 2000,
        };
        let encoded = borsh::to_vec(&config).unwrap();
        let decoded: RemoteConfig = BorshDeserialize::try_from_slice(&encoded).unwrap();
        assert_eq!(config, decoded);
    }
}
