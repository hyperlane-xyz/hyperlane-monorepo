#![allow(dead_code)]

use borsh::BorshDeserialize;
use hyperlane_core::{HyperlaneMessage, ModuleType, H160, H256};
use hyperlane_sealevel_composite_ism::{
    accounts::{DomainConfig, IsmNode},
    instruction::{
        abort_config_update_instruction, begin_config_update_instruction,
        commit_config_update_instruction, initialize_instruction, update_config_instruction,
        write_config_chunk_instruction,
    },
    processor::process_instruction,
};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_banks_interface::BanksTransactionResultWithSimulation;
use solana_program::{instruction::AccountMeta, pubkey, pubkey::Pubkey};
use solana_program_test::{BanksClient, BanksClientError, ProgramTest};
use solana_sdk::{
    hash::Hash,
    instruction::Instruction,
    message::Message,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

// ── Config-size helpers (shared with integration tests) ───────────────────────

/// Routing ISM with `n` domains, each pointing to `Test { accept: true }`.
pub fn routing_n_test_domains_helper(n: u32) -> IsmNode {
    IsmNode::Routing {
        routes: (1..=n)
            .map(|d| (d, IsmNode::Test { accept: true }))
            .collect(),
        default_ism: None,
    }
}

/// Routing ISM with `n` domains, each pointing to a `MultisigMessageId` with
/// one dummy validator.
pub fn routing_n_multisig_domains_helper(n: u32) -> IsmNode {
    let dummy_validator = H160::from([0xABu8; 20]);
    IsmNode::Routing {
        routes: (1..=n)
            .map(|d| {
                (
                    d,
                    IsmNode::MultisigMessageId {
                        domain_configs: vec![DomainConfig {
                            origin: d,
                            validators: vec![dummy_validator],
                            threshold: 1,
                        }],
                    },
                )
            })
            .collect(),
        default_ism: None,
    }
}

/// Returns the exact wire size (bytes) of an `UpdateConfig` transaction for the
/// given root, using `bincode` (the same serializer Solana uses on-chain).
pub fn update_config_tx_size(root: &IsmNode) -> usize {
    let payer = Keypair::new();
    let ix = update_config_instruction(composite_ism_id(), payer.pubkey(), root.clone()).unwrap();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &Hash::default());
    let tx = Transaction::new_unsigned(msg);
    bincode::serialized_size(&tx).unwrap() as usize
}

pub fn composite_ism_id() -> Pubkey {
    pubkey!("Bprmwvw4fCr1fXF4y3qq7JyNiVwb5JNpkVRqxqMhQgau")
}

pub fn program_test() -> ProgramTest {
    ProgramTest::new(
        "hyperlane_sealevel_composite_ism",
        composite_ism_id(),
        solana_program_test::processor!(process_instruction),
    )
}

pub fn storage_pda_key() -> Pubkey {
    Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &composite_ism_id()).0
}

pub async fn initialize(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    root: IsmNode,
) -> Result<(), BanksClientError> {
    let ix = initialize_instruction(composite_ism_id(), payer.pubkey(), root).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

pub async fn update_config(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    root: IsmNode,
) -> Result<(), BanksClientError> {
    let ix = update_config_instruction(composite_ism_id(), payer.pubkey(), root).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

pub async fn begin_config_update(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    total_len: u32,
) -> Result<(), BanksClientError> {
    let ix =
        begin_config_update_instruction(composite_ism_id(), payer.pubkey(), total_len).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

/// Writes `data` into the staging buffer at `offset` using a single transaction.
pub async fn write_config_chunk(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    offset: u32,
    data: Vec<u8>,
) -> Result<(), BanksClientError> {
    let ix =
        write_config_chunk_instruction(composite_ism_id(), payer.pubkey(), offset, data).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

pub async fn commit_config_update(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
) -> Result<(), BanksClientError> {
    let ix = commit_config_update_instruction(composite_ism_id(), payer.pubkey()).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

pub async fn abort_config_update(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
) -> Result<(), BanksClientError> {
    let ix = abort_config_update_instruction(composite_ism_id(), payer.pubkey()).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

/// Splits Borsh-serialized `IsmNode` bytes into chunks of at most
/// `max_chunk_bytes`, then executes BeginConfigUpdate + N×WriteConfigChunk +
/// CommitConfigUpdate. Use this to set configs that exceed the single-tx limit.
pub async fn chunked_update_config(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    root: IsmNode,
    max_chunk_bytes: usize,
) {
    let bytes = borsh::to_vec(&root).unwrap();
    let total_len = bytes.len() as u32;

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    begin_config_update(banks_client, payer, blockhash, total_len)
        .await
        .unwrap();

    let mut offset = 0u32;
    for chunk in bytes.chunks(max_chunk_bytes) {
        let blockhash = banks_client.get_latest_blockhash().await.unwrap();
        write_config_chunk(banks_client, payer, blockhash, offset, chunk.to_vec())
            .await
            .unwrap();
        offset += chunk.len() as u32;
    }

    let blockhash = banks_client.get_latest_blockhash().await.unwrap();
    commit_config_update(banks_client, payer, blockhash)
        .await
        .unwrap();
}

pub fn dummy_message() -> HyperlaneMessage {
    HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: 1234,
        sender: H256::zero(),
        destination: 4321,
        recipient: H256::zero(),
        body: vec![],
    }
}

/// Builds a TokenMessage body with a given amount (big-endian u256 at bytes 32..64).
pub fn token_message_body(amount: u64) -> Vec<u8> {
    let mut body = vec![0u8; 64];
    body[56..64].copy_from_slice(&amount.to_be_bytes()); // last 8 bytes of 32-byte amount field
    body
}

pub async fn new_funded_keypair(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    lamports: u64,
) -> Keypair {
    let keypair = Keypair::new();
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[solana_system_interface::instruction::transfer(
            &payer.pubkey(),
            &keypair.pubkey(),
            lamports,
        )],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await.unwrap();
    keypair
}

/// Simulates `VerifyAccountMetas` and returns the resulting `Vec<AccountMeta>`.
pub async fn get_verify_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    verify_instruction: VerifyInstruction,
) -> Vec<AccountMeta> {
    let storage_pda = storage_pda_key();
    let data = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                composite_ism_id(),
                &InterchainSecurityModuleInstruction::VerifyAccountMetas(verify_instruction)
                    .encode()
                    .unwrap(),
                vec![AccountMeta::new_readonly(storage_pda, false)],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;

    let metas: Vec<SerializableAccountMeta> =
        SimulationReturnData::<Vec<SerializableAccountMeta>>::try_from_slice(&data)
            .unwrap()
            .return_data;
    metas.into_iter().map(|m| m.into()).collect()
}

/// Simulates `Verify` using the given account metas and returns the raw simulation result.
/// Uses an unsigned transaction, which is fine for programs that don't check fee-payer sig.
/// For TrustedRelayer tests (which check `is_signer` on an extra account), pass the relayer's
/// pubkey as a signer in the instruction accounts — the SVM sets `is_signer` based on the
/// message's required-signers list, not on actual signature bytes during simulation.
pub async fn simulate_verify(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    verify_instruction: VerifyInstruction,
    account_metas: Vec<AccountMeta>,
) -> BanksTransactionResultWithSimulation {
    banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                composite_ism_id(),
                &InterchainSecurityModuleInstruction::Verify(verify_instruction)
                    .encode()
                    .unwrap(),
                account_metas,
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
}

/// Asserts that a simulation succeeded (no transaction error).
pub fn assert_simulation_ok(result: &BanksTransactionResultWithSimulation) {
    assert!(
        result.result.as_ref().map(|r| r.is_ok()).unwrap_or(false),
        "expected simulation success, got {:?}",
        result.result
    );
}

/// Asserts that a simulation failed with the given transaction error.
pub fn assert_simulation_error(
    result: &BanksTransactionResultWithSimulation,
    expected: TransactionError,
) {
    let actual_err = result.result.as_ref().and_then(|r| r.as_ref().err());
    assert_eq!(
        actual_err,
        Some(&expected),
        "expected {:?}, got {:?}",
        expected,
        result.result
    );
}

/// Builds aggregation metadata bytes from sub-metadata slices.
/// `None` entries represent sub-ISMs with no metadata (start=0).
pub fn encode_aggregation_metadata(sub_metas: &[Option<&[u8]>]) -> Vec<u8> {
    let header_len = (sub_metas.len() * 8) as u32;
    let mut offsets: Vec<(u32, u32)> = Vec::new();
    let mut cursor = header_len;
    for opt in sub_metas {
        if let Some(m) = opt {
            let start = cursor;
            let end = start + m.len() as u32;
            offsets.push((start, end));
            cursor = end;
        } else {
            offsets.push((0, 0));
        }
    }
    let mut buf = Vec::new();
    for (start, end) in &offsets {
        buf.extend_from_slice(&start.to_be_bytes());
        buf.extend_from_slice(&end.to_be_bytes());
    }
    for opt in sub_metas {
        if let Some(m) = opt {
            buf.extend_from_slice(m);
        }
    }
    buf
}

/// Simulates `Type` and returns the resulting `ModuleType`.
pub async fn get_ism_type(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
) -> ModuleType {
    let storage_pda = storage_pda_key();
    let data = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                composite_ism_id(),
                &InterchainSecurityModuleInstruction::Type.encode().unwrap(),
                vec![AccountMeta::new_readonly(storage_pda, false)],
            )],
            Some(&payer.pubkey()),
            &recent_blockhash,
        )))
        .await
        .unwrap()
        .simulation_details
        .unwrap()
        .return_data
        .unwrap()
        .data;

    let type_u32 = SimulationReturnData::<u32>::try_from_slice(&data)
        .unwrap()
        .return_data;
    num_traits::FromPrimitive::from_u32(type_u32).unwrap()
}
