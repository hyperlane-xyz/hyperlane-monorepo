//! TODO

use account_utils::{DiscriminatorData, DiscriminatorEncode, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H256, U256};
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use hyperlane_sealevel_mailbox::mailbox_message_dispatch_authority_pda_seeds;

use crate::hyperlane_token_pda_seeds;

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initialize the program.
    Init(Init),
    /// Transfer tokens to a remote recipient.
    TransferRemote(TransferRemote),
    /// Enroll a remote router. Only owner.
    EnrollRemoteRouter(RemoteRouterConfig),
    /// Enroll multiple remote routers. Only owner.
    EnrollRemoteRouters(Vec<RemoteRouterConfig>),
    /// Set the interchain security module. Only owner.
    SetInterchainSecurityModule(Option<Pubkey>),
    /// Transfer ownership of the program. Only owner.
    TransferOwnership(Option<Pubkey>),
}

impl DiscriminatorData for Instruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct Init {
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The interchain security module.
    pub interchain_security_module: Option<Pubkey>,
    /// The local decimals.
    pub decimals: u8,
    /// The remote decimals.
    pub remote_decimals: u8,
}

/// Transfers `amount_or_id` token to `recipient` on `destination` domain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemote {
    pub destination_domain: u32,
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
        let version = data_iter.next().ok_or(EventError)?;
        let header_len = match version {
            0 => {
                let label_len = usize::from(*data_iter.next().ok_or(EventError)?);
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

/// Gets an instruction to initialize the program. This provides only the
/// account metas required by the library, and consuming programs are expected
/// to add the accounts for their own use.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    init: Init,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let (dispatch_authority_key, _dispatch_authority_bump) = Pubkey::try_find_program_address(
        mailbox_message_dispatch_authority_pda_seeds!(),
        &program_id,
    )
    .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::Init(init);

    // Accounts:
    // 0.   [executable] The system program.
    // 1.   [writable] The token PDA account.
    // 2.   [writable] The dispatch authority PDA account.
    // 3.   [signer] The payer and access control owner.
    // 4..N [??..??] Plugin-specific accounts.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new(token_key, false),
        AccountMeta::new(dispatch_authority_key, false),
        AccountMeta::new(payer, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}

/// Enrolls remote routers.
pub fn enroll_remote_routers_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    configs: Vec<RemoteRouterConfig>,
) -> Result<SolanaInstruction, ProgramError> {
    let (token_key, _token_bump) =
        Pubkey::try_find_program_address(hyperlane_token_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let ixn = Instruction::EnrollRemoteRouters(configs);

    // Accounts:
    // 0. [writeable] The token PDA account.
    // 1. [signer] The owner.
    let accounts = vec![
        AccountMeta::new(token_key, false),
        AccountMeta::new(owner_payer, true),
    ];

    let instruction = SolanaInstruction {
        program_id,
        data: ixn.encode()?,
        accounts,
    };

    Ok(instruction)
}
