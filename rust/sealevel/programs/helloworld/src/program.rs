//! HelloWorld program.
use std::collections::HashMap;

use access_control::AccessControl;
use account_utils::{create_pda_account, AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
// use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_connection_client::router::{
    HyperlaneRouter, HyperlaneRouterAccessControl, RemoteRouterConfig,
};
use hyperlane_sealevel_mailbox::{
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_program,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// The amount of gas to pay for.
/// TODO: when we actually enforce gas amounts for messages to Solana,
/// we'll need to revisit this and change HelloWorld to use GasRouter.
pub const HANDLE_GAS_AMOUNT: u64 = 50000;

/// The storage account.
pub type HelloWorldStorageAccount = AccountData<HelloWorldStorage>;

/// The storage account's data.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct HelloWorldStorage {
    /// The local domain.
    pub local_domain: u32,
    /// The mailbox.
    pub mailbox: Pubkey,
    /// The ISM.
    pub ism: Option<Pubkey>,
    /// The IGP.
    // pub igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    /// The owner.
    pub owner: Option<Pubkey>,
    /// A counter of how many messages have been sent from this contract.
    pub sent: u64,
    /// A counter of how many messages have been received by this contract.
    pub received: u64,
    /// Keyed by domain, a counter of how many messages that have been sent
    /// from this contract to the domain.
    pub sent_to: HashMap<u32, u64>,
    /// Keyed by domain, a counter of how many messages that have been received
    /// by this contract from the domain.
    pub received_from: HashMap<u32, u64>,
    /// Keyed by domain, the router for the remote domain.
    pub routers: HashMap<u32, H256>,
}

impl SizedData for HelloWorldStorage {
    fn size(&self) -> usize {
        // local domain
        std::mem::size_of::<u32>() +
        // mailbox
        32 +
        // ism
        1 + 32 +
        // igp
        1 + 32 + 1 + 32 +
        // owner
        1 + 32 +
        // sent
        std::mem::size_of::<u64>() +
        // received
        std::mem::size_of::<u64>() +
        // sent_to
        (self.sent_to.len() * (std::mem::size_of::<u32>() + std::mem::size_of::<u64>())) +
        // received_from
        (self.received_from.len() * (std::mem::size_of::<u32>() + std::mem::size_of::<u64>())) +
        // routers
        (self.routers.len() * (std::mem::size_of::<u32>() + 32))
    }
}

impl AccessControl for HelloWorldStorage {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

impl HyperlaneRouter for HelloWorldStorage {
    fn router(&self, origin: u32) -> Option<&H256> {
        self.routers.get(&origin)
    }

    fn enroll_remote_router(&mut self, config: RemoteRouterConfig) {
        self.routers.insert(config.domain, config.router.unwrap());
    }
}

/// Seeds relating to the PDA account with program data.
#[macro_export]
macro_rules! program_storage_pda_seeds {
    () => {{
        &[b"hello_world", b"-", b"handle", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hello_world",
            b"-",
            b"handle",
            b"-",
            b"storage",
            &[$bump_seed],
        ]
    }};
}

/// Init instruction data.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Init {
    /// The local domain.
    pub local_domain: u32,
    /// The mailbox.
    pub mailbox: Pubkey,
    /// The ISM.
    pub ism: Option<Pubkey>,
    /// The IGP.
    // pub igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    /// The owner.
    pub owner: Option<Pubkey>,
}

/// A HelloWorld message.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct HelloWorldMessage {
    /// The destination domain.
    pub destination: u32,
    /// The message.
    pub message: String,
}

/// Instructions for the program.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum HelloWorldInstruction {
    /// Initializes the program.
    Init(Init),
    /// Dispatches a message using the dispatch authority.
    SendHelloWorld(HelloWorldMessage),
    /// Sets the ISM.
    SetInterchainSecurityModule(Option<Pubkey>),
    /// Enrolls remote routers
    EnrollRemoteRouters(Vec<RemoteRouterConfig>),
}

/// The program's entrypoint.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(recipient_instruction) = MessageRecipientInstruction::decode(instruction_data) {
        return match recipient_instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                get_interchain_security_module(program_id, accounts)
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                set_account_meta_return_data(program_id)
            }
            MessageRecipientInstruction::Handle(instruction) => {
                handle(program_id, accounts, instruction)
            }
            MessageRecipientInstruction::HandleAccountMetas(_) => {
                set_account_meta_return_data(program_id)
            }
        };
    }

    let instruction = HelloWorldInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    match instruction {
        HelloWorldInstruction::Init(mailbox) => init(program_id, accounts, mailbox),
        HelloWorldInstruction::SendHelloWorld(hello_world) => {
            send_hello_world(program_id, accounts, hello_world)
        }
        HelloWorldInstruction::SetInterchainSecurityModule(ism) => {
            set_interchain_security_module(program_id, accounts, ism)
        }
        HelloWorldInstruction::EnrollRemoteRouters(configs) => {
            enroll_remote_routers(program_id, accounts, configs)
        }
    }
}

/// Creates the storage PDA.
///
/// Accounts:
/// 0. [executable] System program.
/// 1. [signer] Payer.
/// 2. [writeable] Storage PDA.
fn init(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Payer.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_pda_bump_seed) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }

    let storage_account = HelloWorldStorageAccount::from(HelloWorldStorage {
        local_domain: init.local_domain,
        mailbox: init.mailbox,
        ism: init.ism,
        // igp: init.igp,
        owner: init.owner,
        ..Default::default()
    });
    create_pda_account(
        payer_info,
        &Rent::get()?,
        storage_account.size(),
        program_id,
        system_program_info,
        storage_info,
        program_storage_pda_seeds!(storage_pda_bump_seed),
    )?;
    // Store it
    storage_account.store(storage_info, false)?;

    Ok(())
}

/// Dispatches a message using the dispatch authority.
///
/// Accounts:
/// 0. [executable] The Mailbox program.
/// And now the accounts expected by the Mailbox's OutboxDispatch instruction:
/// 2. [writeable] Outbox PDA.
/// 3. [] This program's dispatch authority.
/// 4. [executable] System program.
/// 5. [executable] SPL Noop program.
/// 6. [signer] Payer.
/// 7. [signer] Unique message account.
/// 8. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
///    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
fn send_hello_world(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    hello_world: HelloWorldMessage,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Mailbox program.
    let mailbox_info = next_account_info(accounts_iter)?;

    // Account 1: Outbox PDA.
    let mailbox_outbox_info = next_account_info(accounts_iter)?;

    // Account 2: Dispatch authority.
    let dispatch_authority_info = next_account_info(accounts_iter)?;
    let (expected_dispatch_authority_key, expected_dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if dispatch_authority_info.key != &expected_dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 3: System program.
    let system_program_info = next_account_info(accounts_iter)?;

    // Account 4: SPL Noop program.
    let spl_noop_info = next_account_info(accounts_iter)?;

    // Account 5: Payer.
    let payer_info = next_account_info(accounts_iter)?;

    // Account 6: Unique message account.
    let unique_message_account_info = next_account_info(accounts_iter)?;

    // Account 7: Dispatched message PDA.
    let dispatched_message_info = next_account_info(accounts_iter)?;

    let dispatch = OutboxDispatch {
        sender: *program_id,
        // The destination domain of the message.
        destination_domain: hello_world.destination,
        // The remote recipient of the message.
        recipient: H256::zero(),
        // The message body.
        message_body: hello_world.message.into(),
    };

    // Dispatch
    let instruction = Instruction {
        program_id: *mailbox_info.key,
        data: MailboxInstruction::OutboxDispatch(dispatch).into_instruction_data()?,
        accounts: vec![
            AccountMeta::new(*mailbox_outbox_info.key, false),
            AccountMeta::new_readonly(*dispatch_authority_info.key, true),
            AccountMeta::new_readonly(*system_program_info.key, false),
            AccountMeta::new_readonly(*spl_noop_info.key, false),
            AccountMeta::new(*payer_info.key, true),
            AccountMeta::new_readonly(*unique_message_account_info.key, true),
            AccountMeta::new(*dispatched_message_info.key, false),
        ],
    };
    invoke_signed(
        &instruction,
        &[
            mailbox_outbox_info.clone(),
            dispatch_authority_info.clone(),
            system_program_info.clone(),
            spl_noop_info.clone(),
            payer_info.clone(),
            unique_message_account_info.clone(),
            dispatched_message_info.clone(),
        ],
        &[mailbox_message_dispatch_authority_pda_seeds!(
            expected_dispatch_authority_bump
        )],
    )
}

/// Handles a message.
///
/// Accounts:
/// 0. [writeable] Process authority specific to this program.
/// 1. [] Storage PDA account.
pub fn handle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Process authority specific to this program.
    let process_authority = next_account_info(accounts_iter)?;

    // Account 1: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let mut storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Verify the process authority
    let (expected_process_authority_key, _expected_process_authority_bump) =
        Pubkey::find_program_address(
            mailbox_process_authority_pda_seeds!(program_id),
            &storage.mailbox,
        );
    if process_authority.key != &expected_process_authority_key {
        return Err(ProgramError::InvalidArgument);
    }
    if !process_authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Increment counters
    storage.received += 1;
    storage
        .received_from
        .entry(handle.origin)
        .and_modify(|c| *c += 1)
        .or_insert(1);

    let local_domain = storage.local_domain;

    // Store it.
    // We don't expect the size of the storage account to change because this is accounted for
    // when a remote router is enrolled.
    HelloWorldStorageAccount::from(storage).store(storage_info, false)?;

    msg!(
        "Received hello world: origin {}, local domain {}, sender {}, message {}",
        handle.origin,
        local_domain,
        handle.sender,
        std::str::from_utf8(&handle.message).unwrap()
    );

    Ok(())
}

/// Accounts:
/// 0. [writeable] Storage PDA account.
/// 1. [signer] Owner.
fn set_interchain_security_module(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    ism: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    // Not bothering with validity checks because this is a test program
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let mut storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 1: Owner.
    let owner_info = next_account_info(accounts_iter)?;
    storage.ensure_owner_signer(owner_info)?;

    storage.ism = ism;

    // Store it
    HelloWorldStorageAccount::from(storage).store(storage_info, false)?;

    Ok(())
}

/// Accounts:
/// 0. [] Storage PDA account.
fn get_interchain_security_module(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    set_return_data(
        &storage
            .ism
            .try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
    );

    Ok(())
}

fn set_account_meta_return_data(program_id: &Pubkey) -> ProgramResult {
    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);

    let account_metas: Vec<SerializableAccountMeta> =
        vec![AccountMeta::new_readonly(storage_pda_key, false).into()];

    // Wrap it in the SimulationReturnData because serialized account_metas
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(account_metas)
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);

    Ok(())
}

/// Enrolls remote routers.
///
/// Accounts:
/// 0. [executable] System program.
/// 1. [writeable] Storage PDA account.
/// 2. [signer] Owner.
fn enroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<RemoteRouterConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let mut storage =
        HelloWorldStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 2: Owner.
    let owner_info = next_account_info(accounts_iter)?;
    storage.ensure_owner_signer(owner_info)?;

    for config in &configs {
        // If the sent_to or received_from map doesn't have an entry for this domain yet,
        // init it to 0. This is important so that we realloc here if necessary.
        storage.sent_to.entry(config.domain).or_insert(0);
        storage.received_from.entry(config.domain).or_insert(0);
    }

    storage.enroll_remote_routers_only_owner(owner_info, configs)?;

    // Store it, & realloc if needed
    HelloWorldStorageAccount::from(storage).store_with_rent_exempt_realloc(
        storage_info,
        &Rent::get()?,
        &owner_info,
        system_program_info,
    )?;

    Ok(())
}

// --- instruction stuff ---

/// Gets an instruction to initialize the program.
pub fn init_instruction(
    program_id: Pubkey,
    payer: Pubkey,
    local_domain: u32,
    mailbox: Pubkey,
    ism: Option<Pubkey>,
    // igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    owner: Option<Pubkey>,
) -> Result<Instruction, ProgramError> {
    let (program_storage_account, _program_storage_bump) =
        Pubkey::try_find_program_address(program_storage_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let init = Init {
        local_domain,
        mailbox,
        ism,
        // igp,
        owner,
    };

    // Accounts:
    // 0. [executable] System program.
    // 1. [signer] Payer.
    // 2. [writeable] Storage PDA.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(program_storage_account, false),
    ];

    let instruction = Instruction {
        program_id,
        data: HelloWorldInstruction::Init(init).try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}

/// Gets an instruction to enroll remote routers.
pub fn enroll_remote_routers_instruction(
    program_id: Pubkey,
    owner: Pubkey,
    configs: Vec<RemoteRouterConfig>,
) -> Result<Instruction, ProgramError> {
    let (program_storage_account, _program_storage_bump) =
        Pubkey::try_find_program_address(program_storage_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    // Accounts:
    // 0. [executable] System program.
    // 1. [signer] Payer.
    // 2. [writeable] Storage PDA.
    let accounts = vec![
        AccountMeta::new_readonly(solana_program::system_program::id(), false),
        AccountMeta::new(program_storage_account, false),
        AccountMeta::new(owner, true),
    ];

    let instruction = Instruction {
        program_id,
        data: HelloWorldInstruction::EnrollRemoteRouters(configs).try_to_vec()?,
        accounts,
    };

    Ok(instruction)
}
