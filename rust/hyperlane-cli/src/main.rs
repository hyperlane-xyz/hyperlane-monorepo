use clap::Parser;
use colored::*;
use std::error::Error;
use url::Url;

use hyperlane_core::{HyperlaneDomain, HyperlaneDomainProtocol, H256};
use hyperlane_ethereum::{self as h_eth};

use crate::cli::args::parse::ParseEthPrimitives;
use crate::cli::args::{Args, Commands};
use crate::cli::cmd::{ExecuteCliCmd, QueryCmd, SendCmd};
use hyperlane_base::clients::ClientConf;
use hyperlane_base::{ChainConnectionConf, CoreContractAddresses, SignerConf};

pub mod cli;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    if let Err(err) = run().await {
        let final_error = format!("{}", err.to_string().red().bold());
        println!("{}", "Failed".red().underline());
        eprintln!("{}", final_error.red());
        std::process::exit(1);
    }

    Ok(())
}

async fn run() -> Result<(), Box<dyn Error>> {
    let args = Args::parse();

    let mailbox_address = match args
        .mailbox_address
        .parse_address("Mailbox address".to_string())
    {
        Ok(result) => result,
        Err(err) => return Err(err),
    };

    let domain =
        HyperlaneDomain::from_domain_id(args.origin_chain, HyperlaneDomainProtocol::Ethereum);

    let addresses = CoreContractAddresses {
        mailbox: mailbox_address,
        interchain_gas_paymaster: H256::zero(),
        validator_announce: H256::zero(),
    };
    let connection = ChainConnectionConf::Ethereum(h_eth::ConnectionConf::Http {
        url: Url::parse(&args.rpc_url.to_string()).ok().unwrap(),
    });

    return match args.command {
        Commands::Send {
            address_destination,
            chain_destination,
            bytes,
            private_key,
        } => {
            let private_key_bytes = match private_key.parse_private_key("Private key".to_string()) {
                Ok(result) => result,
                Err(err) => return Err(err),
            };

            let signer = SignerConf::HexKey {
                key: H256::from_slice(&private_key_bytes),
            };

            let client_conf = ClientConf {
                domain,
                signer: Some(signer),
                addresses,
                connection,
                finality_blocks: 12,
            };

            SendCmd {
                address_destination,
                chain_destination,
                bytes,
                client_conf,
            }
            .execute()
            .await
        }
        Commands::Query {
            matching_list_file,
            print_output_type,
            block_depth,
        } => {
            let client_conf = ClientConf {
                domain,
                signer: None,
                addresses,
                connection,
                finality_blocks: 12,
            };

            QueryCmd {
                matching_list_file,
                print_output_type,
                block_depth,
                client_conf,
            }
            .execute()
            .await
        }
    };
}
