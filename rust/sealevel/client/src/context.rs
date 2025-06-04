use solana_client::{
    rpc_client::RpcClient,
    rpc_config::{RpcSendTransactionConfig, RpcTransactionConfig},
};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::Instruction,
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use solana_transaction_status::{EncodedConfirmedTransactionWithStatusMeta, UiTransactionEncoding};
use std::{cell::RefCell, io::Read};

pub(crate) struct PayerKeypair {
    pub keypair: Keypair,
    pub keypair_path: String,
}

pub(crate) struct Context {
    pub client: RpcClient,
    pub payer_pubkey: Pubkey,
    payer_keypair: Option<PayerKeypair>,
    pub commitment: CommitmentConfig,
    pub initial_instructions: RefCell<Vec<InstructionWithDescription>>,
    pub require_tx_approval: bool,
}

#[derive(Debug)]
pub(crate) struct InstructionWithDescription {
    pub instruction: Instruction,
    pub description: Option<String>,
}

impl<T> From<(T, Option<String>)> for InstructionWithDescription
where
    T: Into<Instruction>,
{
    fn from((instruction, description): (T, Option<String>)) -> Self {
        Self {
            instruction: instruction.into(),
            description,
        }
    }
}

pub(crate) struct TxnBuilder<'ctx, 'rpc> {
    ctx: &'ctx Context,
    client: Option<&'rpc RpcClient>,
    instructions_with_descriptions: Vec<InstructionWithDescription>,
}

impl Context {
    pub(crate) fn new(
        client: RpcClient,
        payer_pubkey: Pubkey,
        payer_keypair: Option<PayerKeypair>,
        commitment: CommitmentConfig,
        initial_instructions: RefCell<Vec<InstructionWithDescription>>,
        require_tx_approval: bool,
    ) -> Self {
        Self {
            client,
            payer_pubkey,
            payer_keypair,
            commitment,
            initial_instructions,
            require_tx_approval,
        }
    }

    pub(crate) fn new_txn(&self) -> TxnBuilder {
        TxnBuilder {
            ctx: self,
            client: None,
            instructions_with_descriptions: self
                .initial_instructions
                .borrow_mut()
                .drain(..)
                .collect(),
        }
    }

    pub(crate) fn payer_signer(&self) -> Option<Box<dyn Signer>> {
        if let Some(PayerKeypair { keypair, .. }) = &self.payer_keypair {
            Some(Box::new(Keypair::from_bytes(&keypair.to_bytes()).unwrap()))
        } else {
            None
        }
    }

    /// If the pubkey matches the payer's pubkey, return the payer's signer.
    /// Otherwise, return None.
    pub(crate) fn signer_for_pubkey(&self, pubkey: &Pubkey) -> Option<Box<dyn Signer>> {
        if let Some(PayerKeypair { keypair, .. }) = &self.payer_keypair {
            if &keypair.pubkey() == pubkey {
                return self.payer_signer();
            }
        }
        None
    }

    pub(crate) fn payer_keypair_path(&self) -> &String {
        &self
            .payer_keypair
            .as_ref()
            .expect("No payer keypair path")
            .keypair_path
    }
}

impl<'ctx, 'rpc> TxnBuilder<'ctx, 'rpc> {
    pub(crate) fn add(self, instruction: Instruction) -> Self {
        self.add_with_optional_description(instruction, None)
    }

    pub(crate) fn add_with_description<T>(self, instruction: Instruction, description: T) -> Self
    where
        T: Into<String>,
    {
        self.add_with_optional_description(instruction, Some(description.into()))
    }

    fn add_with_optional_description(
        mut self,
        instruction: Instruction,
        description: Option<String>,
    ) -> Self {
        self.instructions_with_descriptions
            .push(InstructionWithDescription {
                instruction,
                description,
            });
        self
    }

    pub(crate) fn with_client(mut self, client: &'rpc RpcClient) -> Self {
        self.client = Some(client);
        self
    }

    pub(crate) fn instructions(&self) -> Vec<Instruction> {
        self.instructions_with_descriptions
            .iter()
            .map(|i| i.instruction.clone())
            .collect()
    }

    pub(crate) fn pretty_print_transaction(&self, payer: &Pubkey) {
        println!("\t==== Instructions: ====");

        for (i, InstructionWithDescription { description, .. }) in
            self.instructions_with_descriptions.iter().enumerate()
        {
            println!(
                "\tInstruction {}: {}",
                i,
                description.as_deref().unwrap_or("No description provided")
            );
        }

        let message = Message::new(&self.instructions(), Some(payer));
        // Useful for plugging into ledger-friendly tools
        if std::env::var("TX_BINARY").is_ok() {
            println!(
                "\t==== Message as binary: ====\n\t{:?}",
                bincode::serialize(&message)
                    .unwrap()
                    .iter()
                    .map(|n| n.to_string())
                    .collect::<Vec<String>>()
                    .join(" ")
            );
        }

        let txn = Transaction::new_unsigned(message.clone());
        println!(
            "\t==== Transaction in base58: ====\n\t{}",
            bs58::encode(bincode::serialize(&txn).unwrap()).into_string()
        );

        println!(
            "\t==== Message in base58: ====\n\t{}",
            bs58::encode(bincode::serialize(&message).unwrap()).into_string()
        );
    }

    pub(crate) fn send_with_payer(self) -> Option<EncodedConfirmedTransactionWithStatusMeta> {
        let payer_signer = self.ctx.payer_signer();
        let payer_pubkey = self.ctx.payer_pubkey;
        self.send(&[payer_signer.as_deref()], &payer_pubkey)
    }

    /// Sends the transaction with a signer for the given pubkey.
    /// Note that a pubkey may not have an associated keypair, in which case
    /// this function will return None and transactions will be printed to stdout
    /// for user confirmation & manual submission.
    pub(crate) fn send_with_pubkey_signer(
        self,
        pubkey: &Pubkey,
    ) -> Option<EncodedConfirmedTransactionWithStatusMeta> {
        let signer = self.ctx.signer_for_pubkey(pubkey);
        self.send(&[signer.as_deref()], pubkey)
    }

    pub(crate) fn send(
        self,
        maybe_signers: &[Option<&dyn Signer>],
        payer: &Pubkey,
    ) -> Option<EncodedConfirmedTransactionWithStatusMeta> {
        // If the payer can't sign, it's presumed that the payer is intended
        // to be a Squads multisig, which must be submitted via a separate
        // process.
        // We print the transaction to stdout and wait for user confirmation to
        // continue.
        if maybe_signers.iter().any(|s| s.is_none()) {
            println!("Transaction to be submitted via Squads multisig:");

            self.pretty_print_transaction(payer);

            wait_for_user_confirmation();

            return None;
        }

        let signers: Vec<&dyn Signer> = maybe_signers.iter().map(|s| s.unwrap()).collect();

        // Print the tx as an indication for what's about to happen
        self.pretty_print_transaction(payer);

        if self.ctx.require_tx_approval {
            wait_for_user_confirmation();
        }

        let client = self.client.unwrap_or(&self.ctx.client);

        let recent_blockhash = client.get_latest_blockhash().unwrap();
        let txn = Transaction::new_signed_with_payer(
            &self.instructions(),
            Some(payer),
            &signers,
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

// Poor man's strategy for waiting for user confirmation
fn wait_for_user_confirmation() {
    println!("Continue? [y/n] then press Enter");
    let mut input = [0u8; 1];
    loop {
        std::io::stdin().read_exact(&mut input).unwrap();
        match input[0] {
            b'y' => {
                println!("Continuing...");
                break;
            }
            b'n' => {
                panic!("User requested exit");
            }
            _ => {}
        }
    }
}
