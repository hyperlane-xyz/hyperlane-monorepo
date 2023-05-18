//! TODO

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H256, U256};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    Init(Init),
    TransferRemote(TransferRemote),
}

impl Instruction {
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        self.try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))
    }
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct Init {
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The mailbox's local domain.
    pub mailbox_local_domain: u32,
}

/// Transfers `amount_or_id` token to `recipient` on `destination` domain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemote {
    pub destination_domain: u32,
    /// TODO imply this from Router
    pub destination_program_id: H256,
    pub recipient: H256,
    pub amount_or_id: U256,
}

/// Mints tokens to recipient when router receives transfer message.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferFromRemote {
    pub origin: u32,
    pub sender: H256,
    pub message: Vec<u8>,
}

// FIXME we should include the asset (name, symbol) that was transferred in this event...
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct EventSentTransferRemote {
    pub destination: u32,
    pub recipient: H256,
    pub amount: U256,
}

impl EventLabel for EventSentTransferRemote {
    fn event_label() -> &'static str {
        // TODO is there a way to add this to a static map at compile time to ensure no
        // duplicates within a program? probaby with a proc macro? Maybe it doesn't matter.
        "EventSentTransferRemote"
    }
}

// FIXME we should include the asset (name, symbol) that was transferred in this event...
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct EventReceivedTransferRemote {
    pub origin: u32,
    pub recipient: H256,
    pub amount: U256, // FIXME where to do the U256-->u64 conversion? contracts or agents?
}

// TODO a macro_rules! or derive(Event) proc macro could generate this
impl EventLabel for EventReceivedTransferRemote {
    fn event_label() -> &'static str {
        "EventReceivedTransferRemote"
    }
}

// FIXME move this to a common lib
#[derive(Debug)]
pub struct EventError;
pub trait EventLabel {
    fn event_label() -> &'static str;
}
pub struct Event<D> {
    data: D,
}
impl<D> Event<D>
where
    D: BorshDeserialize + BorshSerialize + EventLabel + std::fmt::Debug,
{
    pub fn new(data: D) -> Self {
        Self { data }
    }
    pub fn into_inner(self) -> D {
        self.data
    }
    // TODO is the header really necessary here? The version may be useful for future proofing if
    // we ever need to change the event structure, e.g., in the case where we support events that
    // exceed one noop CPIs instruction data size.
    pub fn to_noop_cpi_ixn_data(&self) -> Result<Vec<u8>, EventError> {
        let version = 0;
        let label = <D as EventLabel>::event_label();
        let label_len: u8 = label.len().try_into().map_err(|_err| EventError)?;
        let mut ixn_data = vec![version, label_len];
        ixn_data.extend(label.as_bytes());
        self.data
            .serialize(&mut ixn_data)
            .map_err(|_err| EventError)?;
        Ok(ixn_data)
    }
    pub fn to_noop_cpi_ixn_data_base58_encoded(&self) -> Result<String, EventError> {
        let ixn_data = self.to_noop_cpi_ixn_data()?;
        let encoded = bs58::encode(&ixn_data).into_string();
        Ok(encoded)
    }
    pub fn from_noop_cpi_ixn_data(data: &[u8]) -> Result<Self, EventError> {
        let mut data_iter = data.iter();
        let version = data_iter.next().ok_or_else(|| EventError)?;
        let header_len = match version {
            0 => {
                let label_len = usize::from(*data_iter.next().ok_or_else(|| EventError)?);
                let expected_label = <D as EventLabel>::event_label();
                if label_len != expected_label.len() {
                    return Err(EventError);
                }
                let label_start: usize = 2;
                let label_end = label_start + label_len;
                let label = std::str::from_utf8(&data[label_start..label_end])
                    .map_err(|_err| EventError)?;
                if label != expected_label {
                    return Err(EventError);
                }
                label_end
            }
            _ => return Err(EventError),
        };
        let data = D::deserialize(&mut &data[header_len..]).map_err(|_err| EventError)?;
        Ok(Self::new(data))
    }
    pub fn from_noop_cpi_ixn_data_base58_encoded(data: &str) -> Result<Self, EventError> {
        let ixn_data = bs58::decode(data).into_vec().map_err(|_err| EventError)?;
        Self::from_noop_cpi_ixn_data(&ixn_data)
    }
}
