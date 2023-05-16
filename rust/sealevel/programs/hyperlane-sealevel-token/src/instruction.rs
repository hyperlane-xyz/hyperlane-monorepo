//! TODO

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Decode, Encode, HyperlaneError, H256, U256};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    Init(Init),
    InitErc20(InitErc20),
    TransferRemote(TransferRemote),
    // This is "handle" in solidity contract. Used as mailbox recipient.
    TransferFromRemote(TransferFromRemote),
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
    /// The name of the token.
    pub name: String,
    /// The symbol of the token.
    pub symbol: String, // FIXME use datatype to enforce character set
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitErc20 {
    /// The initial supply of the token.
    pub total_supply: U256,
    // TODO use datatype to enforce character set. We don't want to allow "-" because it is used
    // in pda seeds as separator, right? Either that or we should base58 encode or hash the strings.
    /// The name of the token.
    pub name: String,
    /// The symbol of the token.
    pub symbol: String,
}

/// Transfers `amount_or_id` token to `recipient` on `destination` domain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemote {
    pub destination_domain: u32,
    pub destination_program_id: H256,
    pub recipient: H256,
    pub amount_or_id: U256,
}

/// Mints tokens to recipient when router receives transfer message.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferFromRemote {
    pub origin: u32,
    pub message: Vec<u8>,
}

// FIXME move to common lib
#[derive(Debug)]
pub struct TokenMessage {
    recipient: H256,
    // TODO we probably don't need to use "or_id" since this smart contract only handles erc20
    // currently.
    amount_or_id: U256,
    metadata: Vec<u8>,
}

impl Encode for TokenMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(self.recipient.as_ref())?;

        let mut amount_or_id = [0_u8; 32];
        self.amount_or_id.to_big_endian(&mut amount_or_id);
        writer.write_all(&amount_or_id)?;

        writer.write_all(&self.metadata)?;

        Ok(32 + 32 + self.metadata.len())
    }
}

impl Decode for TokenMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneError>
    where
        R: std::io::Read,
    {
        let mut recipient = H256::zero();
        reader.read_exact(recipient.as_mut())?;

        let mut amount_or_id = [0_u8; 32];
        reader.read_exact(&mut amount_or_id)?;
        let amount_or_id = U256::from_big_endian(&amount_or_id);

        let mut metadata = vec![];
        reader.read_to_end(&mut metadata)?;

        Ok(Self {
            recipient,
            amount_or_id: U256::from(amount_or_id),
            metadata,
        })
    }
}

impl TokenMessage {
    pub fn new_erc20(recipient: H256, amount: U256, metadata: Vec<u8>) -> Self {
        Self {
            recipient,
            amount_or_id: amount,
            metadata,
        }
    }

    pub fn new_erc721(recipient: H256, id: U256, metadata: Vec<u8>) -> Self {
        Self {
            recipient,
            amount_or_id: id,
            metadata,
        }
    }

    pub fn recipient(&self) -> H256 {
        self.recipient
    }

    pub fn amount(&self) -> U256 {
        self.amount_or_id
    }

    pub fn token_id(&self) -> U256 {
        self.amount_or_id
    }

    pub fn metadata(&self) -> &[u8] {
        &self.metadata
    }
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
