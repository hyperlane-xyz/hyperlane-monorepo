use std::collections::HashSet;

use solana_sdk::pubkey::Pubkey;
use solana_transaction_status::{UiInstruction, UiParsedInstruction, UiTransaction};

use hyperlane_core::{ChainResult, H256, H512};

use crate::error::HyperlaneSealevelError;
use crate::provider::transaction::instructions;
use crate::utils::decode_pubkey;

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
        println!("uitransaction: {:?}", transaction);
        let instructions = instructions(transaction)?;

        let programs = instructions
            .iter()
            .filter_map(|ii| {
                if let UiInstruction::Parsed(iii) = ii {
                    Some(iii)
                } else {
                    None
                }
            })
            .filter_map(|ii| match ii {
                UiParsedInstruction::Parsed(iii) => {
                    println!("parsed: {:?}", iii);
                    None
                } // only native programs are fully parsed
                UiParsedInstruction::PartiallyDecoded(iii) => {
                    println!("decoded: {:?}", iii);
                    Some(iii)
                }
            })
            .filter(|program| {
                self.programs.contains(&program.program_id)
                    || program
                        .accounts
                        .iter()
                        .any(|account| self.programs.contains(account))
            })
            .map(|program| &program.program_id)
            .collect::<Vec<&String>>();

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
