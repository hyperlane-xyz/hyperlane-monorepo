use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// Seed prefix for a verified-message PDA.
pub const VERIFIED_SEED: &[u8] = b"verified";

/// Marks that Circle's real `MessageTransmitterV2` validated a CCTP v2
/// attestation for a message whose body was exactly the 32-byte Hyperlane
/// message ID embedded in this PDA's own derivation (see
/// [`derive_verified_message_pda`]).
///
/// Deliberately minimal: `sender` and the embedded Hyperlane message ID are
/// not stored here because they're already encoded in the PDA's address
/// (see the seed layout below) — anyone deriving the same address already
/// knows both values. Only `source_domain` needs to be stored, since it
/// isn't part of the seed and a consumer (e.g. a composite-ism `CctpV2`
/// node) still needs to cross-check it against its own configured origin.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Clone)]
pub struct VerifiedMessage {
    pub bump_seed: u8,
    /// Circle's domain ID for the message's origin chain (`remote_domain`
    /// as reported by Circle's callback — not Hyperlane's own domain
    /// numbering).
    pub source_domain: u32,
}

impl SizedData for VerifiedMessage {
    fn size(&self) -> usize {
        borsh::to_vec(self).map(|v| v.len()).unwrap_or(0)
    }
}

pub type VerifiedMessageAccount = AccountData<VerifiedMessage>;

/// Derives the verified-message PDA for a given CCTP `sender` and embedded
/// Hyperlane message ID.
///
/// Keying by `(sender, message_id)` rather than `message_id` alone is
/// deliberate: `sender` is the CCTP message's `sender` field, which Circle's
/// program sets to whichever program actually called `send_message`/
/// `depositForBurn` on the origin chain — it cannot be forged, since only
/// the real owning program can sign for its own `sender_authority` PDA at
/// send time. If the PDA were keyed by `message_id` alone, an attacker could
/// front-run a legitimate message by permissionlessly submitting their own
/// CCTP message (from their own arbitrary program, with an arbitrary nonce)
/// whose body happens to equal a real, publicly-observable victim Hyperlane
/// message ID, occupying the deterministic address first with the wrong
/// `sender` recorded — permanently squatting that message's verified-PDA
/// slot (a denial-of-service, since PDAs can't be re-initialized once
/// created; not a authentication bypass, since a consumer would still see
/// the wrong `sender`, but still a real griefing vector worth designing
/// around). Binding `sender` into the address itself means an attacker's
/// forged message (their own sender, victim's message_id) derives to a
/// *different* address than the legitimate message (real hook's sender,
/// same message_id) — no collision is possible.
pub fn derive_verified_message_pda(
    program_id: &Pubkey,
    sender: &[u8; 32],
    message_id: &[u8; 32],
) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VERIFIED_SEED, sender, message_id], program_id)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_verified_message_borsh_roundtrip() {
        let msg = VerifiedMessage {
            bump_seed: 254,
            source_domain: 0,
        };
        let encoded = borsh::to_vec(&msg).unwrap();
        let decoded: VerifiedMessage = BorshDeserialize::try_from_slice(&encoded).unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn test_derive_verified_message_pda_distinct_per_sender() {
        let program_id = Pubkey::new_unique();
        let message_id = [0xCC; 32];
        let sender_a = [0xAA; 32];
        let sender_b = [0xBB; 32];

        let (pda_a, _) = derive_verified_message_pda(&program_id, &sender_a, &message_id);
        let (pda_b, _) = derive_verified_message_pda(&program_id, &sender_b, &message_id);
        assert_ne!(
            pda_a, pda_b,
            "different senders with the same message_id must derive different PDAs \
             (this is exactly what prevents front-running/squatting)"
        );
    }

    #[test]
    fn test_derive_verified_message_pda_distinct_per_message_id() {
        let program_id = Pubkey::new_unique();
        let sender = [0xAA; 32];
        let (pda_1, _) = derive_verified_message_pda(&program_id, &sender, &[0x01; 32]);
        let (pda_2, _) = derive_verified_message_pda(&program_id, &sender, &[0x02; 32]);
        assert_ne!(pda_1, pda_2);
    }

    #[test]
    fn test_derive_verified_message_pda_deterministic() {
        let program_id = Pubkey::new_unique();
        let sender = [0xAA; 32];
        let message_id = [0xCC; 32];
        let (pda_1, bump_1) = derive_verified_message_pda(&program_id, &sender, &message_id);
        let (pda_2, bump_2) = derive_verified_message_pda(&program_id, &sender, &message_id);
        assert_eq!(pda_1, pda_2);
        assert_eq!(bump_1, bump_2);
    }
}
