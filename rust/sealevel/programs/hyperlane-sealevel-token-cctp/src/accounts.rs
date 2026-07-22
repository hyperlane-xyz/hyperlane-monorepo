use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// Seeds for the per-destination-domain CCTP config PDA.
#[macro_export]
macro_rules! cctp_remote_config_pda_seeds {
    ($destination_domain_le:expr) => {{
        &[
            b"hyperlane_token_cctp",
            b"-",
            b"remote_config",
            b"-",
            $destination_domain_le,
        ]
    }};

    ($destination_domain_le:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_token_cctp",
            b"-",
            b"remote_config",
            b"-",
            $destination_domain_le,
            &[$bump_seed],
        ]
    }};
}

/// Seeds for the ATA-payer PDA. Funds idempotent ATA creation on both
/// sides (the recipient's ATA during `Verify()`'s mint CPI, and its own
/// escrow ATA during `TransferRemote`'s burn CPI) and signs, via
/// `invoke_signed`, every role Circle's CPIs require a real signer for —
/// including acting as `owner` of the escrowed burn, so Circle records this
/// PDA (not the end user) as the burn's `messageSender`. Same purpose and
/// naming convention as `hyperlane-sealevel-token-collateral`'s ATA payer.
#[macro_export]
macro_rules! hyperlane_token_cctp_ata_payer_pda_seeds {
    () => {{
        &[b"hyperlane_token_cctp", b"-", b"ata_payer"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token_cctp", b"-", b"ata_payer", &[$bump_seed]]
    }};
}

/// Seeds for the per-message staged-metadata PDA. Holds the raw Circle CCTP
/// `message`/`attestation` bytes so `Verify()` can read them from account
/// data instead of instruction data — the transaction embedding both the
/// full Hyperlane message *and* this payload inline exceeds Solana's
/// tx-size limit. Seeded by the **Hyperlane** message id (not Circle's own
/// CCTP nonce) so both the staging call and `Verify()`/`VerifyAccountMetas`
/// can derive it from data they always have on hand — the Hyperlane message
/// itself — without needing to have already parsed Circle's message first.
#[macro_export]
macro_rules! cctp_stage_metadata_pda_seeds {
    ($message_id:expr) => {{
        &[
            b"hyperlane_token_cctp",
            b"-",
            b"stage_metadata",
            b"-",
            $message_id,
        ]
    }};

    ($message_id:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_token_cctp",
            b"-",
            b"stage_metadata",
            b"-",
            $message_id,
            &[$bump_seed],
        ]
    }};
}

pub fn derive_stage_metadata_pda(program_id: &Pubkey, message_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        crate::cctp_stage_metadata_pda_seeds!(message_id),
        program_id,
    )
}

/// Plugin data for the Hyperlane token program's generic `HyperlaneToken<T>`
/// wrapper. Deliberately minimal: no escrow/pooled balance (unlike
/// `CollateralPlugin`) — CCTP burns/mints native USDC directly via Circle's
/// real programs, so there's nothing for this program to custody.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct CctpPlugin {
    /// The SPL token program for the USDC mint (token or token-2022).
    pub spl_token_program: Pubkey,
    /// The USDC mint.
    pub mint: Pubkey,
    /// Bump seed for the ATA-payer PDA.
    pub ata_payer_bump: u8,
}

impl SizedData for CctpPlugin {
    fn size(&self) -> usize {
        32 + 32 + std::mem::size_of::<u8>()
    }
}

/// Per-Hyperlane-destination-domain CCTP send config.
#[derive(BorshDeserialize, BorshSerialize, Debug, Default, PartialEq, Clone)]
pub struct RemoteConfig {
    pub bump_seed: u8,
    /// Circle's domain ID for this Hyperlane destination (distinct numbering
    /// from Hyperlane's own domain IDs — e.g. Ethereum is Hyperlane domain 1
    /// but Circle domain 0).
    pub circle_domain: u32,
    /// Upper bound on Circle's fee for a fast transfer, in the same units as
    /// the token (see `TokenBridgeCctpV2._externalFeeAmount` on EVM for the
    /// equivalent reversed-fee accounting this program does NOT yet
    /// replicate — see open items).
    pub max_fee: u64,
    /// <2000 = fast (fee, soft finality), 2000 = standard (no fee, hard
    /// finality). See developers.circle.com/cctp/cctp-finality-and-fees.
    pub min_finality_threshold: u32,
}

impl SizedData for RemoteConfig {
    fn size(&self) -> usize {
        borsh::to_vec(self).map(|v| v.len()).unwrap_or(0)
    }
}

pub type RemoteConfigAccount = AccountData<RemoteConfig>;

pub fn derive_remote_config_pda(program_id: &Pubkey, destination_domain: u32) -> (Pubkey, u8) {
    let domain_bytes = destination_domain.to_le_bytes();
    Pubkey::find_program_address(
        crate::cctp_remote_config_pda_seeds!(&domain_bytes),
        program_id,
    )
}

pub fn derive_ata_payer_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        crate::hyperlane_token_cctp_ata_payer_pda_seeds!(),
        program_id,
    )
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_remote_config_borsh_roundtrip() {
        let config = RemoteConfig {
            bump_seed: 254,
            circle_domain: 0,
            max_fee: 100,
            min_finality_threshold: 2000,
        };
        let encoded = borsh::to_vec(&config).unwrap();
        let decoded: RemoteConfig = BorshDeserialize::try_from_slice(&encoded).unwrap();
        assert_eq!(config, decoded);
    }

    #[test]
    fn test_remote_config_pda_distinct_per_domain() {
        let program_id = Pubkey::new_unique();
        let (pda_0, _) = derive_remote_config_pda(&program_id, 0);
        let (pda_5, _) = derive_remote_config_pda(&program_id, 5);
        assert_ne!(pda_0, pda_5);
    }

    #[test]
    fn test_stage_metadata_pda_distinct_per_message_id_and_deterministic() {
        let program_id = Pubkey::new_unique();
        let (pda_a, _) = derive_stage_metadata_pda(&program_id, &[0x01; 32]);
        let (pda_b, _) = derive_stage_metadata_pda(&program_id, &[0x02; 32]);
        assert_ne!(pda_a, pda_b);

        let (pda_a_again, _) = derive_stage_metadata_pda(&program_id, &[0x01; 32]);
        assert_eq!(pda_a, pda_a_again);
    }
}
