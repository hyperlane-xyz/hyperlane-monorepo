use std::collections::HashSet;

use lazy_static::lazy_static;
use solana_sdk::pubkey::Pubkey;
use solana_transaction_status::{
    EncodedTransactionWithStatusMeta, UiInstruction, UiParsedInstruction,
};

use hyperlane_core::{ChainResult, H256, H512};

use crate::error::HyperlaneSealevelError;
use crate::provider::transaction::{inner_instructions, instructions, txn};
use crate::utils::decode_pubkey;

lazy_static! {
    static ref NATIVE_PROGRAMS: HashSet<String> = HashSet::from([
        solana_sdk::bpf_loader_upgradeable::ID.to_string(),
        solana_sdk::compute_budget::ID.to_string(),
        solana_sdk::config::program::ID.to_string(),
        solana_sdk::ed25519_program::ID.to_string(),
        solana_sdk::secp256k1_program::ID.to_string(),
        solana_sdk::stake::program::ID.to_string(),
        solana_sdk::system_program::ID.to_string(),
        solana_sdk::vote::program::ID.to_string(),
    ]);
}

#[derive(Clone, Debug)]
pub(crate) struct RecipientProvider {
    program_id: String,
}

impl RecipientProvider {
    pub(crate) fn new(contract_address: H256) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(contract_address));
        Self {
            program_id: program_id.to_string(),
        }
    }

    pub(crate) fn recipient(
        &self,
        hash: &H512,
        txn_with_meta: &EncodedTransactionWithStatusMeta,
    ) -> ChainResult<H256> {
        let txn = txn(txn_with_meta)?;
        let instructions = instructions(txn)?;
        let empty_binding = Vec::new();
        let mut inner_instructions = inner_instructions(txn_with_meta, &empty_binding)?;
        inner_instructions.extend(instructions);

        let programs = inner_instructions
            .into_iter()
            .filter_map(|ii| {
                if let UiInstruction::Parsed(iii) = ii {
                    Some(iii)
                } else {
                    None
                }
            })
            .map(|ii| match ii {
                UiParsedInstruction::Parsed(iii) => &iii.program_id,
                UiParsedInstruction::PartiallyDecoded(iii) => &iii.program_id,
            })
            .filter(|program_id| !NATIVE_PROGRAMS.contains(*program_id))
            .filter(|program_id| self.program_id == **program_id)
            .collect::<Vec<&String>>();

        if programs.len() > 1 {
            Err(HyperlaneSealevelError::TooManyNonNativePrograms(Box::new(
                *hash,
            )))?;
        }

        let program_id = programs
            .first()
            .ok_or(HyperlaneSealevelError::NoNonNativePrograms(Box::new(*hash)))?;

        let pubkey = decode_pubkey(program_id)?;
        let recipient = H256::from_slice(&pubkey.to_bytes());
        Ok(recipient)
    }
}

#[cfg(test)]
mod tests;
