#![allow(dead_code)]
#![allow(unused_variables)]
#![allow(unused_imports)]

use std::{fmt::Debug, str::FromStr, vec};

use super::CommandParams;
use crate::arg::QueryArgs;
use crate::arg::*;
use color_eyre::{eyre::eyre, Report, Result};
use hyperlane_core::H256;
use relayer::settings::{
    matching_list::{self, Filter, MatchItem},
    MatchingList,
};

#[derive(Debug, PartialEq)]
pub struct QueryParams {
    pub criteria: MatchingList,
    pub debug: bool,
    pub start_block: i32,
    pub end_block: i32,
}

impl TryFrom<QueryArgs> for QueryParams {
    type Error = Report;

    fn try_from(args: QueryArgs) -> Result<Self> {
        let matching_list = matching_list_from_args(&args)?;

        Ok(Self {
            criteria: matching_list,
            debug: args.debug,
            start_block: args.start,
            end_block: args.end,
        })
    }
}

fn matching_list_from_args(args: &QueryArgs) -> Result<MatchingList> {
    // TODO: Add loading matching criteria from file.
    let criteria = &args.criteria;

    matching_list_from_criteria(criteria)
}

pub fn matching_list_from_criteria(criteria: &Vec<String>) -> Result<MatchingList> {
    let mut matching_list: Vec<MatchItem> = vec![];
    for criteria in criteria {
        let criteria = criteria.trim();
        if criteria.is_empty() {
            continue; // Do not add or try to parse empty match criteria
        }
        if criteria.starts_with('[') {
            // JSON array of matching criteria
            if let MatchingList(Some(list)) = serde_json::from_str(criteria)? {
                matching_list.extend(list);
            }
        } else if criteria.starts_with('{') {
            // JSON individual matching criteria
            matching_list.push(serde_json::from_str(criteria)?);
        } else {
            // CSV (semicolon separated CSV parts) individual matching criteria
            matching_list.push(MatchItem::from_csv(criteria)?);
        }
    }

    Ok(MatchingList::from_elements(matching_list))
}

impl TryFrom<CommandArgs> for CommandParams {
    type Error = Report;

    fn try_from(args: CommandArgs) -> Result<Self> {
        Ok(match args {
            CommandArgs::Dispatch(args) => Self::Dispatch(args.try_into()?),
            CommandArgs::Pay(args) => Self::Pay(args.try_into()?),
            CommandArgs::Query(args) => Self::Query(args.try_into()?),
            CommandArgs::Connect(_) => Self::Connect,
        })
    }
}
