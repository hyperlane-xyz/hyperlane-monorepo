use solana_program::instruction::Instruction;
use solana_program_test::*;
use solana_sdk::{
    signature::{Signature, Signer},
    signer::keypair::Keypair,
    signers::Signers,
    transaction::Transaction,
};

pub async fn process_instruction<T: Signers>(
    banks_client: &mut BanksClient,
    instruction: Instruction,
    payer: &Keypair,
    signers: &T,
) -> Result<Signature, BanksClientError> {
    let recent_blockhash = banks_client.get_latest_blockhash().await.unwrap();
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        signers,
        recent_blockhash,
    );
    let signature = transaction.signatures[0];
    banks_client.process_transaction(transaction).await?;

    Ok(signature)
}
