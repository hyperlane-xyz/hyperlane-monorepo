//! Hyperlane Sealevel Mailbox data account layouts.

use core::cell::RefMut;

use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{accumulator::incremental::IncrementalMerkle as MerkleTree, H256};
use solana_program::{
    account_info::AccountInfo, clock::Slot, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds, protocol_fee::ProtocolFee};

/// The Inbox account.
pub type InboxAccount = AccountData<Inbox>;

/// The Inbox account data, which is used when processing messages.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq)]
pub struct Inbox {
    /// The local domain.
    pub local_domain: u32,
    /// The bump seed of the inbox PDA.
    pub inbox_bump_seed: u8,
    /// The default ISM.
    pub default_ism: Pubkey,
    /// The number of messages processed. Used for easy indexing of processed messages.
    pub processed_count: u64,
}

impl SizedData for Inbox {
    fn size(&self) -> usize {
        // 4 byte local_domain
        // 1 byte inbox_bump_seed
        // 32 byte default_ism
        // 8 byte processed_count
        4 + 1 + 32 + 8
    }
}

impl Inbox {
    /// Verifies that the given account is the canonical Inbox PDA and returns the deserialized inner data.
    pub fn verify_account_and_fetch_inner(
        program_id: &Pubkey,
        inbox_account_info: &AccountInfo<'_>,
    ) -> Result<Self, ProgramError> {
        let inbox = InboxAccount::fetch(&mut &inbox_account_info.data.borrow()[..])?.into_inner();
        let expected_inbox_key = Pubkey::create_program_address(
            mailbox_inbox_pda_seeds!(inbox.inbox_bump_seed),
            program_id,
        )?;
        if inbox_account_info.key != &expected_inbox_key {
            return Err(ProgramError::InvalidArgument);
        }
        if inbox_account_info.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }

        Ok(*inbox)
    }

    /// Verifies that the given account is the canonical Inbox PDA, and returns the deserialized inner data
    /// alongside a RefMut of the account data.
    /// Intended to be used when the account data's RefMut is required, e.g. as a
    /// reentrancy guard.
    pub fn verify_account_and_fetch_inner_with_data_refmut<'a, 'b>(
        program_id: &'b Pubkey,
        inbox_account_info: &'b AccountInfo<'a>,
    ) -> Result<(Self, RefMut<'b, &'a mut [u8]>), ProgramError> {
        let data_refmut = inbox_account_info.try_borrow_mut_data()?;

        let inbox = InboxAccount::fetch(&mut &data_refmut[..])?.into_inner();
        let expected_inbox_key = Pubkey::create_program_address(
            mailbox_inbox_pda_seeds!(inbox.inbox_bump_seed),
            program_id,
        )?;
        if inbox_account_info.key != &expected_inbox_key {
            return Err(ProgramError::InvalidArgument);
        }
        if inbox_account_info.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }

        Ok((*inbox, data_refmut))
    }
}

/// The Outbox account.
pub type OutboxAccount = AccountData<Outbox>;

/// The Outbox account data, which is used when dispatching messages.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq)]
pub struct Outbox {
    /// The local domain.
    pub local_domain: u32,
    /// The bump seed of the outbox PDA.
    pub outbox_bump_seed: u8,
    /// The owner of this program, which has privileged permissions.
    pub owner: Option<Pubkey>,
    /// The merkle tree of dispatched messages.
    pub tree: MerkleTree,
    /// Max protocol fee that can be set.
    pub max_protocol_fee: u64,
    /// The protocol fee configuration.
    pub protocol_fee: ProtocolFee,
}

impl SizedData for Outbox {
    fn size(&self) -> usize {
        // 4 byte local_domain
        // 1 byte outbox_bump_seed
        // 33 byte owner (1 byte enum variant, 32 byte pubkey)
        // 1032 byte tree (32 * 32 = 1024 byte branch, 8 byte count)
        // 8 byte max_protocol_fee
        // 40 byte protocol_fee (8 byte fee, 32 byte beneficiary)
        4 + 1 + 33 + 1032 + 8 + 40
    }
}

impl AccessControl for Outbox {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = owner;
        Ok(())
    }
}

impl Outbox {
    /// Verifies that the given account is the canonical Outbox PDA and returns the deserialized inner data.
    /// Returns Box<Outbox> to avoid stack overflow during CPI calls (Outbox is 1118 bytes).
    pub fn verify_account_and_fetch_inner(
        program_id: &Pubkey,
        outbox_account_info: &AccountInfo,
    ) -> Result<Box<Self>, ProgramError> {
        let outbox =
            OutboxAccount::fetch(&mut &outbox_account_info.data.borrow()[..])?.into_inner();
        verify_outbox_key_and_owner(program_id, outbox_account_info, outbox.outbox_bump_seed)?;
        Ok(outbox)
    }

    /// Like `verify_account_and_fetch_inner`, but for dispatch: when the
    /// account data has the current layout, only the fields dispatch needs
    /// are read, and the tree is later updated in place.
    pub fn verify_account_and_fetch_for_dispatch(
        program_id: &Pubkey,
        outbox_account_info: &AccountInfo,
    ) -> Result<DispatchOutbox, ProgramError> {
        let view = OutboxDispatchView::parse(&outbox_account_info.data.borrow());
        match view {
            Some(view) => {
                verify_outbox_key_and_owner(
                    program_id,
                    outbox_account_info,
                    view.outbox_bump_seed,
                )?;
                Ok(DispatchOutbox::InPlace(view))
            }
            None => Ok(DispatchOutbox::Full(Self::verify_account_and_fetch_inner(
                program_id,
                outbox_account_info,
            )?)),
        }
    }
}

fn verify_outbox_key_and_owner(
    program_id: &Pubkey,
    outbox_account_info: &AccountInfo,
    outbox_bump_seed: u8,
) -> Result<(), ProgramError> {
    let expected_outbox_key =
        Pubkey::create_program_address(mailbox_outbox_pda_seeds!(outbox_bump_seed), program_id)?;
    if outbox_account_info.key != &expected_outbox_key {
        return Err(ProgramError::InvalidArgument);
    }
    if outbox_account_info.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    Ok(())
}

/// The Outbox fields dispatch reads, located directly in the `OutboxAccount`
/// data so dispatch can update the merkle tree in place instead of
/// deserializing and re-serializing the whole Outbox.
///
/// Encoding: initialized (1) | local_domain (4) | outbox_bump_seed (1) |
/// owner (1 byte tag, plus 32 if Some) | tree branch (1024) | tree count (8) |
/// max_protocol_fee (8) | protocol_fee.fee (8) | protocol_fee.beneficiary (32).
/// Only `owner` varies in length, so everything after it sits at a fixed
/// offset from the tree.
#[derive(Debug, PartialEq, Eq)]
pub struct OutboxDispatchView {
    /// The local domain.
    pub local_domain: u32,
    /// The bump seed of the outbox PDA.
    pub outbox_bump_seed: u8,
    /// The number of leaves in the merkle tree.
    pub count: usize,
    /// The current protocol fee.
    pub protocol_fee: u64,
    tree_offset: usize,
}

impl OutboxDispatchView {
    const LOCAL_DOMAIN_OFFSET: usize = 1;
    const BUMP_OFFSET: usize = 5;
    const OWNER_TAG_OFFSET: usize = 6;
    /// Bytes from the start of the tree to the end of the encoding.
    const TREE_TO_END: usize = MerkleTree::ENCODED_LEN + 8 + 8 + 32;
    /// Bytes from the start of the tree to `protocol_fee.fee`.
    const TREE_TO_FEE: usize = MerkleTree::ENCODED_LEN + 8;

    /// Reads the view from `OutboxAccount` data. Returns None unless the data
    /// is an initialized account with a valid owner tag and room for the full
    /// encoding. Exactly those accounts deserialize via `OutboxAccount::fetch`
    /// to the same values; anything else should take the `fetch` path, which
    /// errors (or defaults) as before.
    pub fn parse(data: &[u8]) -> Option<Self> {
        if *data.first()? != 1 {
            return None;
        }
        let tree_offset = match *data.get(Self::OWNER_TAG_OFFSET)? {
            0 => Self::OWNER_TAG_OFFSET + 1,
            1 => Self::OWNER_TAG_OFFSET + 1 + 32,
            _ => return None,
        };
        if data.len() < tree_offset + Self::TREE_TO_END {
            return None;
        }
        let count_offset = tree_offset + MerkleTree::ENCODED_LEN - 8;
        let fee_offset = tree_offset + Self::TREE_TO_FEE;
        Some(Self {
            local_domain: u32::from_le_bytes(read_array(data, Self::LOCAL_DOMAIN_OFFSET)?),
            outbox_bump_seed: data[Self::BUMP_OFFSET],
            count: usize::try_from(u64::from_le_bytes(read_array(data, count_offset)?)).ok()?,
            protocol_fee: u64::from_le_bytes(read_array(data, fee_offset)?),
            tree_offset,
        })
    }

    /// Ingests `id` into the tree in place and zeroes any trailing bytes,
    /// leaving the data identical to `tree.ingest(id)` followed by
    /// `OutboxAccount::store`.
    pub fn ingest_in_place(&self, data: &mut [u8], id: H256) -> Result<(), ProgramError> {
        let end = self.tree_offset + Self::TREE_TO_END;
        if data.len() < end {
            return Err(ProgramError::BorshIoError);
        }
        let (encoded, tail) = data.split_at_mut(end);
        let tree: &mut [u8; MerkleTree::ENCODED_LEN] = (&mut encoded
            [self.tree_offset..self.tree_offset + MerkleTree::ENCODED_LEN])
            .try_into()
            .map_err(|_| ProgramError::BorshIoError)?;
        MerkleTree::ingest_encoded(tree, id);
        tail.fill(0);
        Ok(())
    }
}

fn read_array<const N: usize>(data: &[u8], offset: usize) -> Option<[u8; N]> {
    data.get(offset..offset.checked_add(N)?)?.try_into().ok()
}

/// Outbox state used by dispatch: a view for in-place updates when the
/// account has the current layout, otherwise the fully deserialized Outbox.
pub enum DispatchOutbox {
    /// Current layout; the tree is updated in place.
    InPlace(OutboxDispatchView),
    /// Anything else; the Outbox is re-serialized with `OutboxAccount::store`.
    Full(Box<Outbox>),
}

impl DispatchOutbox {
    /// The local domain.
    pub fn local_domain(&self) -> u32 {
        match self {
            Self::InPlace(view) => view.local_domain,
            Self::Full(outbox) => outbox.local_domain,
        }
    }

    /// The number of dispatched messages.
    pub fn count(&self) -> usize {
        match self {
            Self::InPlace(view) => view.count,
            Self::Full(outbox) => outbox.tree.count(),
        }
    }

    /// The current protocol fee.
    pub fn protocol_fee(&self) -> u64 {
        match self {
            Self::InPlace(view) => view.protocol_fee,
            Self::Full(outbox) => outbox.protocol_fee.fee,
        }
    }

    /// Ingests the message ID into the tree and writes the Outbox back.
    pub fn ingest_and_store(self, outbox_account_info: &AccountInfo, id: H256) -> ProgramResult {
        match self {
            Self::InPlace(view) => {
                // Same check as `AccountData::store`.
                if !outbox_account_info.is_writable || outbox_account_info.executable {
                    return Err(ProgramError::InvalidAccountData);
                }
                view.ingest_in_place(&mut outbox_account_info.try_borrow_mut_data()?, id)
            }
            Self::Full(mut outbox) => {
                outbox.tree.ingest(id);
                OutboxAccount::from(outbox).store(outbox_account_info, true)
            }
        }
    }
}

/// An account corresponding to a dispatched message.
pub type DispatchedMessageAccount = AccountData<DispatchedMessage>;

/// A discriminator used to easily identify dispatched message accounts.
/// This is the first 8 bytes of the account data.
pub const DISPATCHED_MESSAGE_DISCRIMINATOR: &[u8; 8] = b"DISPATCH";

/// A dispatched message.
#[derive(Debug, Default, Eq, PartialEq)]
pub struct DispatchedMessage {
    /// The discriminator, intended to be set to `DISPATCHED_MESSAGE_DISCRIMINATOR`.
    pub discriminator: [u8; 8],
    /// The nonce of the message.
    pub nonce: u32,
    /// The slot in which the message was dispatched.
    pub slot: Slot,
    /// The unique message pubkey used when the message was dispatched.
    pub unique_message_pubkey: Pubkey,
    /// The encoded message.
    pub encoded_message: Vec<u8>,
}

impl DispatchedMessage {
    /// Creates a new dispatched message.
    pub fn new(
        nonce: u32,
        slot: Slot,
        unique_message_pubkey: Pubkey,
        encoded_message: Vec<u8>,
    ) -> Self {
        Self {
            discriminator: *DISPATCHED_MESSAGE_DISCRIMINATOR,
            nonce,
            slot,
            unique_message_pubkey,
            encoded_message,
        }
    }
}

impl SizedData for DispatchedMessage {
    fn size(&self) -> usize {
        // 8 byte discriminator
        // 4 byte nonce
        // 8 byte slot
        // 32 byte unique_message_pubkey
        // encoded_message.len() bytes
        8 + 4 + 8 + 32 + self.encoded_message.len()
    }
}

/// For tighter packing and explicit endianness, we implement our own serialization.
impl BorshSerialize for DispatchedMessage {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_all(DISPATCHED_MESSAGE_DISCRIMINATOR)?;
        writer.write_all(&self.nonce.to_le_bytes())?;
        writer.write_all(&self.slot.to_le_bytes())?;
        writer.write_all(&self.unique_message_pubkey.to_bytes())?;
        writer.write_all(&self.encoded_message)?;
        Ok(())
    }
}

/// For tighter packing, explicit endianness, and errors on an invalid discriminator, we implement our own deserialization.
impl BorshDeserialize for DispatchedMessage {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut discriminator = [0u8; 8];
        reader.read_exact(&mut discriminator)?;
        if &discriminator != DISPATCHED_MESSAGE_DISCRIMINATOR {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid discriminator",
            ));
        }

        let mut nonce = [0u8; 4];
        reader.read_exact(&mut nonce)?;

        let mut slot = [0u8; 8];
        reader.read_exact(&mut slot)?;

        let mut unique_message_pubkey = [0u8; 32];
        reader.read_exact(&mut unique_message_pubkey)?;

        let mut encoded_message = vec![];
        reader.read_to_end(&mut encoded_message)?;

        Ok(Self {
            discriminator,
            nonce: u32::from_le_bytes(nonce),
            slot: u64::from_le_bytes(slot),
            unique_message_pubkey: Pubkey::new_from_array(unique_message_pubkey),
            encoded_message,
        })
    }
}

/// An account corresponding to a processed message.
pub type ProcessedMessageAccount = AccountData<ProcessedMessage>;

/// A discriminator used to easily identify processed message accounts.
pub const PROCESSED_MESSAGE_DISCRIMINATOR: &[u8; 8] = b"PROCESSD";

/// A processed message.
#[derive(Debug, Default, Eq, PartialEq, BorshSerialize)]
pub struct ProcessedMessage {
    /// The discriminator, intended to be set to `PROCESSED_MESSAGE_DISCRIMINATOR`.
    pub discriminator: [u8; 8],
    /// The sequence of the processed message, which increases from 0 for each processed message.
    /// This way, we can easily index processed messages.
    pub sequence: u64,
    /// The message ID of the processed message.
    pub message_id: H256,
    /// The slot in which the message was processed.
    pub slot: Slot,
}

impl ProcessedMessage {
    /// Creates a new processed message.
    pub fn new(sequence: u64, message_id: H256, slot: Slot) -> Self {
        Self {
            discriminator: *PROCESSED_MESSAGE_DISCRIMINATOR,
            sequence,
            message_id,
            slot,
        }
    }
}

impl SizedData for ProcessedMessage {
    fn size(&self) -> usize {
        // 8 byte discriminator
        // 8 byte sequence
        // 32 byte message_id
        // 8 byte slot
        8 + 8 + 32 + 8
    }
}

/// To error upon invalid data, we implement our own deserialization.
impl BorshDeserialize for ProcessedMessage {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let mut discriminator = [0u8; 8];
        reader.read_exact(&mut discriminator)?;
        if &discriminator != PROCESSED_MESSAGE_DISCRIMINATOR {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid discriminator",
            ));
        }

        let mut sequence = [0u8; 8];
        reader.read_exact(&mut sequence)?;

        let mut message_id = [0u8; 32];
        reader.read_exact(&mut message_id)?;

        let mut slot = [0u8; 8];
        reader.read_exact(&mut slot)?;

        Ok(Self {
            discriminator,
            sequence: u64::from_le_bytes(sequence),
            message_id: H256::from_slice(&message_id),
            slot: u64::from_le_bytes(slot),
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;

    use solana_program::pubkey::Pubkey;

    #[test]
    fn test_outbox_ser_deser() {
        let outbox = Outbox {
            local_domain: 420,
            outbox_bump_seed: 69,
            owner: Some(Pubkey::new_unique()),
            tree: MerkleTree::default(),
            max_protocol_fee: 100000000,
            protocol_fee: ProtocolFee {
                fee: 69696969,
                beneficiary: Pubkey::new_unique(),
            },
        };

        let mut serialized = vec![];
        outbox.serialize(&mut serialized).unwrap();

        let deserialized = Outbox::deserialize(&mut serialized.as_slice()).unwrap();

        assert_eq!(outbox, deserialized);
        assert_eq!(serialized.len(), outbox.size());
    }

    fn random_outbox(rng: &mut impl rand::Rng) -> Outbox {
        let mut tree = MerkleTree::default();
        for _ in 0..rng.gen_range(0..40) {
            tree.ingest(H256(rng.gen()));
        }
        // Also start from arbitrary frontiers and counts, including long carry chains.
        if rng.gen_bool(0.5) {
            tree = MerkleTree::new(
                core::array::from_fn(|_| H256(rng.gen())),
                match rng.gen_range(0..3) {
                    0 => rng.gen_range(0..100_000),
                    1 => (1usize << rng.gen_range(1..31)) - 1,
                    _ => rng.gen_range(0..u32::MAX as usize - 1_000),
                },
            );
        }
        Outbox {
            local_domain: rng.gen(),
            outbox_bump_seed: rng.gen(),
            owner: rng.gen_bool(0.5).then(|| Pubkey::new_from_array(rng.gen())),
            tree,
            max_protocol_fee: rng.gen(),
            protocol_fee: ProtocolFee {
                fee: rng.gen(),
                beneficiary: Pubkey::new_from_array(rng.gen()),
            },
        }
    }

    /// Dispatch's in-place tree update must leave the account bytes identical
    /// to the deserialize / ingest / store path, after every dispatch, for
    /// both owner encodings and for accounts longer than the encoding (e.g.
    /// grown by an earlier realloc) with zeroed or stale trailing bytes.
    #[test]
    fn test_outbox_in_place_dispatch_matches_store() {
        use rand::{rngs::StdRng, Rng, SeedableRng};
        let mut rng = StdRng::seed_from_u64(0x0b0c_d15b);
        for _ in 0..300 {
            let outbox = random_outbox(&mut rng);
            // `size()` assumes the owner is set.
            let encoded_len = 1 + outbox.size() - if outbox.owner.is_some() { 0 } else { 32 };
            let extra = match rng.gen_range(0..3) {
                0 => 0,
                1 => 1024,
                _ => rng.gen_range(1..2048),
            };
            let mut data = vec![0u8; encoded_len + extra];
            OutboxAccount::from(outbox)
                .store_in_slice(&mut data)
                .unwrap();
            if rng.gen_bool(0.5) {
                rng.fill(&mut data[encoded_len..]);
            }
            let mut expected = data.clone();

            for _ in 0..rng.gen_range(1..30) {
                let id = H256(rng.gen());

                let mut full = OutboxAccount::fetch(&mut &expected[..])
                    .unwrap()
                    .into_inner();
                let view = OutboxDispatchView::parse(&data).unwrap();
                assert_eq!(view.local_domain, full.local_domain);
                assert_eq!(view.outbox_bump_seed, full.outbox_bump_seed);
                assert_eq!(view.count, full.tree.count());
                assert_eq!(view.protocol_fee, full.protocol_fee.fee);

                full.tree.ingest(id);
                OutboxAccount::from(full)
                    .store_in_slice(&mut expected)
                    .unwrap();
                view.ingest_in_place(&mut data, id).unwrap();
                assert_eq!(data, expected);
            }
        }
    }

    /// Data the view doesn't recognise must be exactly the data that
    /// `OutboxAccount::fetch` rejects or defaults, so dispatch's fallback
    /// keeps the old behaviour (including realloc, which needs data shorter
    /// than the encoding and so can't follow a successful fetch).
    #[test]
    fn test_outbox_dispatch_view_falls_back_on_unrecognised_data() {
        use rand::{rngs::StdRng, SeedableRng};
        let mut rng = StdRng::seed_from_u64(7);
        for _ in 0..50 {
            let outbox = random_outbox(&mut rng);
            let mut data = vec![];
            true.serialize(&mut data).unwrap();
            outbox.serialize(&mut data).unwrap();

            // Truncated, e.g. an older, shorter layout: both reject.
            for len in [0, 1, 6, 7, data.len() - 41, data.len() - 1] {
                let short = &data[..len];
                assert!(OutboxDispatchView::parse(short).is_none());
                if len > 0 {
                    assert!(OutboxAccount::fetch(&mut &short[..]).is_err());
                }
            }
            // Empty or uninitialized: fetch defaults, view declines.
            assert_eq!(
                *OutboxAccount::fetch(&mut &[][..]).unwrap().into_inner(),
                Outbox::default()
            );
            let mut uninit = data.clone();
            uninit[0] = 0;
            assert!(OutboxDispatchView::parse(&uninit).is_none());
            assert_eq!(
                *OutboxAccount::fetch(&mut &uninit[..]).unwrap().into_inner(),
                Outbox::default()
            );
            // Invalid bool or owner tag: both reject.
            for (offset, value) in [(0, 2), (6, 2), (6, 255)] {
                let mut bad = data.clone();
                bad[offset] = value;
                assert!(OutboxDispatchView::parse(&bad).is_none());
                assert!(OutboxAccount::fetch(&mut &bad[..]).is_err());
            }
        }
    }

    #[test]
    fn test_inbox_ser_deser() {
        let inbox = Inbox {
            local_domain: 420,
            inbox_bump_seed: 69,
            default_ism: Pubkey::new_unique(),
            processed_count: 69696969,
        };

        let mut serialized = vec![];
        inbox.serialize(&mut serialized).unwrap();

        let deserialized = Inbox::deserialize(&mut serialized.as_slice()).unwrap();

        assert_eq!(inbox, deserialized);
        assert_eq!(serialized.len(), inbox.size());
    }

    #[test]
    fn test_dispatched_message_ser_deser() {
        let dispatched_message = DispatchedMessage::new(
            420,
            69696969,
            Pubkey::new_unique(),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 0],
        );

        let mut serialized = vec![];
        dispatched_message.serialize(&mut serialized).unwrap();

        let deserialized = DispatchedMessage::deserialize(&mut serialized.as_slice()).unwrap();

        assert_eq!(dispatched_message, deserialized);
        assert_eq!(serialized.len(), dispatched_message.size());
    }

    #[test]
    fn test_processed_message_ser_deser() {
        let processed_message = ProcessedMessage::new(420420420, H256::random(), 69696969);

        let mut serialized = vec![];
        processed_message.serialize(&mut serialized).unwrap();

        let deserialized = ProcessedMessage::deserialize(&mut serialized.as_slice()).unwrap();

        assert_eq!(processed_message, deserialized);
        assert_eq!(serialized.len(), processed_message.size());
    }
}
