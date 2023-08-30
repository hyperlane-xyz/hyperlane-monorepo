use solana_client::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcSendTransactionConfig, RpcTransactionConfig};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::signers::Signers;
use solana_sdk::transaction::Transaction;
use solana_transaction_status::{EncodedConfirmedTransactionWithStatusMeta, UiTransactionEncoding};
use std::cell::RefCell;

pub(crate) struct Context {
    pub client: RpcClient,
    pub payer: Keypair,
    pub payer_path: String,
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
    pub(crate) fn new_txn(&self) -> TxnBuilder {
        TxnBuilder {
            ctx: self,
            client: None,
            instructions: self.initial_instructions.borrow_mut().drain(..).collect(),
        }
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

    pub(crate) fn send_with_payer(self) -> Option<EncodedConfirmedTransactionWithStatusMeta> {
        let payer = &self.ctx.payer;
        self.send(&[payer])
    }

    pub(crate) fn send<T: Signers>(
        self,
        signers: &T,
    ) -> Option<EncodedConfirmedTransactionWithStatusMeta> {
        let client = self.client.unwrap_or(&self.ctx.client);

        let recent_blockhash = client.get_latest_blockhash().unwrap();
        let txn = Transaction::new_signed_with_payer(
            &self.instructions,
            Some(&self.ctx.payer.pubkey()),
            signers,
            recent_blockhash,
        );

        let signature = client
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

        // If the commitment level set in the client is less than `finalized`,
        // the only way to reliably read the tx is to use the deprecated
        // `CommitmentConfig::single()` commitment...
        #[allow(deprecated)]
        client
            .get_transaction_with_config(
                &signature,
                RpcTransactionConfig {
                    encoding: Some(UiTransactionEncoding::Base64),
                    commitment: Some(CommitmentConfig::single()),
                    ..RpcTransactionConfig::default()
                },
            )
            .ok()
    }
}
