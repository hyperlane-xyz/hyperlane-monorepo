#![allow(dead_code)]

use borsh::BorshDeserialize;
use hyperlane_core::{HyperlaneMessage, ModuleType, H256};
use hyperlane_sealevel_composite_ism::{
    accounts::{derive_domain_pda, IsmNode},
    instruction::{
        initialize_instruction, remove_domain_ism_instruction, set_domain_ism_instruction,
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

/// Single-pass `VerifyAccountMetas` call with the given input accounts.
async fn call_vam_once(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    verify_instruction: VerifyInstruction,
    accounts: Vec<AccountMeta>,
) -> Vec<AccountMeta> {
    let data = banks_client
        .simulate_transaction(Transaction::new_unsigned(Message::new_with_blockhash(
            &[Instruction::new_with_bytes(
                composite_ism_id(),
                &InterchainSecurityModuleInstruction::VerifyAccountMetas(verify_instruction)
                    .encode()
                    .unwrap(),
                accounts,
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

/// Simulates `VerifyAccountMetas` (single pass) and returns the result.
pub async fn get_verify_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    verify_instruction: VerifyInstruction,
) -> Vec<AccountMeta> {
    let storage_pda = AccountMeta::new_readonly(storage_pda_key(), false);
    call_vam_once(
        banks_client,
        payer,
        recent_blockhash,
        verify_instruction,
        vec![storage_pda],
    )
    .await
}

/// Resolves the full account list needed by `Verify` by calling
/// `VerifyAccountMetas` in a fixpoint loop.
///
/// Each iteration feeds the previous result back as input accounts, allowing
/// `Routing` nodes to discover sub-accounts (e.g. `TrustedRelayer`) that are
/// only readable once the domain PDA is known. The loop terminates when no new
/// pubkeys appear in the returned list — i.e. the set has converged.
///
/// Use this everywhere the relayer prepares accounts for `Verify`. A single
/// call to `get_verify_account_metas` is only sufficient for trees that contain
/// no `Routing` nodes with `TrustedRelayer` (or other account-bearing ISMs)
/// inside their domain PDAs.
pub async fn get_all_verify_account_metas(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    verify_instruction: VerifyInstruction,
) -> Vec<AccountMeta> {
    let mut accounts = vec![AccountMeta::new_readonly(storage_pda_key(), false)];
    loop {
        let result = call_vam_once(
            banks_client,
            payer,
            recent_blockhash,
            verify_instruction.clone(),
            accounts.clone(),
        )
        .await;

        // Converged when no new pubkeys appear (flags may differ but pubkeys are stable).
        let new_keys: Vec<Pubkey> = result.iter().map(|m| m.pubkey).collect();
        let prev_keys: Vec<Pubkey> = accounts.iter().map(|m| m.pubkey).collect();
        if new_keys == prev_keys {
            return result;
        }
        accounts = result;
    }
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

/// Returns the domain PDA key for a `Routing` node.
pub fn domain_pda_key(domain: u32) -> Pubkey {
    derive_domain_pda(&composite_ism_id(), domain).0
}

/// Submits a `SetDomainIsm` instruction.
pub async fn set_domain_ism(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    domain: u32,
    ism: IsmNode,
) -> Result<(), BanksClientError> {
    let ix = set_domain_ism_instruction(composite_ism_id(), payer.pubkey(), domain, ism).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
}

/// Submits a `RemoveDomainIsm` instruction.
pub async fn remove_domain_ism(
    banks_client: &mut BanksClient,
    payer: &Keypair,
    recent_blockhash: Hash,
    domain: u32,
) -> Result<(), BanksClientError> {
    let ix = remove_domain_ism_instruction(composite_ism_id(), payer.pubkey(), domain).unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    banks_client.process_transaction(tx).await
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
