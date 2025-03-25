use std::collections::HashSet;

use lazy_static::lazy_static;
use solana_sdk::pubkey::Pubkey;
use solana_transaction_status::{
    UiInstruction, UiParsedInstruction, UiPartiallyDecodedInstruction, UiTransaction,
};

use hyperlane_core::{ChainResult, H256, H512};

use crate::error::HyperlaneSealevelError;
use crate::provider::transaction::instructions;
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
    programs: HashSet<String>,
}

impl RecipientProvider {
    pub(crate) fn new(contract_addresses: &[H256]) -> Self {
        let programs = contract_addresses
            .iter()
            .map(|address| Pubkey::from(<[u8; 32]>::from(*address)))
            .map(|address| address.to_string())
            .collect();
        Self { programs }
    }

    pub(crate) fn recipient(&self, hash: &H512, transaction: &UiTransaction) -> ChainResult<H256> {
        let instructions = instructions(transaction)?;

        let decoded = instructions
            .iter()
            .filter_map(|ii| {
                if let UiInstruction::Parsed(iii) = ii {
                    Some(iii)
                } else {
                    None
                }
            })
            .filter_map(|ii| match ii {
                UiParsedInstruction::Parsed(_) => None, // only native programs are fully parsed
                UiParsedInstruction::PartiallyDecoded(iii) => Some(iii),
            })
            .collect::<Vec<&UiPartiallyDecodedInstruction>>();

        let program_id = decoded
            .iter()
            .find(|program| {
                self.programs.contains(&program.program_id)
                    || program
                        .accounts
                        .iter()
                        .any(|account| self.programs.contains(account))
            })
            .map(|program| program.program_id.clone());

        let program_id = match program_id {
            Some(p) => p,
            None => decoded
                .iter()
                .find(|ii| !NATIVE_PROGRAMS.contains(&ii.program_id))
                .map(|i| i.program_id.clone())
                .ok_or(HyperlaneSealevelError::NoNonNativePrograms(Box::new(*hash)))?,
        };

        let pubkey = decode_pubkey(&program_id)?;
        let recipient = H256::from_slice(&pubkey.to_bytes());
        Ok(recipient)
    }
}

#[cfg(test)]
mod tests;
