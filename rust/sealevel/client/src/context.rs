use solana_client::{rpc_client::RpcClient, rpc_config::RpcSendTransactionConfig};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signature, Signer},
    signer::SignerError,
    signers::Signers,
    transaction::Transaction,
};
use std::cell::RefCell;

pub struct DummyPayer();

impl Signer for DummyPayer {
    fn try_pubkey(&self) -> Result<Pubkey, SignerError> {
        Ok(solana_program::pubkey!(
            "DummyPayerDummyPayerDummyPayerDummyPayerDum"
        ))
    }
    fn try_sign_message(&self, message: &[u8]) -> Result<Signature, SignerError> {
        Ok(Signature::new_unique())
    }
    fn is_interactive(&self) -> bool {
        false
    }
}

pub(crate) struct Context {
    pub client: RpcClient,
    pub payer_pubkey: Pubkey,
    payer_keypair: Option<Keypair>,
    payer_keypair_path: Option<String>,
    pub commitment: CommitmentConfig,
    // TODO: can we remove this?
    pub initial_instructions: RefCell<Vec<Instruction>>,
}

pub(crate) struct TxnBuilder<'ctx, 'rpc> {
    ctx: &'ctx Context,
    client: Option<&'rpc RpcClient>,
    instructions: Vec<Instruction>,
}

impl Context {
    pub(crate) fn new(
        client: RpcClient,
        payer_pubkey: Pubkey,
        payer_keypair: Option<Keypair>,
        payer_keypair_path: Option<String>,
        commitment: CommitmentConfig,
        initial_instructions: RefCell<Vec<Instruction>>,
    ) -> Self {
        Self {
            client,
            payer_pubkey,
            payer_keypair,
            payer_keypair_path,
            commitment,
            initial_instructions,
        }
    }

    pub(crate) fn new_txn(&self) -> TxnBuilder {
        TxnBuilder {
            ctx: self,
            client: None,
            instructions: self.initial_instructions.borrow_mut().drain(..).collect(),
        }
    }

    pub(crate) fn payer_can_sign(&self) -> bool {
        self.payer_keypair.is_some()
    }

    pub(crate) fn payer_signer(&self) -> Box<dyn Signer> {
        if let Some(keypair) = &self.payer_keypair {
            Box::new(Keypair::from_bytes(&keypair.to_bytes()).unwrap())
        } else {
            Box::new(DummyPayer())
        }
    }

    pub(crate) fn payer_keypair_path(&self) -> &String {
        self.payer_keypair_path
            .as_ref()
            .expect("No payer keypair path")
    }
}

impl<'ctx, 'rpc> TxnBuilder<'ctx, 'rpc> {
    pub(crate) fn add(mut self, instruction: Instruction) -> Self {
        self.instructions.push(instruction);
        self
    }

    pub(crate) fn with_client(mut self, client: &'rpc RpcClient) -> Self {
        self.client = Some(client);
        self
    }

    pub(crate) fn send_with_payer(self) {
        let payer_signer = self.ctx.payer_signer();
        self.send(&[&*payer_signer])
    }

    pub(crate) fn send<T: Signers>(self, signers: &T) {
        if !self.ctx.payer_can_sign() {
            println!("Transaction to be submitted via Squads multisig:");
            println!("\tInstructions: {:?}", self.instructions);
            // println!("\tSigners: {:?}", signers);
            return;
        }

        let client = self.client.unwrap_or(&self.ctx.client);

        let recent_blockhash = client.get_latest_blockhash().unwrap();
        let txn = Transaction::new_signed_with_payer(
            &self.instructions,
            Some(&self.ctx.payer_pubkey),
            signers,
            recent_blockhash,
        );

        let _signature = client
            .send_and_confirm_transaction_with_spinner_and_config(
                &txn,
                self.ctx.commitment,
                RpcSendTransactionConfig {
                    preflight_commitment: Some(self.ctx.commitment.commitment),
                    ..RpcSendTransactionConfig::default()
                },
            )
            .map_err(|err| {
                eprintln!("{:#?}", err);
                err
            })
            .unwrap();
    }
}
