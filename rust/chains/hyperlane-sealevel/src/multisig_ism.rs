use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H256,
};

use solana::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
};

use crate::{
    utils::{get_account_metas, simulate_instruction},
    ConnectionConf, RpcClientWithDebug, SealevelProvider,
};

use self::contract::{ValidatorsAndThreshold, VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS};

/// A reference to a MultisigIsm contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelMultisigIsm {
    rpc_client: RpcClientWithDebug,
    payer: Option<Keypair>,
    program_id: Pubkey,
    domain: HyperlaneDomain,
}

impl SealevelMultisigIsm {
    pub fn new(conf: &ConnectionConf, locator: ContractLocator, payer: Option<Keypair>) -> Self {
        let rpc_client = RpcClientWithDebug::new(conf.url.to_string());
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));

        Self {
            rpc_client,
            payer,
            program_id,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for SealevelMultisigIsm {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(SealevelProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl MultisigIsm for SealevelMultisigIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let message_bytes = RawHyperlaneMessage::from(message).to_vec();

        let account_metas = self
            .get_validators_and_threshold_account_metas(message_bytes.clone())
            .await?;

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &contract::MultisigIsmInstruction::ValidatorsAndThreshold(message_bytes)
                .encode()
                .map_err(ChainCommunicationError::from_other)?[..],
            account_metas,
        );

        let validators_and_threshold = simulate_instruction::<ValidatorsAndThreshold>(
            &self.rpc_client,
            self.payer
                .as_ref()
                .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?,
            instruction,
        )
        .await?
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "No return data was returned from the multisig ism",
            )
        })?;

        let validators = validators_and_threshold
            .validators
            .into_iter()
            .map(|validator| validator.into())
            .collect();

        Ok((validators, validators_and_threshold.threshold))
    }
}

impl SealevelMultisigIsm {
    async fn get_validators_and_threshold_account_metas(
        &self,
        message_bytes: Vec<u8>,
    ) -> ChainResult<Vec<AccountMeta>> {
        let (account_metas_pda_key, _account_metas_pda_bump) = Pubkey::try_find_program_address(
            VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS,
            &self.program_id,
        )
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "Could not find program address for domain data",
            )
        })?;

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &contract::MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(message_bytes)
                .encode()
                .map_err(ChainCommunicationError::from_other)?[..],
            vec![AccountMeta::new_readonly(account_metas_pda_key, false)],
        );

        get_account_metas(
            &self.rpc_client,
            self.payer
                .as_ref()
                .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?,
            instruction,
        )
        .await
    }
}

mod contract {
    use borsh::{BorshDeserialize, BorshSerialize};
    use hyperlane_core::H160;

    /// A configuration of a validator set and threshold.
    #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default, Clone)]
    pub struct ValidatorsAndThreshold {
        pub validators: Vec<H160>,
        pub threshold: u8,
    }

    /// Instructions that a Hyperlane Multisig ISM is expected to process.
    /// The first 8 bytes of the encoded instruction is a discriminator that
    /// allows programs to implement the required interface.
    #[derive(Eq, PartialEq, Debug)]
    pub enum MultisigIsmInstruction {
        /// Gets the validators and threshold for the provided message.
        ValidatorsAndThreshold(Vec<u8>),
        /// Gets the account metas required for an instruction to the
        /// `ValidatorsAndThreshold` program.
        /// Intended to be simulated by an off-chain client.
        /// The only account passed into this instruction is expected to be
        /// the read-only PDA relating to the program ID and the seeds
        /// `VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS`
        ValidatorsAndThresholdAccountMetas(Vec<u8>),
    }

    const DISCRIMINATOR_LEN: usize = 8;

    /// First 8 bytes of `hash::hashv(&[b"hyperlane-multisig-ism:validators-and-threshold"])`
    const VALIDATORS_AND_THRESHOLD_DISCRIMINATOR: [u8; DISCRIMINATOR_LEN] =
        [82, 96, 5, 220, 241, 173, 13, 50];
    const VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE: &[u8] =
        &VALIDATORS_AND_THRESHOLD_DISCRIMINATOR;

    const VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR: [u8; DISCRIMINATOR_LEN] =
        [113, 7, 132, 85, 239, 247, 157, 204];
    const VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] =
        &VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR;

    /// Seeds for the PDA that's expected to be passed into the `ValidatorsAndThresholdAccountMetas`
    /// instruction.
    pub const VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] = &[
        b"hyperlane_multisig_ism",
        b"-",
        b"validators_and_threshold",
        b"-",
        b"account_metas",
    ];

    #[derive(Debug, thiserror::Error)]
    pub enum ProgramError {}

    // TODO implement hyperlane-core's Encode & Decode?
    impl MultisigIsmInstruction {
        pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
            let mut buf = vec![];
            match self {
                MultisigIsmInstruction::ValidatorsAndThreshold(message) => {
                    buf.extend_from_slice(VALIDATORS_AND_THRESHOLD_DISCRIMINATOR_SLICE);
                    buf.extend_from_slice(&message[..]);
                }
                MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(message) => {
                    buf.extend_from_slice(
                        VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
                    );
                    buf.extend_from_slice(&message[..]);
                }
            }

            Ok(buf)
        }
    }
}
