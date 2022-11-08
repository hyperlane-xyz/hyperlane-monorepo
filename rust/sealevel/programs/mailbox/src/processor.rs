//! Entrypoint, dispatch, and execution for the Hyperlane Sealevel mailbox instruction.

use hyperlane_core::{HyperlaneMessage, Decode, H256};
use solana_program::{
    account_info::next_account_info,
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, set_return_data},
    program_error::{/*PrintProgramError as _,*/ ProgramError},
    pubkey::Pubkey,
};
#[cfg(not(feature = "no-entrypoint"))]
use solana_program::entrypoint;

use crate::{
    accounts::{ConfigAccount, InboxAccount, OutboxAccount},
    error::Error,
    instruction::{
        InboxProcess, InboxSetDefaultModule, Instruction as MailboxIxn, IsmInstruction,
        OutboxDispatch, RecipientInstruction, MAX_MESSAGE_BODY_BYTES, VERSION,
    },
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction (
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let result = match MailboxIxn::from_instruction_data(instruction_data)? {
        MailboxIxn::InboxProcess(process) => {
            inbox_process(program_id, accounts, process).map(|_| ())
        }
        MailboxIxn::InboxSetDefaultModule(ism) => {
            inbox_set_default_ism(program_id, accounts, ism).map(|_| ())
        }
        MailboxIxn::OutboxDispatch(dispatch) => {
            outbox_dispatch(program_id, accounts, dispatch).map(|_| ())
        }
        MailboxIxn::OutboxGetCount => outbox_get_count(program_id, accounts).map(|_| ()),
        MailboxIxn::OutboxGetLatestCheckpoint => {
            outbox_get_latest_checkpoint(program_id, accounts).map(|_| ())
        }
        MailboxIxn::OutboxGetRoot => outbox_get_root(program_id, accounts).map(|_| ()),
    };
    result
        // .map_err(|err| {
        //     err.print::<crate::error::Error>();
        //     err
        // })
}

// FIXME really should add checks on permissions for all accounts that are passed in, e.g., bail if
// we expected an account to be read only but it is writable. Could build this into the AccountData
// struct impl and provide more fetch methods.
fn inbox_process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    process: InboxProcess,
) -> Result<[u8; 32], ProgramError> {
    let accounts_iter = &mut accounts.iter();

    let inbox_account = next_account_info(accounts_iter)?;
    if inbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut inbox = InboxAccount::fetch(&mut &inbox_account.data.borrow_mut()[..])?.into_inner();

    let config_account = next_account_info(accounts_iter)?;
    if config_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let config = ConfigAccount::fetch(&mut &config_account.data.borrow_mut()[..])?.into_inner();

    let message = HyperlaneMessage::read_from(&mut std::io::Cursor::new(process.message))
        .map_err(|_| ProgramError::from(Error::MalformattedHyperlaneMessage))?;
    if message.version != VERSION {
        return Err(ProgramError::from(Error::UnsupportedMessageVersion));
    }
    if message.destination != config.local_domain {
        return Err(ProgramError::from(Error::IncorrectDestinationDomain));
    }

    let id = message.id();
    if inbox.delivered.contains(&id) {
        return Err(ProgramError::from(Error::DuplicateMessage));
    }
    inbox.delivered.insert(id);

    let ism_ixn = IsmInstruction {
        metadata: process.metadata,
        message: message.body.clone(),
    };
    if config.ism != *next_account_info(accounts_iter)?.key {
        return Err(ProgramError::from(Error::AccountOutOfOrder));
    }
    let mut ism_accounts = vec![];
    let mut ism_account_metas = vec![];
    for pubkey in config.ism_accounts {
        let meta = AccountMeta {
            pubkey,
            // FIXME this should probably be provided up front...
            is_signer: false,
            is_writable: false,
        };
        let info = next_account_info(accounts_iter)?;
        if info.key != &pubkey {
            return Err(ProgramError::from(Error::AccountOutOfOrder));
        }
        ism_accounts.push(info.clone());
        ism_account_metas.push(meta);
    }
    let verify = Instruction::new_with_borsh(config.ism, &ism_ixn, ism_account_metas);

    let recp_ixn = RecipientInstruction {
        sender: message.sender,
        origin: message.origin,
        message: message.body,
    };
    let recp_prog_id = Pubkey::new_from_array(message.recipient.0);
    if recp_prog_id != *next_account_info(accounts_iter)?.key {
        return Err(ProgramError::from(Error::AccountOutOfOrder));
    }
    let mut recp_accounts = vec![];
    let mut recp_account_metas = vec![];
    for account in [] { // FIXME recipient accounts must be provided up front
        let pubkey = Pubkey::new_from_array(account);
        let meta = AccountMeta {
            pubkey,
            // FIXME this should probably be provided up front...
            is_signer: false,
            is_writable: false,
        };
        let info = next_account_info(accounts_iter)?;
        if info.key != &pubkey {
            return Err(ProgramError::from(Error::AccountOutOfOrder));
        }
        recp_accounts.push(info.clone());
        recp_account_metas.push(meta);
    }
    let recieve = Instruction::new_with_borsh(
        message.recipient.0.into(),
        &recp_ixn,
        recp_account_metas,
    );

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }
    invoke(&verify, &ism_accounts)?;
    invoke(&recieve, &recp_accounts)?;
    msg!("Hyperlane inbox: {:?}", id);

    InboxAccount::from(inbox).store(inbox_account, true)?;

    Ok(id.0)
}

fn inbox_set_default_ism(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    ism: InboxSetDefaultModule,
) -> Result<(), ProgramError> {
    let accounts_iter = &mut accounts.iter();

    // FIXME need some way to tie the config account to the inbox account so that we don't allow
    // the wrong config to be used. Here and in the other functions.
    let inbox_account = next_account_info(accounts_iter)?;
    if inbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let _inbox = InboxAccount::fetch(&mut &inbox_account.data.borrow_mut()[..])?.into_inner();

    let config_account = next_account_info(accounts_iter)?;
    if config_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut config = ConfigAccount::fetch(&mut &config_account.data.borrow_mut()[..])?.into_inner();

    config.ism = ism.program_id;
    config.ism_accounts = ism.accounts;

    ConfigAccount::from(config).store(config_account, true)?;

    Ok(())
}

fn outbox_dispatch(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    dispatch: OutboxDispatch,
) -> Result<H256, ProgramError> {
    let accounts_iter = &mut accounts.iter();

    let outbox_account = next_account_info(accounts_iter)?;
    if outbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut outbox = OutboxAccount::fetch(&mut &outbox_account.data.borrow_mut()[..])?.into_inner();

    let config_account = next_account_info(accounts_iter)?;
    if config_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let config = ConfigAccount::fetch(&mut &config_account.data.borrow_mut()[..])?.into_inner();

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }
    if dispatch.message_body.len() > MAX_MESSAGE_BODY_BYTES {
        return Err(ProgramError::from(Error::MaxMessageSizeExceeded));
    }

    let count = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");
    let message = HyperlaneMessage {
        version: VERSION,
        nonce: count,
        origin: config.local_domain,
        sender: H256(dispatch.sender.to_bytes()),
        destination: dispatch.destination_domain.into(),
        recipient: dispatch.recipient,
        body: dispatch.message_body,
    };
    let formatted = message
        .format()
        .map_err(|_| ProgramError::from(Error::MalformattedMessage))?;
    // TODO Get this dynamically: https://github.com/solana-labs/solana/issues/23653
    let remaining_log_budget_bytes = 10_000 - 18; // Default minus our log message prefix.
    if formatted.len() > remaining_log_budget_bytes {
        return Err(ProgramError::from(Error::LogBudgetExceeded));
    }

    let id = message.id();
    outbox.tree.ingest(id);
    msg!("Hyperlane outbox: {}", &formatted);

    OutboxAccount::from(outbox).store(outbox_account, true)?;

    set_return_data(id.as_ref());
    Ok(id)
}

fn outbox_get_count(program_id: &Pubkey, accounts: &[AccountInfo]) -> Result<u32, ProgramError> {
    let accounts_iter = &mut accounts.iter();
    let outbox_account = next_account_info(accounts_iter)?;
    if outbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }
    let outbox = OutboxAccount::fetch(&mut &outbox_account.data.borrow_mut()[..])?.into_inner();
    let count: u32 = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");
    set_return_data(&count.to_le_bytes());
    Ok(count)
}

fn outbox_get_latest_checkpoint(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> Result<(H256, u32), ProgramError> {
    let accounts_iter = &mut accounts.iter();
    let outbox_account = next_account_info(accounts_iter)?;
    if outbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }
    let outbox = OutboxAccount::fetch(&mut &outbox_account.data.borrow_mut()[..])?.into_inner();

    let root = outbox.tree.root();
    let count: u32 = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");

    let mut ret_buf = [0; 36];
    ret_buf[0..31].copy_from_slice(root.as_ref());
    ret_buf[32..].copy_from_slice(&count.to_le_bytes());
    set_return_data(&ret_buf);

    Ok((root, count))
}

fn outbox_get_root(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> Result<H256, ProgramError> {
    let accounts_iter = &mut accounts.iter();
    let outbox_account = next_account_info(accounts_iter)?;
    if outbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }
    let outbox = OutboxAccount::fetch(&mut &outbox_account.data.borrow_mut()[..])?.into_inner();

    let root = outbox.tree.root();
    set_return_data(root.as_ref());
    Ok(root)
}

#[cfg(test)]
mod test {
    use super::*;

    use std::str::FromStr as _;

    use hyperlane_core::{accumulator::incremental::IncrementalMerkle as MerkleTree, Encode};
    use itertools::Itertools as _;
    use solana_program::clock::Epoch;

    use crate::accounts::CONFIG_ACCOUNT_SIZE;

    struct SyscallStubs {}
    impl solana_program::program_stubs::SyscallStubs for SyscallStubs {
        fn sol_log(&self, message: &str) {
            log::info!("{}", message);
        }
        fn sol_log_data(&self, fields: &[&[u8]]) {
            log::info!("data: {}", fields.iter().map(base64::encode).join(" "));
        }
    }

    struct ExampleMetadata { // Depends on which ISM is used.
        pub root: H256,
        pub index: u32,
        pub leaf_index: u32,
        // pub proof: [H256; 32],
        pub signatures: Vec<H256>,
    }
    impl Encode for ExampleMetadata {
        fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
        where
            W: std::io::Write,
        {
            writer.write_all(&self.root.as_ref())?;
            writer.write_all(&self.index.to_be_bytes())?;
            writer.write_all(&self.leaf_index.to_be_bytes())?;
            // for hash in self.proof {
            //     writer.write_all(hash.as_ref())?;
            // }
            for signature in &self.signatures {
                writer.write_all(signature.as_ref())?;
            }
            Ok(32 + 4 + 4 + (32 * 32) + (self.signatures.len() * 32))
        }
    }

    fn setup_logging() {
        solana_program::program_stubs::set_syscall_stubs(Box::new(SyscallStubs {}));
        testing_logger::setup();
    }

    #[test]
    fn test_inbox_process() {
        setup_logging();

        let mailbox_program_id = Pubkey::new_unique();

        let inbox_account_key = Pubkey::new_unique();
        let mut inbox_account_lamports = 0;
        let mut inbox_account_data = vec![0_u8; 2048];
        let inbox_account = AccountInfo::new(
            // Public key of the account
            &inbox_account_key,
            false,
            // Is the account writable?
            true,
            // The lamports in the account. Modifiable by programs.
            &mut inbox_account_lamports,
            // The data held in this account. Modifiable by programs.
            &mut inbox_account_data,
            // Program that owns this account.
            &mailbox_program_id,
            // This account's data contains a loaded program (and is now read-only).
            false,
            // The epoch at which this account will next owe rent.
            Epoch::default(),
        );

        let config_account_key = Pubkey::new_unique();
        let mut config_account_lamports = 0;
        let mut config_account_data = vec![0_u8; CONFIG_ACCOUNT_SIZE];
        let config_account = AccountInfo::new(
            &config_account_key,
            false,
            true,
            &mut config_account_lamports,
            &mut config_account_data,
            &mailbox_program_id,
            false,
            Epoch::default(),
        );

        let ism_account_key = Pubkey::from_str(crate::DEFAULT_ISM).unwrap();
        let mut ism_account_lamports = 0;
        let mut ism_account_data = vec![0_u8; 1024];
        let ism_account = AccountInfo::new(
            &ism_account_key,
            false,
            false,
            &mut ism_account_lamports,
            &mut ism_account_data,
            &mailbox_program_id,
            true,
            Epoch::default(),
        );
        // Must add to account vec further down if/when there are ism data accounts.
        assert!(crate::DEFAULT_ISM_ACCOUNTS.is_empty());

        let recp_account_key = Pubkey::new_from_array([42; 32]);
        let mut recp_account_lamports = 0;
        let mut recp_account_data = vec![0_u8; 1024];
        let recp_account = AccountInfo::new(
            &recp_account_key,
            false,
            false,
            &mut recp_account_lamports,
            &mut recp_account_data,
            &mailbox_program_id,
            true,
            Epoch::default(),
        );
        // Assume no recpient data accounts for now.

        let message = HyperlaneMessage {
            version: VERSION,
            nonce: 1,
            origin: u32::MAX,
            sender: H256::repeat_byte(69),
            destination: u32::MAX,
            recipient: H256::from(recp_account_key.to_bytes()),
            body: "Hello, World!".bytes().collect(),
        };
        let mut encoded_message = vec![];
        message.write_to(&mut encoded_message).unwrap();
        let metadata = ExampleMetadata {
            root: Default::default(),
            index: 1,
            signatures: vec![],
            // proof: Default::default(),
            leaf_index: message.nonce,
        };
        let mut encoded_metadata = vec![];
        metadata.write_to(&mut encoded_metadata).unwrap();

        let accounts = [inbox_account, config_account, ism_account, recp_account];
        let inbox_process = InboxProcess {
            metadata: encoded_metadata,
            message: encoded_message,
        };
        let instruction_data = MailboxIxn::InboxProcess(inbox_process)
            .into_instruction_data()
            .unwrap();

        let inbox = InboxAccount::fetch(&mut &accounts[0].data.borrow_mut()[..])
            .unwrap()
            .into_inner();
        assert_eq!(inbox.delivered.len(), 0);

        process_instruction(&mailbox_program_id, &accounts, &instruction_data).unwrap();
        testing_logger::validate(|logs| {
            assert_eq!(logs.len(), 3);
            assert_eq!(logs[0].level, log::Level::Info);
            assert_eq!(logs[0].body, "SyscallStubs: sol_invoke_signed() not available");
            assert_eq!(logs[1].level, log::Level::Info);
            assert_eq!(logs[1].body, "SyscallStubs: sol_invoke_signed() not available");
            assert_eq!(logs[2].level, log::Level::Info);
            assert_eq!(
                logs[2].body,
                "Hyperlane inbox: 0x4cd9e947a4cd81f0c32bc2c167648185ff0c389e8a881cdd362707c956f31103"
            );
        });
        let inbox = InboxAccount::fetch(&mut &accounts[0].data.borrow_mut()[..])
            .unwrap()
            .into_inner();
        assert_eq!(inbox.delivered.len(), 1);
        assert!(inbox.delivered.contains(
            &H256::from_str("0x4cd9e947a4cd81f0c32bc2c167648185ff0c389e8a881cdd362707c956f31103")
                .unwrap()
        ));
    }

    #[test]
    fn test_inbox_set_default_module() {
        unimplemented!()
    }

    #[test]
    fn test_outbox_dispatch() {
        setup_logging();

        let mailbox_program_id = Pubkey::new_unique();

        let outbox_account_key = Pubkey::new_unique();
        let mut outbox_account_lamports = 0;
        let mut outbox_account_data = vec![0_u8; 2048];
        let outbox_account = AccountInfo::new(
            &outbox_account_key,
            false,
            true,
            &mut outbox_account_lamports,
            &mut outbox_account_data,
            &mailbox_program_id,
            false,
            Epoch::default(),
        );

        let config_account_key = Pubkey::new_unique();
        let mut config_account_lamports = 0;
        let mut config_account_data = vec![0_u8; CONFIG_ACCOUNT_SIZE];
        let config_account = AccountInfo::new(
            &config_account_key,
            false,
            true,
            &mut config_account_lamports,
            &mut config_account_data,
            &mailbox_program_id,
            false,
            Epoch::default(),
        );

        let message = OutboxDispatch {
            sender: Pubkey::new_from_array([6; 32]),
            destination_domain: u32::MAX,
            recipient: H256([9; 32]),
            message_body: "Hello, World!".bytes().collect(),
        };
        let instruction_data = MailboxIxn::OutboxDispatch(message)
            .into_instruction_data()
            .unwrap();

        let accounts = vec![outbox_account, config_account];
        let outbox = OutboxAccount::fetch(&mut &accounts[0].data.borrow_mut()[..])
            .unwrap()
            .into_inner();
        assert_eq!(outbox.tree.count(), 0);
        assert_eq!(outbox.tree.root(), MerkleTree::default().root());

        process_instruction(&mailbox_program_id, &accounts, &instruction_data).unwrap();
        testing_logger::validate(|logs| {
            assert_eq!(logs.len(), 1);
            assert_eq!(logs[0].level, log::Level::Info);
            assert_eq!(
                logs[0].body,
                "Hyperlane outbox: KBTLbtJtuLbxrn6hwiZ2SfQbdTYBxs8uAaHzTudgjtMZV4f9cHyEjvbPV3sXn9ftPHZJCzNy9pJZ9SLJmarEgq1wZV9Dsm4PcDyqGCCdryDCvKQTDKhyUfgtRn"
            );
        });
        let outbox = OutboxAccount::fetch(&mut &accounts[0].data.borrow_mut()[..])
            .unwrap()
            .into_inner();
        assert_eq!(outbox.tree.count(), 1);
        assert_eq!(
            outbox.tree.root(),
            H256::from_str("0x6589cdd914158e71aa9beb14d1a42298918f2b3321f9f3bcd7aef06ede255145")
                .unwrap()
        );
    }

    #[test]
    fn test_outbox_get_count() {
        unimplemented!()
    }

    #[test]
    fn test_outbox_get_latest_checkpoint() {
        unimplemented!()
    }

    #[test]
    fn test_outbox_get_root() {
        unimplemented!()
    }
}
