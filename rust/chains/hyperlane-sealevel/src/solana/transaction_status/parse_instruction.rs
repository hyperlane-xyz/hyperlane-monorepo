use {
    /*
    crate::{
        extract_memos::{spl_memo_id_v1, spl_memo_id_v3},
        parse_associated_token::{parse_associated_token, spl_associated_token_id},
        parse_bpf_loader::{parse_bpf_loader, parse_bpf_upgradeable_loader},
        parse_stake::parse_stake,
        parse_system::parse_system,
        parse_token::parse_token,
        parse_vote::parse_vote,
    },
    */
    inflector::Inflector,
    serde_json::Value,
    // solana_account_decoder::parse_token::spl_token_ids,
    crate::solana::{
        instruction::CompiledInstruction, message::AccountKeys, pubkey::Pubkey /*, stake,*/
        // system_program,
    },
    std::{
        collections::HashMap,
        str::{from_utf8, Utf8Error},
    },
    thiserror::Error,
};
use std::str::FromStr as _;
use serde::{Deserialize, Serialize};

lazy_static::lazy_static! {
    static ref ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
        Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap();
    static ref BPF_LOADER_PROGRAM_ID: Pubkey =
        Pubkey::from_str("BPFLoader2111111111111111111111111111111111").unwrap();
    static ref BPF_UPGRADEABLE_LOADER_PROGRAM_ID: Pubkey =
        Pubkey::from_str("BPFLoaderUpgradeab1e11111111111111111111111").unwrap();
    static ref MEMO_V1_PROGRAM_ID: Pubkey =
        Pubkey::from_str("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo").unwrap();
    static ref MEMO_V3_PROGRAM_ID: Pubkey =
        Pubkey::from_str("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr").unwrap();
    static ref STAKE_PROGRAM_ID: Pubkey =
        Pubkey::from_str("Stake11111111111111111111111111111111111111").unwrap();
    static ref SYSTEM_PROGRAM_ID: Pubkey =
        Pubkey::from_str("11111111111111111111111111111111").unwrap();
    static ref VOTE_PROGRAM_ID: Pubkey =
        Pubkey::from_str("Vote111111111111111111111111111111111111111").unwrap();
    static ref PARSABLE_PROGRAM_IDS: HashMap<Pubkey, ParsableProgram> = {
        let mut m = HashMap::new();
        m.insert(
            *ASSOCIATED_TOKEN_PROGRAM_ID,
            ParsableProgram::SplAssociatedTokenAccount,
        );
        m.insert(*MEMO_V1_PROGRAM_ID, ParsableProgram::SplMemo);
        m.insert(*MEMO_V3_PROGRAM_ID, ParsableProgram::SplMemo);
        for spl_token_id in [
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        ] {
            m.insert(Pubkey::from_str(spl_token_id).unwrap(), ParsableProgram::SplToken);
        }
        m.insert(*BPF_LOADER_PROGRAM_ID, ParsableProgram::BpfLoader);
        m.insert(
            *BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
            ParsableProgram::BpfUpgradeableLoader,
        );
        m.insert(*STAKE_PROGRAM_ID, ParsableProgram::Stake);
        m.insert(*SYSTEM_PROGRAM_ID, ParsableProgram::System);
        m.insert(*VOTE_PROGRAM_ID, ParsableProgram::Vote);
        m
    };
}

#[derive(Error, Debug)]
pub enum ParseInstructionError {
    #[error("{0:?} instruction not parsable")]
    InstructionNotParsable(ParsableProgram),

    #[error("{0:?} instruction key mismatch")]
    InstructionKeyMismatch(ParsableProgram),

    #[error("Program not parsable")]
    ProgramNotParsable,

    #[error("Internal error, please report")]
    SerdeJsonError(#[from] serde_json::error::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedInstruction {
    pub program: String,
    pub program_id: String,
    pub parsed: Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedInstructionEnum {
    #[serde(rename = "type")]
    pub instruction_type: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub info: Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParsableProgram {
    SplAssociatedTokenAccount,
    SplMemo,
    SplToken,
    BpfLoader,
    BpfUpgradeableLoader,
    Stake,
    System,
    Vote,
}

pub fn parse(
    program_id: &Pubkey,
    instruction: &CompiledInstruction,
    account_keys: &AccountKeys,
) -> Result<ParsedInstruction, ParseInstructionError> {
    let program_name = PARSABLE_PROGRAM_IDS
        .get(program_id)
        .ok_or(ParseInstructionError::ProgramNotParsable)?;
    let parsed_json = match program_name {
        ParsableProgram::SplAssociatedTokenAccount => {
            unimplemented!()
            // serde_json::to_value(parse_associated_token(instruction, account_keys)?)?
        }
        ParsableProgram::SplMemo => {
            unimplemented!()
            // parse_memo(instruction)?
        },
        ParsableProgram::SplToken => {
            unimplemented!()
            // serde_json::to_value(parse_token(instruction, account_keys)?)?
        },
        ParsableProgram::BpfLoader => {
            unimplemented!()
            // serde_json::to_value(parse_bpf_loader(instruction, account_keys)?)?
        }
        ParsableProgram::BpfUpgradeableLoader => {
            todo!()
            // serde_json::to_value(parse_bpf_upgradeable_loader(instruction, account_keys)?)?
        }
        ParsableProgram::Stake => {
            unimplemented!()
            // serde_json::to_value(parse_stake(instruction, account_keys)?)?
        },
        ParsableProgram::System => {
            unimplemented!()
            // serde_json::to_value(parse_system(instruction, account_keys)?)?
        },
        ParsableProgram::Vote => {
            unimplemented!()
            // serde_json::to_value(parse_vote(instruction, account_keys)?)?
        },
    };
    Ok(ParsedInstruction {
        program: format!("{:?}", program_name).to_kebab_case(),
        program_id: program_id.to_string(),
        parsed: parsed_json,
    })
}

/*
fn parse_memo(instruction: &CompiledInstruction) -> Result<Value, ParseInstructionError> {
    parse_memo_data(&instruction.data)
        .map(Value::String)
        .map_err(|_| ParseInstructionError::InstructionNotParsable(ParsableProgram::SplMemo))
}

pub fn parse_memo_data(data: &[u8]) -> Result<String, Utf8Error> {
    from_utf8(data).map(|s| s.to_string())
}

pub(crate) fn check_num_accounts(
    accounts: &[u8],
    num: usize,
    parsable_program: ParsableProgram,
) -> Result<(), ParseInstructionError> {
    if accounts.len() < num {
        Err(ParseInstructionError::InstructionKeyMismatch(
            parsable_program,
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use {super::*, serde_json::json};

    #[test]
    fn test_parse() {
        let no_keys = AccountKeys::new(&[], None);
        let memo_instruction = CompiledInstruction {
            program_id_index: 0,
            accounts: vec![],
            data: vec![240, 159, 166, 150],
        };
        assert_eq!(
            parse(&MEMO_V1_PROGRAM_ID, &memo_instruction, &no_keys).unwrap(),
            ParsedInstruction {
                program: "spl-memo".to_string(),
                program_id: MEMO_V1_PROGRAM_ID.to_string(),
                parsed: json!("🦖"),
            }
        );
        assert_eq!(
            parse(&MEMO_V3_PROGRAM_ID, &memo_instruction, &no_keys).unwrap(),
            ParsedInstruction {
                program: "spl-memo".to_string(),
                program_id: MEMO_V3_PROGRAM_ID.to_string(),
                parsed: json!("🦖"),
            }
        );

        let non_parsable_program_id = Pubkey::new(&[1; 32]);
        assert!(parse(&non_parsable_program_id, &memo_instruction, &no_keys).is_err());
    }

    #[test]
    fn test_parse_memo() {
        let good_memo = "good memo".to_string();
        assert_eq!(
            parse_memo(&CompiledInstruction {
                program_id_index: 0,
                accounts: vec![],
                data: good_memo.as_bytes().to_vec(),
            })
            .unwrap(),
            Value::String(good_memo),
        );

        let bad_memo = vec![128u8];
        assert!(std::str::from_utf8(&bad_memo).is_err());
        assert!(parse_memo(&CompiledInstruction {
            program_id_index: 0,
            data: bad_memo,
            accounts: vec![],
        })
        .is_err(),);
    }
}
*/
