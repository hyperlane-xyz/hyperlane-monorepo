use crate::cli::cmd::{ExecuteCliCmd, QueryCmd};
use crate::cli::matching_list_filter::filter_list::MatchingListFilter;
use crate::cli::matching_list_filter::read::ReadMatchingList;
use crate::cli::output::json::JsonOutput;
use crate::cli::output::table::TableOutput;
use crate::cli::output::OutputWriter;
use async_trait::async_trait;
use colored::Colorize;
use hyperlane_core::HyperlaneMessage;
use std::error::Error;

#[async_trait]
impl ExecuteCliCmd for QueryCmd {
    async fn execute(&self) -> Result<(), Box<dyn Error>> {
        println!(
            "{}",
            format!("Retrieving the current {}...", "block height".cyan().bold())
                .yellow()
                .bold()
        );

        let message_indexer = match self.client_conf.build_message_indexer().await {
            Ok(result) => result,
            Err(err) => {
                return Err(
                    format!("Failed to resolve message indexer got={}", err.to_string()).into(),
                )
            }
        };

        let end_block = match message_indexer.get_finalized_block_number().await {
            Ok(result) => result,
            Err(err) => {
                return Err(format!(
                    "Failed to fetch the last block number got={}",
                    err.to_string()
                )
                .into())
            }
        };

        let result = ReadMatchingList {
            file_name: self.matching_list_file.clone(),
        }
        .read()
        .await;
        let matching_list = match result {
            Ok(result) => result,
            Err(err) => {
                return Err(format!(
                    "Could not open the matching list file got={}",
                    err.to_string()
                )
                .into())
            }
        };

        let start_block = match self.block_depth {
            Some(value) => {
                if value >= end_block {
                    return Err(
                        "Block depth cannot be more than or equal to the last block number".into(),
                    );
                }
                end_block - value
            }
            None => end_block - 10000,
        };

        println!(
            "{}",
            format!(
                "Searching blocks from {} to {} (HEAD)...",
                start_block.to_string().cyan().bold(),
                end_block.to_string().cyan().bold()
            )
            .yellow()
            .bold()
        );

        let logs_result = match message_indexer.fetch_logs(start_block, end_block).await {
            Ok(result) => result,
            Err(err) => {
                return Err(
                    format!("Failed to fetch the mailbox logs got={}", err.to_string()).into(),
                )
            }
        };

        let messages: Vec<HyperlaneMessage> = logs_result.into_iter().map(|(msg, _)| msg).collect();

        let filtered_messages = match matching_list {
            None => messages,
            Some(matching_list) => MatchingListFilter {
                matching_list,
                messages,
            }
            .filter_messages(),
        };

        println!();
        println!("{}", "Finished".green().underline());
        println!(
            "{}",
            format!(
                "Query completed with {} results",
                filtered_messages.len().to_string().cyan().bold()
            )
            .green()
            .bold()
        );

        Ok(match self.print_output_type.as_str() {
            "json" => JsonOutput {
                messages: filtered_messages,
            }
            .print(),
            _ => TableOutput {
                messages: filtered_messages,
            }
            .print(),
        })
    }
}
