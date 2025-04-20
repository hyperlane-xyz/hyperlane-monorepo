use account_utils::DiscriminatorDecode;
use borsh::{BorshDeserialize, BorshSerialize};
use clap::{Args, Subcommand};
use hyperlane_sealevel_mailbox::instruction::Instruction as MailboxInstruction;
use hyperlane_sealevel_multisig_ism_message_id::instruction::Instruction as MultisigIsmInstruction;
use solana_program::pubkey;
use solana_sdk::{account::Account, pubkey::Pubkey};

use crate::Context;

#[derive(Args)]
pub(crate) struct SquadsCmd {
    #[command(subcommand)]
    cmd: SquadsSubCmd,
}

#[derive(Subcommand)]
pub(crate) enum SquadsSubCmd {
    Verify(SquadsVerifyCmd),
}

#[derive(Args)]
pub(crate) struct SquadsVerifyCmd {
    /// The path to the squads file to verify
    #[arg(long, short)]
    tx_pubkeys: Vec<Pubkey>,
}

pub fn process_squads_cmd(ctx: Context, cmd: SquadsCmd) {
    match cmd.cmd {
        SquadsSubCmd::Verify(verify) => {
            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&verify.tx_pubkeys, ctx.commitment)
                .unwrap()
                .value;

            for (i, account) in accounts.iter().enumerate() {
                println!(
                    "\n\n\n=======\n=======\n=======\nTx pubkey: {:?} ({} of {})",
                    verify.tx_pubkeys[i],
                    i + 1,
                    verify.tx_pubkeys.len()
                );
                if let Some(account) = account {
                    parse_tx_account(account.clone());
                } else {
                    println!("Account not found");
                }
            }
        }
    }
}

fn parse_tx_account(account: Account) {
    let mut data = account.data.as_slice();
    let discriminator = &data[..8];
    if discriminator != VAULT_TRANSACTION_DISCRIMINATOR {
        panic!("Invalid discriminator");
    }
    data = &data[8..];

    let vault_transaction: VaultTransaction = VaultTransaction::try_from_slice(&mut data).unwrap();

    println!("Raw vault transaction: {:?}", vault_transaction);

    println!("-------\nInstructions:");

    let instruction_count = vault_transaction.message.instructions.len();

    for (i, instruction) in vault_transaction.message.instructions.iter().enumerate() {
        println!("------");
        println!("Instruction {} of {}", i + 1, instruction_count);
        let Some(program_id) = vault_transaction
            .message
            .account_keys
            .get(instruction.program_id_index as usize)
        else {
            println!("\tA system program instruction that is ignored by the vault but our tooling sets anyways (e.g. setting compute units, or compute unit price). Just ignore it.");
            continue;
        };
        println!("\tProgram ID: {:?}", program_id);

        // Try to parse as a MailboxInstruction
        match MailboxInstruction::try_from_slice(&instruction.data) {
            Ok(instruction) => {
                println!("\tMailbox instruction: {:?}", instruction);
                continue;
            }
            Err(_) => {}
        }

        // Else, try to parse as a MultisigIsmInstruction
        match MultisigIsmInstruction::decode(&instruction.data) {
            Ok(instruction) => {
                println!("\tMultisig ISM instruction: {:?}", instruction);
                continue;
            }
            Err(_) => {}
        }

        if *program_id == pubkey!("BPFLoaderUpgradeab1e11111111111111111111111") {
            println!("\tBPFLoaderUpgradeab1e11111111111111111111111 instruction");
            // Setting the upgrade authority, found here https://explorer.eclipse.xyz/tx/3RQ9V2HSbg4aZwr3LTMMwzrEBHa18KHMVwngXsHF2t5YZJ1Hb4MiBd7hovdPanLJT7Lmy2uuide55WmQvXDPjGx5
            if instruction.data == &[4, 0, 0, 0] {
                println!("\tSetting the upgrade authority:");
                let target_program = vault_transaction
                    .message
                    .account_keys
                    .get(instruction.account_indexes[0] as usize)
                    .unwrap();
                println!("\t\tTarget program: {:?}", target_program);
                let old_upgrade_authority = vault_transaction
                    .message
                    .account_keys
                    .get(instruction.account_indexes[1] as usize)
                    .unwrap();
                println!("\t\tOld upgrade authority: {:?}", old_upgrade_authority);
                let new_upgrade_authority = vault_transaction
                    .message
                    .account_keys
                    .get(instruction.account_indexes[2] as usize)
                    .unwrap();
                println!("\t\tNew upgrade authority: {:?}", new_upgrade_authority);
            }
            continue;
        }

        println!("\t⚠️⚠️⚠️⚠️⚠️ Unknown instruction!");
    }
}

const VAULT_TRANSACTION_DISCRIMINATOR: &[u8] = &[168, 250, 162, 100, 81, 14, 162, 207];

/// Stores data required for tracking the voting and execution status of a vault transaction.
/// Vault transaction is a transaction that's executed on behalf of the multisig vault PDA
/// and wraps arbitrary Solana instructions, typically calling into other Solana programs.
// #[account]
#[derive(Default, BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct VaultTransaction {
    /// The multisig this belongs to.
    pub multisig: Pubkey,
    /// Member of the Multisig who submitted the transaction.
    pub creator: Pubkey,
    /// Index of this transaction within the multisig.
    pub index: u64,
    /// bump for the transaction seeds.
    pub bump: u8,
    /// Index of the vault this transaction belongs to.
    pub vault_index: u8,
    /// Derivation bump of the vault PDA this transaction belongs to.
    pub vault_bump: u8,
    /// Derivation bumps for additional signers.
    /// Some transactions require multiple signers. Often these additional signers are "ephemeral" keypairs
    /// that are generated on the client with a sole purpose of signing the transaction and be discarded immediately after.
    /// When wrapping such transactions into multisig ones, we replace these "ephemeral" signing keypairs
    /// with PDAs derived from the MultisigTransaction's `transaction_index` and controlled by the Multisig Program;
    /// during execution the program includes the seeds of these PDAs into the `invoke_signed` calls,
    /// thus "signing" on behalf of these PDAs.
    pub ephemeral_signer_bumps: Vec<u8>,
    /// data required for executing the transaction.
    pub message: VaultTransactionMessage,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Default, Debug)]
pub struct VaultTransactionMessage {
    /// The number of signer pubkeys in the account_keys vec.
    pub num_signers: u8,
    /// The number of writable signer pubkeys in the account_keys vec.
    pub num_writable_signers: u8,
    /// The number of writable non-signer pubkeys in the account_keys vec.
    pub num_writable_non_signers: u8,
    /// Unique account pubkeys (including program IDs) required for execution of the tx.
    /// The signer pubkeys appear at the beginning of the vec, with writable pubkeys first, and read-only pubkeys following.
    /// The non-signer pubkeys follow with writable pubkeys first and read-only ones following.
    /// Program IDs are also stored at the end of the vec along with other non-signer non-writable pubkeys:
    ///
    /// ```plaintext
    /// [pubkey1, pubkey2, pubkey3, pubkey4, pubkey5, pubkey6, pubkey7, pubkey8]
    ///  |---writable---|  |---readonly---|  |---writable---|  |---readonly---|
    ///  |------------signers-------------|  |----------non-singers-----------|
    /// ```
    pub account_keys: Vec<Pubkey>,
    /// List of instructions making up the tx.
    pub instructions: Vec<MultisigCompiledInstruction>,
    /// List of address table lookups used to load additional accounts
    /// for this transaction.
    pub address_table_lookups: Vec<MultisigMessageAddressTableLookup>,
}

/// Concise serialization schema for instructions that make up a transaction.
/// Closely mimics the Solana transaction wire format.
#[derive(BorshSerialize, BorshDeserialize, Clone, Default, Debug)]
pub struct MultisigCompiledInstruction {
    pub program_id_index: u8,
    /// Indices into the tx's `account_keys` list indicating which accounts to pass to the instruction.
    pub account_indexes: Vec<u8>,
    /// Instruction data.
    pub data: Vec<u8>,
}

/// Address table lookups describe an on-chain address lookup table to use
/// for loading more readonly and writable accounts into a transaction.
#[derive(BorshSerialize, BorshDeserialize, Clone, Default, Debug)]
pub struct MultisigMessageAddressTableLookup {
    /// Address lookup table account key.
    pub account_key: Pubkey,
    /// List of indexes used to load writable accounts.
    pub writable_indexes: Vec<u8>,
    /// List of indexes used to load readonly accounts.
    pub readonly_indexes: Vec<u8>,
}
