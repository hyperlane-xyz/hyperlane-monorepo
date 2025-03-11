use std::collections::HashSet;

use lazy_static::lazy_static;
use solana_transaction_status::{UiInstruction, UiParsedInstruction, UiTransaction};

use hyperlane_core::{ChainResult, H256, H512};

use crate::error::HyperlaneSealevelError;
use crate::provider::message_parser::parsed_message;
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

pub(crate) struct RecipientProvider {}

impl RecipientProvider {
    pub(crate) fn recipient(hash: &H512, txn: &UiTransaction) -> ChainResult<H256> {
        let message = parsed_message(txn)?;

        let programs = message
            .instructions
            .iter()
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
