use solana_client::{rpc_client::RpcClient, rpc_config::RpcSendTransactionConfig};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::Instruction,
    message::Message,
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
    fn try_sign_message(&self, _message: &[u8]) -> Result<Signature, SignerError> {
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
    pub initial_instructions: RefCell<Vec<InstructionWithDescription>>,
}

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
        payer_keypair: Option<Keypair>,
        payer_keypair_path: Option<String>,
        commitment: CommitmentConfig,
        initial_instructions: RefCell<Vec<InstructionWithDescription>>,
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
            instructions_with_descriptions: self
                .initial_instructions
                .borrow_mut()
                .drain(..)
                .collect(),
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
        self.instructions_with_descriptions
            .push(InstructionWithDescription {
                instruction,
                description: None,
            });
        self
    }

    pub(crate) fn add_with_description<T>(
        mut self,
        instruction: Instruction,
        description: T,
    ) -> Self
    where
        T: Into<String>,
    {
        self.instructions_with_descriptions
            .push(InstructionWithDescription {
                instruction,
                description: Some(description.into()),
            });
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

    pub(crate) fn instructions(&self) -> Vec<Instruction> {
        self.instructions_with_descriptions
            .iter()
            .map(|i| i.instruction.clone())
            .collect()
    }

    pub(crate) fn send<T: Signers>(self, signers: &T) {
        if !self.ctx.payer_can_sign() {
            println!("Transaction to be submitted via Squads multisig:");
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

            let message = Message::new(&self.instructions(), None);
            let txn = Transaction::new_unsigned(message);
            println!(
                "\t==== Transaction in base58: ====\n\t{}",
                bs58::encode(bincode::serialize(&txn).unwrap()).into_string()
            );
            return;
        }

        let client = self.client.unwrap_or(&self.ctx.client);

        let recent_blockhash = client.get_latest_blockhash().unwrap();
        let txn = Transaction::new_signed_with_payer(
            &self.instructions(),
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

    // fn pretty_print_instructions(&self) {
    //     for (i, instruction) in self.instructions.iter().enumerate() {
    //         println!("Instruction {} of {}", i, self.instructions.len());
    //         println!("\t Data: {}", bs58);
    //     }
    // }
}
