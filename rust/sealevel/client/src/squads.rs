use std::{collections::HashMap, fs::File, path::PathBuf};

use account_utils::DiscriminatorDecode;
use borsh::{BorshDeserialize, BorshSerialize};
use clap::{Args, Subcommand};
use hyperlane_sealevel_mailbox::instruction::Instruction as MailboxInstruction;
use hyperlane_sealevel_multisig_ism_message_id::instruction::Instruction as MultisigIsmInstruction;
use solana_client::rpc_client::RpcClient;
use solana_program::pubkey;
use solana_sdk::{
    account::Account, account_utils::StateMut, bpf_loader_upgradeable::UpgradeableLoaderState,
    pubkey::Pubkey,
};

use crate::{read_core_program_ids, router::ChainMetadata, Context, EnvironmentArgs};

const COMPUTE_BUDGET_PROGRAM_ID: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID: Pubkey =
    pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

const CHAIN_CORE_OWNERS: &[(&str, &[(&str, Pubkey)])] = &[
    (
        "soon",
        &[
            (
                "OLD pre-TGE owner",
                pubkey!("E3QPSn2Upk2EiidSsUqSQpRCc7BhzWZCKpVncemz3p62"),
            ),
            (
                "NEW post-TGE owner",
                pubkey!("7Y6WDpMfNeb1b4YYbyUkF41z1DuPhvDDuWWJCHPRNa9Y"),
            ),
        ],
    ),
    (
        "solanamainnet",
        &[
            (
                "OLD pre-TGE owner",
                pubkey!("BNGDJ1h9brgt6FFVd8No1TVAH48Fp44d7jkuydr1URwJ"),
            ),
            (
                "NEW post-TGE owner",
                pubkey!("3oocunLfAgATEqoRyW7A5zirsQuHJh6YjD4kReiVVKLa"),
            ),
        ],
    ),
    (
        "eclipsemainnet",
        &[
            (
                "OLD pre-TGE owner",
                pubkey!("E4TncCw3WMqQZbkACVcomX3HqcSzLfNyhTnqKN1DimGr"),
            ),
            (
                "NEW post-TGE owner",
                pubkey!("D742EWw9wpV47jRAvEenG1oWHfMmpiQNJLjHTBfXhuRm"),
            ),
        ],
    ),
    (
        "sonicsvm",
        &[
            (
                "OLD pre-TGE owner",
                pubkey!("FeJQJrHNEeg9TNMpTmTg6h1JoKqSqctJbMj4H8CksPdD"),
            ),
            (
                "NEW post-TGE owner",
                pubkey!("8ECSwp5yo2EeZkozSrpPnMj5Rmcwa4VBYCETE9LHmc9y"),
            ),
        ],
    ),
];

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
    /// Environment
    #[command(flatten)]
    env_args: EnvironmentArgs,
    #[arg(long)]
    chain_config_file: PathBuf,
    /// The path to the squads file to verify
    #[arg(long, short)]
    tx_pubkeys: Vec<Pubkey>,
    #[arg(long)]
    chain: String,
}

pub fn process_squads_cmd(ctx: Context, cmd: SquadsCmd) {
    match cmd.cmd {
        SquadsSubCmd::Verify(verify) => {
            let chain_config_file = File::open(verify.chain_config_file).unwrap();
            let chain_configs: HashMap<String, ChainMetadata> =
                serde_json::from_reader(chain_config_file).unwrap();

            let chain_config = chain_configs
                .get(&verify.chain)
                .expect("No chain config found");

            let client = chain_config.client();

            // Read existing core program IDs
            let core_program_ids = read_core_program_ids(
                &verify.env_args.environments_dir,
                &verify.env_args.environment,
                &verify.chain,
            );
            let core_programs = vec![
                ProgramIdWithMetadata::new("Mailbox".into(), core_program_ids.mailbox),
                ProgramIdWithMetadata::new(
                    "Validator Announce".into(),
                    core_program_ids.validator_announce,
                ),
                ProgramIdWithMetadata::new(
                    "Multisig ISM Message ID".into(),
                    core_program_ids.multisig_ism_message_id,
                ),
                ProgramIdWithMetadata::new("IGP program".into(), core_program_ids.igp_program_id),
            ];

            // Chain -> (Label, Owner)
            let chain_owner_lookups: HashMap<String, Vec<(Pubkey, String)>> = CHAIN_CORE_OWNERS
                .iter()
                .map(|c| {
                    (
                        c.0.to_owned(),
                        c.1.iter()
                            .map(|inner| (inner.1, format!("{} - {}", inner.0, c.0)))
                            .collect(),
                    )
                })
                .collect();
            let chain_owner_lookup = chain_owner_lookups
                .get(&verify.chain)
                .expect("No expected core chain owners")
                .clone();

            let mut classification_accounts = vec![
                (COMPUTE_BUDGET_PROGRAM_ID, "Compute Budget program".into()),
                (
                    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
                    "BPF Loader Upgradeable program".into(),
                ),
            ];
            classification_accounts.extend(chain_owner_lookup);

            let pubkey_classifier =
                PubkeyClassifier::new(&client, classification_accounts, core_programs);

            let accounts = client
                .get_multiple_accounts_with_commitment(&verify.tx_pubkeys, ctx.commitment)
                .unwrap()
                .value;

            for (i, account) in accounts.iter().enumerate() {
                println!("\n\n\n\n=================================================");
                println!("=================================================");
                println!("=================================================");
                println!(
                    "Tx proposal pubkey: {:?} ({} of {})",
                    verify.tx_pubkeys[i],
                    i + 1,
                    verify.tx_pubkeys.len()
                );
                if let Some(account) = account {
                    parse_tx_account(account.clone(), &pubkey_classifier);
                } else {
                    println!("Account not found");
                }
            }
        }
    }
}

fn parse_tx_account(account: Account, pubkey_classifier: &PubkeyClassifier) {
    let mut data = account.data.as_slice();
    let discriminator = &data[..8];
    if discriminator != VAULT_TRANSACTION_DISCRIMINATOR {
        panic!("Invalid discriminator");
    }
    data = &data[8..];

    let vault_transaction: VaultTransaction = VaultTransaction::try_from_slice(data).unwrap();

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
            println!("\tA system program instruction that is ignored by the vault but our tooling sets anyways. Just ignore it.");
            continue;
        };
        println!(
            "\tProgram called: {}",
            pubkey_classifier.classify(program_id)
        );

        if *program_id == COMPUTE_BUDGET_PROGRAM_ID {
            println!("\tComputeBudget instruction (e.g. setting limit or price), can ignore");
            continue;
        }

        if *program_id == BPF_LOADER_UPGRADEABLE_PROGRAM_ID {
            println!("\tBPF Loader Upgradeable instruction (how the system manages programs)");
            // Setting the upgrade authority, found here https://explorer.eclipse.xyz/tx/3RQ9V2HSbg4aZwr3LTMMwzrEBHa18KHMVwngXsHF2t5YZJ1Hb4MiBd7hovdPanLJT7Lmy2uuide55WmQvXDPjGx5
            if instruction.data == [4, 0, 0, 0] {
                println!("\tSetting the upgrade authority:");
                let target_program = vault_transaction
                    .message
                    .account_keys
                    .get(instruction.account_indexes[0] as usize)
                    .unwrap();
                println!(
                    "\t\tTarget program: {}",
                    pubkey_classifier.classify(target_program)
                );
                let old_upgrade_authority = vault_transaction
                    .message
                    .account_keys
                    .get(instruction.account_indexes[1] as usize)
                    .unwrap();
                println!(
                    "\t\tOld upgrade authority: {}",
                    pubkey_classifier.classify(old_upgrade_authority)
                );
                let new_upgrade_authority = vault_transaction
                    .message
                    .account_keys
                    .get(instruction.account_indexes[2] as usize)
                    .unwrap();
                println!(
                    "\t\tNew upgrade authority: {}",
                    pubkey_classifier.classify(new_upgrade_authority)
                );
            } else {
                println!("⚠️ Unknown instruction")
            }
            continue;
        }

        // Try to parse as a MailboxInstruction
        if let Ok(instruction) = MailboxInstruction::try_from_slice(&instruction.data) {
            println!("\tMailbox instruction: {:?}", instruction);
            if let MailboxInstruction::TransferOwnership(new_owner) = instruction {
                println!(
                    "\tTransfer ownership to {}",
                    new_owner.map_or("None".into(), |owner| pubkey_classifier.classify(&owner))
                );
            }
            continue;
        }

        // Else, try to parse as a MultisigIsmInstruction
        if let Ok(instruction) = MultisigIsmInstruction::decode(&instruction.data) {
            println!("\tMultisig ISM instruction: {:?}", instruction);
            if let MultisigIsmInstruction::TransferOwnership(new_owner) = instruction {
                println!(
                    "\tTransfer ownership to {}",
                    new_owner.map_or("None".into(), |owner| pubkey_classifier.classify(&owner))
                );
            }
            continue;
        }
        println!("\n ⚠️ Unknown instruction! ⚠️");
    }
}

#[derive(Debug, Clone)]
struct ProgramIdWithMetadata {
    name: String,
    program_id: Pubkey,
}

impl ProgramIdWithMetadata {
    fn new(name: String, program_id: Pubkey) -> Self {
        Self { name, program_id }
    }
}

struct PubkeyClassifier {
    lookup: HashMap<Pubkey, String>,
    programdata_to_program_id: HashMap<Pubkey, Pubkey>,
}

impl PubkeyClassifier {
    pub fn new(
        client: &RpcClient,
        general_accounts: Vec<(Pubkey, String)>,
        programs: Vec<ProgramIdWithMetadata>,
    ) -> Self {
        let accounts = client
            .get_multiple_accounts_with_commitment(
                &programs.iter().map(|p| p.program_id).collect::<Vec<_>>(),
                Default::default(),
            )
            .unwrap()
            .value;

        let mut lookup: HashMap<Pubkey, String> = general_accounts.into_iter().collect();
        let mut programdata_to_program_id = HashMap::new();

        for (i, account) in accounts.iter().enumerate() {
            let program = programs[i].clone();

            let Some(program_account) = account else {
                panic!("Expected account for program {:?}", program);
            };

            // Get the program data account address by looking at the program state
            let programdata_address = if let Ok(UpgradeableLoaderState::Program {
                programdata_address,
            }) = program_account.state()
            {
                programdata_address
            } else {
                panic!("Unable to deserialize program account {:?}", program);
            };

            programdata_to_program_id.insert(programdata_address, program.program_id);
            lookup.insert(program.program_id, program.name);
        }

        Self {
            lookup,
            programdata_to_program_id,
        }
    }

    pub fn classify(&self, pubkey: &Pubkey) -> String {
        if let Some(lookup_match) = self.lookup.get(pubkey) {
            return format!("{} ({})", pubkey, lookup_match);
        }

        if let Some(programdata_match) = self.programdata_to_program_id.get(pubkey) {
            return format!(
                "{} (Program Data account of {})",
                pubkey,
                self.classify(programdata_match)
            );
        };

        format!("{} (⚠️ Unknown ⚠️)", pubkey)
    }
}

// Vendored (and slightly altered, to not require Anchor) to avoid needing
// to import from Squads directly and going through the dependency pain

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
