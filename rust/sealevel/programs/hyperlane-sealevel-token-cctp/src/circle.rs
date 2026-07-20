//! Interface to Circle's real, deployed CCTP v2 Solana programs:
//! `TokenMessengerMinterV2` (burn/mint) and `MessageTransmitterV2` (generic
//! attestation-gated delivery, used here only for its `receive_message`
//! instruction with `receiver = TokenMessengerMinterV2`).
//!
//! Confirmed byte-for-byte from `circlefin/solana-cctp-contracts`, branch
//! `master` (raw source reads, not paraphrased):
//! - `programs/v2/token-messenger-minter-v2/src/instructions/deposit_for_burn.rs`
//! - `programs/v2/token-messenger-minter-v2/src/instructions/handle_receive_finalized_message.rs`
//! - `programs/v2/token-messenger-minter-v2/src/burn_message.rs`
//!
//! Both `TokenMessengerMinterV2` and `MessageTransmitterV2` are Anchor
//! programs (confirmed: `declare_id!` inside `#[program] pub mod
//! token_messenger_minter_v2`), so CPI instruction data needs the standard
//! Anchor 8-byte sighash discriminator (`sha256("global:<method>")[..8]`)
//! prepended to Borsh-serialized args — this file computes those constants
//! but our own code stays native Rust throughout (no Anchor dependency).
//!
//! CAVEAT: account lists and struct layouts below are confirmed against
//! Circle's source, not exercised against a live transaction. In particular,
//! the exact `is_signer`/`is_writable` flags on PDA accounts that Circle's
//! *own* program internally signs via nested `invoke_signed` (as opposed to
//! ones we sign ourselves) should be double-checked on devnet before mainnet
//! use — see inline notes at each such account.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

/// Circle's `TokenMessengerMinterV2` program — burns/mints USDC.
pub mod token_messenger_minter {
    solana_program::declare_id!("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
}

/// Circle's `MessageTransmitterV2` program — generic attestation-gated
/// message delivery. We only ever call its `receive_message` with
/// `receiver = token_messenger_minter::ID` (Circle's own program, not us —
/// so this never hits the A->B->A reentrancy restriction the composite-ism
/// `CctpV2` GMP node had to work around).
pub mod message_transmitter {
    solana_program::declare_id!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
}

/// Seed for `MessageTransmitterV2`'s own global config PDA.
pub const MESSAGE_TRANSMITTER_SEED: &[u8] = b"message_transmitter";

pub fn derive_message_transmitter_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MESSAGE_TRANSMITTER_SEED], &message_transmitter::ID)
}

/// Seed for the per-nonce replay-protection PDA MessageTransmitterV2 creates
/// on `receive_message`.
pub const USED_NONCE_SEED: &[u8] = b"used_nonce";

pub fn derive_used_nonce_pda(nonce: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[USED_NONCE_SEED, nonce], &message_transmitter::ID)
}

/// Seed for the authority PDA `MessageTransmitterV2` signs (via its own
/// internal `invoke_signed`) when it CPIs into a `receiver` program's
/// callback. Derived under `MessageTransmitterV2`'s own program ID with the
/// receiver's program ID as part of the seed — same convention confirmed
/// for `hyperlane-sealevel-cctp-receiver`'s generic-message case, here with
/// `receiver = token_messenger_minter::ID`.
pub const MESSAGE_TRANSMITTER_AUTHORITY_SEED: &[u8] = b"message_transmitter_authority";

pub fn derive_message_transmitter_authority_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            MESSAGE_TRANSMITTER_AUTHORITY_SEED,
            token_messenger_minter::ID.as_ref(),
        ],
        &message_transmitter::ID,
    )
}

/// The generic CCTP v2 message header (148 bytes, fixed) wrapping the
/// `BurnMessage` body for a burn/mint transfer. Same layout as the GMP case
/// in `hyperlane-sealevel-composite-ism`'s `cctp.rs` — duplicated here
/// rather than shared, since the two programs are otherwise unrelated (a
/// future refactor could extract a shared `cctp-v2-message` library crate).
pub struct CctpV2Header<'a> {
    pub version: u32,
    pub source_domain: u32,
    pub destination_domain: u32,
    pub nonce: [u8; 32],
    pub message_body: &'a [u8],
}

const CCTP_V2_HEADER_LEN: usize = 4 + 4 + 4 + 32 + 32 + 32 + 32 + 4 + 4; // 148

/// CCTP message format version this program supports (0 = v1, 1 = v2).
pub const CCTP_V2_MESSAGE_VERSION: u32 = 1;

/// Circle's domain ID for Solana (see
/// developers.circle.com/cctp/cctp-supported-blockchains).
pub const CCTP_SOLANA_DOMAIN: u32 = 5;

impl<'a> CctpV2Header<'a> {
    /// Parses `version`, `source_domain`, `destination_domain`, `nonce`, and
    /// `message_body`. `sender`, `recipient`, `destination_caller`,
    /// `min_finality_threshold`, `finality_threshold_executed` are skipped:
    /// nothing here depends on them — `sender` in particular is checked by
    /// Circle's own `handle_receive_finalized_message` against its
    /// `remote_token_messenger` registry, not by us (see module docs).
    pub fn parse(message: &'a [u8]) -> Result<Self, ProgramError> {
        if message.len() < CCTP_V2_HEADER_LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        let version = u32::from_be_bytes(message[0..4].try_into().unwrap());
        let source_domain = u32::from_be_bytes(message[4..8].try_into().unwrap());
        let destination_domain = u32::from_be_bytes(message[8..12].try_into().unwrap());
        let mut nonce = [0u8; 32];
        nonce.copy_from_slice(&message[12..44]);
        let message_body = &message[CCTP_V2_HEADER_LEN..];
        Ok(Self {
            version,
            source_domain,
            destination_domain,
            nonce,
            message_body,
        })
    }
}

/// `sha256("global:deposit_for_burn")[..8]`.
pub const DEPOSIT_FOR_BURN_DISCRIMINATOR: [u8; 8] =
    [0xd7, 0x3c, 0x3d, 0x2e, 0x72, 0x37, 0x80, 0xb0];

/// `sha256("global:receive_message")[..8]` — same discriminator used
/// elsewhere for MessageTransmitterV2's `receive_message`; recomputed here
/// as its own constant since this crate doesn't depend on
/// `hyperlane-sealevel-cctp-hook`/`-cctp-receiver`.
pub const RECEIVE_MESSAGE_DISCRIMINATOR: [u8; 8] = [0x26, 0x90, 0x7f, 0xe1, 0x1f, 0xe1, 0xee, 0x19];

/// Anchor event-CPI accounts (`#[event_cpi]`): a self-CPI convention so
/// off-chain indexers reliably capture emitted events. Seeds are fixed by
/// Anchor's macro, not something Circle configures.
pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

/// Derives the event-authority PDA for a given Circle program (used for both
/// `token_messenger_minter` and `message_transmitter` event CPI accounts).
pub fn derive_event_authority_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[EVENT_AUTHORITY_SEED], program_id)
}

/// Seed for `TokenMessengerMinterV2`'s own internal CPI-signing authority
/// (used when it calls `MessageTransmitterV2.send_message` from inside
/// `deposit_for_burn`). Derived under **`TokenMessengerMinterV2`'s own**
/// program ID — Circle's program signs for this internally via its own
/// nested `invoke_signed`; we (the external caller of `deposit_for_burn`)
/// never sign it ourselves, we just supply the pubkey.
pub const SENDER_AUTHORITY_SEED: &[u8] = b"sender_authority";

pub fn derive_token_messenger_sender_authority_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SENDER_AUTHORITY_SEED], &token_messenger_minter::ID)
}

/// Per-caller denylist PDA, seeds `["denylist_account", owner]`.
pub const DENYLIST_ACCOUNT_SEED: &[u8] = b"denylist_account";

pub fn derive_denylist_account_pda(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[DENYLIST_ACCOUNT_SEED, owner.as_ref()],
        &token_messenger_minter::ID,
    )
}

/// Per-remote-domain registration PDA, seeds `["remote_token_messenger",
/// domain]` (domain formatted as its decimal string, per Circle's Anchor
/// seed convention — confirmed from `add_remote_token_messenger.rs`).
/// Stores the well-known, admin-registered TokenMessengerMinter/TokenMessenger
/// address on that remote chain. Circle's own `handle_receive_*_message`
/// checks the burn message's `message_sender` against this — we don't need
/// our own sender-enrollment check the way the GMP `CctpV2` ISM node did.
pub const REMOTE_TOKEN_MESSENGER_SEED: &[u8] = b"remote_token_messenger";

pub fn derive_remote_token_messenger_pda(domain: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[REMOTE_TOKEN_MESSENGER_SEED, domain.to_string().as_bytes()],
        &token_messenger_minter::ID,
    )
}

/// Local per-mint config PDA, seeds `["local_token", mint]`.
pub const LOCAL_TOKEN_SEED: &[u8] = b"local_token";

pub fn derive_local_token_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[LOCAL_TOKEN_SEED, mint.as_ref()],
        &token_messenger_minter::ID,
    )
}

/// Per-(remote domain, burn token) pair PDA, seeds `["token_pair", domain,
/// burn_token_bytes]` (domain formatted as decimal string, matching
/// `remote_token_messenger`'s convention).
pub const TOKEN_PAIR_SEED: &[u8] = b"token_pair";

pub fn derive_token_pair_pda(remote_domain: u32, remote_burn_token: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            TOKEN_PAIR_SEED,
            remote_domain.to_string().as_bytes(),
            remote_burn_token,
        ],
        &token_messenger_minter::ID,
    )
}

/// Custody token account PDA, seeds `["custody", mint]`.
pub const CUSTODY_SEED: &[u8] = b"custody";

pub fn derive_custody_token_account_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CUSTODY_SEED, mint.as_ref()], &token_messenger_minter::ID)
}

/// Global singleton `TokenMessenger` config PDA, seeds `["token_messenger"]`
/// (confirmed from `token_messenger_v2/instructions/initialize.rs`). One per
/// `TokenMessengerMinterV2` deployment, not per-mint/per-domain.
pub const TOKEN_MESSENGER_SEED: &[u8] = b"token_messenger";

pub fn derive_token_messenger_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TOKEN_MESSENGER_SEED], &token_messenger_minter::ID)
}

/// Global singleton `TokenMinter` config PDA, seeds `["token_minter"]`
/// (confirmed from `token_messenger_v2/instructions/initialize.rs`). One per
/// `TokenMessengerMinterV2` deployment.
pub const TOKEN_MINTER_SEED: &[u8] = b"token_minter";

pub fn derive_token_minter_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TOKEN_MINTER_SEED], &token_messenger_minter::ID)
}

/// Byte offset of the `fee_recipient: Pubkey` field within the
/// `TokenMessenger` account's data (confirmed from
/// `token_messenger_v2/state.rs`'s field order: 8-byte Anchor discriminator +
/// `denylister`(32) + `owner`(32) + `pending_owner`(32) +
/// `message_body_version`(4) + `authority_bump`(1) = 109).
const TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET: usize = 109;

/// Reads the `fee_recipient` field out of a `TokenMessenger` account's raw
/// data. Mutable, admin-set by Circle (`set_fee_recipient`) — not itself a
/// PDA, so it must be read at runtime rather than derived.
pub fn parse_token_messenger_fee_recipient(data: &[u8]) -> Result<Pubkey, ProgramError> {
    let end = TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET + 32;
    if data.len() < end {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(Pubkey::new_from_array(
        data[TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET..end]
            .try_into()
            .unwrap(),
    ))
}

/// Instruction args for `deposit_for_burn`. Field order matches Circle's
/// real struct exactly (`#[repr(C)]`, explicitly not reorderable since
/// `DepositForBurnWithHookParams` must deserialize as a prefix-compatible
/// superset of this).
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
pub struct DepositForBurnParams {
    pub amount: u64,
    pub destination_domain: u32,
    pub mint_recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
}

/// All accounts `deposit_for_burn` requires, confirmed in order from
/// `DepositForBurnContext` (`deposit_for_burn.rs`). Event-CPI accounts
/// (`event_authority`, `program` = `token_messenger_minter::ID` again) are
/// appended by Anchor's `#[event_cpi]` macro and included at the end here.
#[allow(clippy::too_many_arguments)]
pub fn deposit_for_burn_instruction(
    owner: Pubkey,
    event_rent_payer: Pubkey,
    burn_token_account: Pubkey,
    message_transmitter: Pubkey,
    token_messenger: Pubkey,
    token_minter: Pubkey,
    burn_token_mint: Pubkey,
    message_sent_event_data: Pubkey,
    token_program: Pubkey,
    system_program: Pubkey,
    params: DepositForBurnParams,
) -> Result<SolanaInstruction, ProgramError> {
    let (sender_authority_pda, _) = derive_token_messenger_sender_authority_pda();
    let (denylist_account, _) = derive_denylist_account_pda(&owner);
    let (remote_token_messenger, _) = derive_remote_token_messenger_pda(params.destination_domain);
    let (local_token, _) = derive_local_token_pda(&burn_token_mint);
    let (event_authority, _) = derive_event_authority_pda(&token_messenger_minter::ID);

    let mut data = DEPOSIT_FOR_BURN_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&borsh::to_vec(&params).map_err(|_| ProgramError::BorshIoError)?);

    Ok(SolanaInstruction {
        program_id: token_messenger_minter::ID,
        accounts: vec![
            AccountMeta::new_readonly(owner, true),
            AccountMeta::new(event_rent_payer, true),
            // Circle's own program signs this internally via its own nested
            // invoke_signed (seeds under ITS OWN program ID) when it calls
            // MessageTransmitterV2.send_message from inside deposit_for_burn
            // — we never sign it ourselves, only supply the pubkey.
            AccountMeta::new_readonly(sender_authority_pda, false),
            AccountMeta::new(burn_token_account, false),
            AccountMeta::new_readonly(denylist_account, false),
            AccountMeta::new(message_transmitter, false),
            AccountMeta::new_readonly(token_messenger, false),
            AccountMeta::new_readonly(remote_token_messenger, false),
            AccountMeta::new_readonly(token_minter, false),
            AccountMeta::new(local_token, false),
            AccountMeta::new(burn_token_mint, false),
            AccountMeta::new(message_sent_event_data, true),
            AccountMeta::new_readonly(message_transmitter::ID, false),
            AccountMeta::new_readonly(token_messenger_minter::ID, false),
            AccountMeta::new_readonly(token_program, false),
            AccountMeta::new_readonly(system_program, false),
            AccountMeta::new_readonly(event_authority, false),
            AccountMeta::new_readonly(token_messenger_minter::ID, false),
        ],
        data,
    })
}

/// Builds the CPI instruction for `MessageTransmitterV2.receive_message`
/// with `receiver = TokenMessengerMinterV2` — Circle's own program, so this
/// is legal even when called from inside our own ISM's `Verify()` (no
/// A->B->A reentrancy: the callback lands on a *different* program than the
/// one that invoked `receive_message`).
///
/// Accounts match `hyperlane-sealevel-cctp-hook`/`-cctp-receiver`'s
/// `MessageTransmitterV2` interface for the generic-message case, except
/// `receiver` here is `token_messenger_minter::ID` and the trailing
/// `remaining_accounts` are `TokenMessengerMinterV2`'s own mint-side
/// accounts (see [`handle_receive_message_remaining_accounts`]).
#[allow(clippy::too_many_arguments)]
pub fn receive_message_instruction(
    payer: Pubkey,
    caller: Pubkey,
    authority_pda: Pubkey,
    message_transmitter: Pubkey,
    used_nonce: Pubkey,
    system_program: Pubkey,
    message: Vec<u8>,
    attestation: Vec<u8>,
    remaining_accounts: &[AccountMeta],
) -> Result<SolanaInstruction, ProgramError> {
    let mut data = RECEIVE_MESSAGE_DISCRIMINATOR.to_vec();
    data.extend_from_slice(
        &borsh::to_vec(&ReceiveMessageParams {
            message,
            attestation,
        })
        .map_err(|_| ProgramError::BorshIoError)?,
    );

    let mut accounts = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new_readonly(caller, true),
        AccountMeta::new_readonly(authority_pda, false),
        AccountMeta::new(message_transmitter, false),
        AccountMeta::new(used_nonce, false),
        AccountMeta::new_readonly(token_messenger_minter::ID, false),
        AccountMeta::new_readonly(system_program, false),
    ];
    accounts.extend_from_slice(remaining_accounts);

    Ok(SolanaInstruction {
        program_id: message_transmitter::ID,
        accounts,
        data,
    })
}

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
struct ReceiveMessageParams {
    message: Vec<u8>,
    attestation: Vec<u8>,
}

/// The `remaining_accounts` `TokenMessengerMinterV2`'s
/// `handle_receive_{finalized,unfinalized}_message` callback needs, beyond
/// the `authority_pda` Circle's `MessageTransmitterV2` supplies itself.
/// Confirmed order from `HandleReceiveMessageContext`
/// (`handle_receive_finalized_message.rs`, shared by the unfinalized variant).
#[allow(clippy::too_many_arguments)]
pub fn handle_receive_message_remaining_accounts(
    token_messenger: Pubkey,
    remote_domain: u32,
    remote_burn_token: &[u8; 32],
    token_minter: Pubkey,
    mint: Pubkey,
    fee_recipient_token_account: Pubkey,
    recipient_token_account: Pubkey,
    token_program: Pubkey,
) -> Vec<AccountMeta> {
    let (remote_token_messenger, _) = derive_remote_token_messenger_pda(remote_domain);
    let (local_token, _) = derive_local_token_pda(&mint);
    let (token_pair, _) = derive_token_pair_pda(remote_domain, remote_burn_token);
    let (custody_token_account, _) = derive_custody_token_account_pda(&mint);
    let (event_authority, _) = derive_event_authority_pda(&token_messenger_minter::ID);

    vec![
        AccountMeta::new_readonly(token_messenger, false),
        AccountMeta::new_readonly(remote_token_messenger, false),
        AccountMeta::new_readonly(token_minter, false),
        AccountMeta::new(local_token, false),
        AccountMeta::new(token_pair, false),
        AccountMeta::new(fee_recipient_token_account, false),
        AccountMeta::new(recipient_token_account, false),
        AccountMeta::new(custody_token_account, false),
        AccountMeta::new_readonly(token_program, false),
        AccountMeta::new_readonly(event_authority, false),
        AccountMeta::new_readonly(token_messenger_minter::ID, false),
    ]
}

/// The CCTP v2 `BurnMessage` body (the CCTP message's `message_body`, once
/// the outer 148-byte generic header is stripped — see
/// `hyperlane-sealevel-cctp-receiver`/`-cctp-hook` for that header; this
/// program only ever deals with the burn-message body since it never
/// handles the generic GMP case).
///
/// Layout confirmed byte-for-byte from `token_messenger_v2/burn_message.rs`:
/// every field after `version` occupies a 32-byte big-endian-right-justified
/// slot (matching CCTP's cross-VM word-alignment convention), not a compact
/// encoding — this must be parsed manually, not via Borsh.
#[derive(Debug, PartialEq, Clone)]
pub struct BurnMessage {
    pub version: u32,
    pub burn_token: Pubkey,
    pub mint_recipient: Pubkey,
    pub amount: u64,
    pub message_sender: Pubkey,
    pub max_fee: u64,
    pub fee_executed: u64,
    pub expiration_block: u64,
    pub hook_data: Vec<u8>,
}

const BURN_MESSAGE_FIXED_LEN: usize = 4 + 32 + 32 + 32 + 32 + 32 + 32 + 32; // 228

impl BurnMessage {
    pub fn parse(body: &[u8]) -> Result<Self, ProgramError> {
        if body.len() < BURN_MESSAGE_FIXED_LEN {
            return Err(ProgramError::InvalidInstructionData);
        }
        let version = u32::from_be_bytes(body[0..4].try_into().unwrap());
        let burn_token = Pubkey::new_from_array(body[4..36].try_into().unwrap());
        let mint_recipient = Pubkey::new_from_array(body[36..68].try_into().unwrap());
        let amount = parse_u64_slot(&body[68..100])?;
        let message_sender = Pubkey::new_from_array(body[100..132].try_into().unwrap());
        let max_fee = parse_u64_slot(&body[132..164])?;
        let fee_executed = parse_u64_slot(&body[164..196])?;
        let expiration_block = parse_u64_slot(&body[196..228])?;
        let hook_data = body[228..].to_vec();
        Ok(Self {
            version,
            burn_token,
            mint_recipient,
            amount,
            message_sender,
            max_fee,
            fee_executed,
            expiration_block,
            hook_data,
        })
    }

    #[cfg(test)]
    fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(BURN_MESSAGE_FIXED_LEN + self.hook_data.len());
        buf.extend_from_slice(&self.version.to_be_bytes());
        buf.extend_from_slice(self.burn_token.as_ref());
        buf.extend_from_slice(self.mint_recipient.as_ref());
        buf.extend_from_slice(&encode_u64_slot(self.amount));
        buf.extend_from_slice(self.message_sender.as_ref());
        buf.extend_from_slice(&encode_u64_slot(self.max_fee));
        buf.extend_from_slice(&encode_u64_slot(self.fee_executed));
        buf.extend_from_slice(&encode_u64_slot(self.expiration_block));
        buf.extend_from_slice(&self.hook_data);
        buf
    }
}

/// Reads a big-endian `u64` right-justified in a 32-byte slot (top 24 bytes
/// must be zero — a burn amount/fee that overflows u64 is not realistic and
/// treated as malformed rather than silently truncated).
fn parse_u64_slot(slot: &[u8]) -> Result<u64, ProgramError> {
    if slot[..24].iter().any(|&b| b != 0) {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(u64::from_be_bytes(slot[24..32].try_into().unwrap()))
}

#[cfg(test)]
fn encode_u64_slot(value: u64) -> [u8; 32] {
    let mut slot = [0u8; 32];
    slot[24..32].copy_from_slice(&value.to_be_bytes());
    slot
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_deposit_for_burn_discriminator_matches_anchor_sighash() {
        let computed = solana_program::hash::hash(b"global:deposit_for_burn");
        assert_eq!(
            &computed.to_bytes()[..8],
            &DEPOSIT_FOR_BURN_DISCRIMINATOR[..]
        );
    }

    #[test]
    fn test_receive_message_discriminator_matches_anchor_sighash() {
        let computed = solana_program::hash::hash(b"global:receive_message");
        assert_eq!(
            &computed.to_bytes()[..8],
            &RECEIVE_MESSAGE_DISCRIMINATOR[..]
        );
    }

    #[test]
    fn test_burn_message_roundtrip() {
        let msg = BurnMessage {
            version: 1,
            burn_token: Pubkey::new_unique(),
            mint_recipient: Pubkey::new_unique(),
            amount: 1_000_000,
            message_sender: Pubkey::new_unique(),
            max_fee: 100,
            fee_executed: 0,
            expiration_block: 0,
            hook_data: vec![],
        };
        let encoded = msg.encode();
        assert_eq!(encoded.len(), BURN_MESSAGE_FIXED_LEN);
        let decoded = BurnMessage::parse(&encoded).unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn test_burn_message_with_hook_data_roundtrip() {
        let msg = BurnMessage {
            version: 1,
            burn_token: Pubkey::new_unique(),
            mint_recipient: Pubkey::new_unique(),
            amount: u64::MAX,
            message_sender: Pubkey::new_unique(),
            max_fee: 42,
            fee_executed: 42,
            expiration_block: 12345,
            hook_data: vec![0xAB; 10],
        };
        let encoded = msg.encode();
        let decoded = BurnMessage::parse(&encoded).unwrap();
        assert_eq!(msg, decoded);
    }

    #[test]
    fn test_burn_message_too_short_rejected() {
        let body = vec![0u8; BURN_MESSAGE_FIXED_LEN - 1];
        assert!(BurnMessage::parse(&body).is_err());
    }

    #[test]
    fn test_burn_message_amount_overflow_slot_rejected() {
        let mut body = vec![0u8; BURN_MESSAGE_FIXED_LEN];
        body[68] = 1; // non-zero in the padding portion of the amount slot
        assert!(BurnMessage::parse(&body).is_err());
    }

    #[test]
    fn test_pda_derivations_deterministic_and_distinct_per_domain() {
        let (rtm_0, _) = derive_remote_token_messenger_pda(0);
        let (rtm_5, _) = derive_remote_token_messenger_pda(5);
        assert_ne!(rtm_0, rtm_5);

        let (rtm_0_again, _) = derive_remote_token_messenger_pda(0);
        assert_eq!(rtm_0, rtm_0_again);
    }

    #[test]
    fn test_deposit_for_burn_instruction_builds() {
        let params = DepositForBurnParams {
            amount: 1_000_000,
            destination_domain: 0,
            mint_recipient: Pubkey::new_unique(),
            destination_caller: Pubkey::new_from_array([0u8; 32]),
            max_fee: 100,
            min_finality_threshold: 2000,
        };
        let ixn = deposit_for_burn_instruction(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            params,
        )
        .unwrap();
        assert_eq!(ixn.program_id, token_messenger_minter::ID);
        // owner, event_rent_payer, sender_authority_pda, burn_token_account,
        // denylist_account, message_transmitter, token_messenger,
        // remote_token_messenger, token_minter, local_token, burn_token_mint,
        // message_sent_event_data, message_transmitter_program,
        // token_messenger_minter_program, token_program, system_program,
        // event_authority, event_cpi program = 18.
        assert_eq!(ixn.accounts.len(), 18);
        assert_eq!(&ixn.data[..8], &DEPOSIT_FOR_BURN_DISCRIMINATOR[..]);
    }

    #[test]
    fn test_used_nonce_pda_distinct_per_nonce() {
        let (pda_a, _) = derive_used_nonce_pda(&[0x01; 32]);
        let (pda_b, _) = derive_used_nonce_pda(&[0x02; 32]);
        assert_ne!(pda_a, pda_b);
    }

    #[test]
    fn test_message_transmitter_authority_pda_deterministic() {
        let (pda_1, _) = derive_message_transmitter_authority_pda();
        let (pda_2, _) = derive_message_transmitter_authority_pda();
        assert_eq!(pda_1, pda_2);
        // Must differ from the generic-message-case authority PDA in
        // hyperlane-sealevel-cctp-receiver, since that one is seeded with a
        // *different* receiver program ID (the composite-ism CCTP receiver,
        // not token_messenger_minter).
    }

    fn build_cctp_v2_message(
        version: u32,
        source_domain: u32,
        destination_domain: u32,
        nonce: [u8; 32],
        body: &[u8],
    ) -> Vec<u8> {
        let mut m = Vec::with_capacity(CCTP_V2_HEADER_LEN + body.len());
        m.extend_from_slice(&version.to_be_bytes());
        m.extend_from_slice(&source_domain.to_be_bytes());
        m.extend_from_slice(&destination_domain.to_be_bytes());
        m.extend_from_slice(&nonce);
        m.extend_from_slice(&[0xAA; 32]); // sender (not checked by us)
        m.extend_from_slice(&[0xBB; 32]); // recipient
        m.extend_from_slice(&[0u8; 32]); // destination_caller
        m.extend_from_slice(&2000u32.to_be_bytes()); // min_finality_threshold
        m.extend_from_slice(&2000u32.to_be_bytes()); // finality_threshold_executed
        m.extend_from_slice(body);
        m
    }

    #[test]
    fn test_cctp_v2_header_parse() {
        let nonce = [0x11; 32];
        let body = [0xCC; 40];
        let message = build_cctp_v2_message(1, 0, CCTP_SOLANA_DOMAIN, nonce, &body);
        let header = CctpV2Header::parse(&message).unwrap();
        assert_eq!(header.version, 1);
        assert_eq!(header.source_domain, 0);
        assert_eq!(header.destination_domain, CCTP_SOLANA_DOMAIN);
        assert_eq!(header.nonce, nonce);
        assert_eq!(header.message_body, &body[..]);
    }

    #[test]
    fn test_cctp_v2_header_too_short_rejected() {
        let message = vec![0u8; CCTP_V2_HEADER_LEN - 1];
        assert!(CctpV2Header::parse(&message).is_err());
    }

    #[test]
    fn test_token_messenger_and_token_minter_pdas_are_singletons() {
        let (tm1, _) = derive_token_messenger_pda();
        let (tm2, _) = derive_token_messenger_pda();
        assert_eq!(tm1, tm2);
        let (tmin1, _) = derive_token_minter_pda();
        assert_ne!(tm1, tmin1);
    }

    #[test]
    fn test_parse_token_messenger_fee_recipient() {
        let fee_recipient = Pubkey::new_unique();
        let mut data = vec![0u8; TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET + 32];
        data[TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET..TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET + 32]
            .copy_from_slice(fee_recipient.as_ref());
        let parsed = parse_token_messenger_fee_recipient(&data).unwrap();
        assert_eq!(parsed, fee_recipient);
    }

    #[test]
    fn test_parse_token_messenger_fee_recipient_too_short_rejected() {
        let data = vec![0u8; TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET + 31];
        assert!(parse_token_messenger_fee_recipient(&data).is_err());
    }
}
