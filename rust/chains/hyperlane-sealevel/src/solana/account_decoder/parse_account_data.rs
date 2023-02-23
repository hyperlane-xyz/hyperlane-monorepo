use {
    crate::solana::account_decoder::{
        parse_bpf_loader::parse_bpf_upgradeable_loader,
    //     parse_config::parse_config,
    //     parse_nonce::parse_nonce,
    //     parse_stake::parse_stake,
    //     parse_sysvar::parse_sysvar,
    //     parse_token::{parse_token, spl_token_2022_id, spl_token_id},
    //     parse_vote::parse_vote,
    },
    inflector::Inflector,
    serde_json::Value,
    crate::solana::pubkey::Pubkey,
    // solana_sdk::{instruction::InstructionError, pubkey::Pubkey, stake, system_program, sysvar},
    std::collections::HashMap,
    thiserror::Error,
};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

lazy_static::lazy_static! {
    static ref BPF_UPGRADEABLE_LOADER_PROGRAM_ID: Pubkey =
        Pubkey::from_str("BPFLoaderUpgradeab1e11111111111111111111111").unwrap();
    static ref CONFIG_PROGRAM_ID: Pubkey =
        Pubkey::from_str("Config1111111111111111111111111111111111111").unwrap();
    static ref STAKE_PROGRAM_ID: Pubkey =
        Pubkey::from_str("Stake11111111111111111111111111111111111111").unwrap();
    static ref SYSTEM_PROGRAM_ID: Pubkey =
        Pubkey::from_str("11111111111111111111111111111111").unwrap();
    static ref SYSVAR_PROGRAM_ID: Pubkey =
        Pubkey::from_str("Sysvar1111111111111111111111111111111111111").unwrap();
    static ref VOTE_PROGRAM_ID: Pubkey =
        Pubkey::from_str("Vote111111111111111111111111111111111111111").unwrap();
    pub static ref PARSABLE_PROGRAM_IDS: HashMap<Pubkey, ParsableAccount> = {
        let mut m = HashMap::new();
        m.insert(
            *BPF_UPGRADEABLE_LOADER_PROGRAM_ID,
            ParsableAccount::BpfUpgradeableLoader,
        );
        m.insert(*CONFIG_PROGRAM_ID, ParsableAccount::Config);
        m.insert(*SYSTEM_PROGRAM_ID, ParsableAccount::Nonce);
        m.insert(
            Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap(),
            ParsableAccount::SplToken
        );
        m.insert(
            Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap(),
            ParsableAccount::SplToken2022
        );
        m.insert(*STAKE_PROGRAM_ID, ParsableAccount::Stake);
        m.insert(*SYSVAR_PROGRAM_ID, ParsableAccount::Sysvar);
        m.insert(*VOTE_PROGRAM_ID, ParsableAccount::Vote);
        m
    };
}

#[derive(Error, Debug)]
pub enum ParseAccountError {
    #[error("{0:?} account not parsable")]
    AccountNotParsable(ParsableAccount),

    #[error("Program not parsable")]
    ProgramNotParsable,

    #[error("Additional data required to parse: {0}")]
    AdditionalDataMissing(String),

    // #[error("Instruction error")]
    // InstructionError(#[from] InstructionError),

    #[error("Serde json error")]
    SerdeJsonError(#[from] serde_json::error::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedAccount {
    pub program: String,
    pub parsed: Value,
    pub space: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParsableAccount {
    BpfUpgradeableLoader,
    Config,
    Nonce,
    SplToken,
    SplToken2022,
    Stake,
    Sysvar,
    Vote,
}

#[derive(Default)]
pub struct AccountAdditionalData {
    pub spl_token_decimals: Option<u8>,
}

pub fn parse_account_data(
    pubkey: &Pubkey,
    program_id: &Pubkey,
    data: &[u8],
    additional_data: Option<AccountAdditionalData>,
) -> Result<ParsedAccount, ParseAccountError> {
    let program_name = PARSABLE_PROGRAM_IDS
        .get(program_id)
        .ok_or(ParseAccountError::ProgramNotParsable)?;
    let additional_data = additional_data.unwrap_or_default();
    let parsed_json = match program_name {
        ParsableAccount::BpfUpgradeableLoader => {
            serde_json::to_value(parse_bpf_upgradeable_loader(data)?)?
        }
        ParsableAccount::Config => {
            // This one is validator stake config? don't think we need it...
            unimplemented!()
            // serde_json::to_value(parse_config(data, pubkey)?)?
        },
        ParsableAccount::Nonce => {
            unimplemented!()
            // serde_json::to_value(parse_nonce(data)?)?
        },
        ParsableAccount::SplToken | ParsableAccount::SplToken2022 => {
            unimplemented!()
            // serde_json::to_value(parse_token(data, additional_data.spl_token_decimals)?)?
        }
        ParsableAccount::Stake => {
            unimplemented!()
            // serde_json::to_value(parse_stake(data)?)?
        },
        ParsableAccount::Sysvar => {
            unimplemented!()
            // serde_json::to_value(parse_sysvar(data, pubkey)?)?
        },
        ParsableAccount::Vote => {
            unimplemented!()
            // serde_json::to_value(parse_vote(data)?)?
        },
    };
    Ok(ParsedAccount {
        program: format!("{:?}", program_name).to_kebab_case(),
        parsed: parsed_json,
        space: data.len() as u64,
    })
}

/*
#[cfg(test)]
mod test {
    use {
        super::*,
        solana_sdk::nonce::{
            state::{Data, Versions},
            State,
        },
        solana_vote_program::vote_state::{VoteState, VoteStateVersions},
    };

    #[test]
    fn test_parse_account_data() {
        let account_pubkey = solana_sdk::pubkey::new_rand();
        let other_program = solana_sdk::pubkey::new_rand();
        let data = vec![0; 4];
        assert!(parse_account_data(&account_pubkey, &other_program, &data, None).is_err());

        let vote_state = VoteState::default();
        let mut vote_account_data: Vec<u8> = vec![0; VoteState::size_of()];
        let versioned = VoteStateVersions::new_current(vote_state);
        VoteState::serialize(&versioned, &mut vote_account_data).unwrap();
        let parsed = parse_account_data(
            &account_pubkey,
            &solana_vote_program::id(),
            &vote_account_data,
            None,
        )
        .unwrap();
        assert_eq!(parsed.program, "vote".to_string());
        assert_eq!(parsed.space, VoteState::size_of() as u64);

        let nonce_data = Versions::new(State::Initialized(Data::default()));
        let nonce_account_data = bincode::serialize(&nonce_data).unwrap();
        let parsed = parse_account_data(
            &account_pubkey,
            &system_program::id(),
            &nonce_account_data,
            None,
        )
        .unwrap();
        assert_eq!(parsed.program, "nonce".to_string());
        assert_eq!(parsed.space, State::size() as u64);
    }
}
*/
