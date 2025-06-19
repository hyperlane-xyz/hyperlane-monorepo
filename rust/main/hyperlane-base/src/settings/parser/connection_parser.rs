use eyre::eyre;
use hyperlane_sealevel::{
    HeliusPriorityFeeLevel, HeliusPriorityFeeOracleConfig, PriorityFeeOracleConfig,
};
use url::Url;

use h_eth::TransactionOverrides;

use hyperlane_core::config::{ConfigErrResultExt, OpSubmissionConfig};
use hyperlane_core::{
    config::ConfigParsingError, HyperlaneDomainProtocol, NativeToken, H256, utils::{hex_or_base58_to_h256},
};

use hyperlane_starknet as h_starknet;

use crate::settings::envs::*;
use crate::settings::ChainConnectionConf;

use super::{parse_base_and_override_urls, parse_cosmos_gas_price, ValueParser};

#[allow(clippy::question_mark)] // TODO: `rustc` 1.80.1 clippy issue
pub fn build_ethereum_connection_conf(
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    default_rpc_consensus_type: &str,
    operation_batch: OpSubmissionConfig,
) -> Option<ChainConnectionConf> {
    let Some(first_url) = rpcs.to_owned().clone().into_iter().next() else {
        return None;
    };
    let rpc_consensus_type = chain
        .chain(err)
        .get_opt_key("rpcConsensusType")
        .parse_string()
        .unwrap_or(default_rpc_consensus_type);

    let rpc_connection_conf = match rpc_consensus_type {
        "single" => Some(h_eth::RpcConnectionConf::Http { url: first_url }),
        "fallback" => Some(h_eth::RpcConnectionConf::HttpFallback {
            urls: rpcs.to_owned().clone(),
        }),
        "quorum" => Some(h_eth::RpcConnectionConf::HttpQuorum {
            urls: rpcs.to_owned().clone(),
        }),
        ty => Err(eyre!("unknown rpc consensus type `{ty}`"))
            .take_err(err, || &chain.cwp + "rpc_consensus_type"),
    };

    let transaction_overrides = chain
        .get_opt_key("transactionOverrides")
        .take_err(err, || &chain.cwp + "transaction_overrides")
        .flatten()
        .map(|value_parser| TransactionOverrides {
            gas_price: value_parser
                .chain(err)
                .get_opt_key("gasPrice")
                .parse_u256()
                .end(),
            gas_limit: value_parser
                .chain(err)
                .get_opt_key("gasLimit")
                .parse_u256()
                .end(),
            max_fee_per_gas: value_parser
                .chain(err)
                .get_opt_key("maxFeePerGas")
                .parse_u256()
                .end(),
            max_priority_fee_per_gas: value_parser
                .chain(err)
                .get_opt_key("maxPriorityFeePerGas")
                .parse_u256()
                .end(),

            min_gas_price: value_parser
                .chain(err)
                .get_opt_key("minGasPrice")
                .parse_u256()
                .end(),
            min_fee_per_gas: value_parser
                .chain(err)
                .get_opt_key("minFeePerGas")
                .parse_u256()
                .end(),
            min_priority_fee_per_gas: value_parser
                .chain(err)
                .get_opt_key("minPriorityFeePerGas")
                .parse_u256()
                .end(),

            gas_limit_multiplier_denominator: value_parser
                .chain(err)
                .get_opt_key("gasLimitMultiplierDenominator")
                .parse_u256()
                .end(),
            gas_limit_multiplier_numerator: value_parser
                .chain(err)
                .get_opt_key("gasLimitMultiplierNumerator")
                .parse_u256()
                .end(),

            gas_price_multiplier_denominator: value_parser
                .chain(err)
                .get_opt_key("gasPriceMultiplierDenominator")
                .parse_u256()
                .end(),
            gas_price_multiplier_numerator: value_parser
                .chain(err)
                .get_opt_key("gasPriceMultiplierNumerator")
                .parse_u256()
                .end(),

            gas_price_cap: value_parser
                .chain(err)
                .get_opt_key("gasPriceCap")
                .parse_u256()
                .end(),
        })
        .unwrap_or_default();

    Some(ChainConnectionConf::Ethereum(h_eth::ConnectionConf {
        rpc_connection: rpc_connection_conf?,
        transaction_overrides,
        op_submission_config: operation_batch,
    }))
}

pub fn build_cosmos_connection_conf(
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    operation_batch: OpSubmissionConfig,
) -> Option<ChainConnectionConf> {
    let mut local_err = ConfigParsingError::default();
    let grpcs =
        parse_base_and_override_urls(chain, "grpcUrls", "customGrpcUrls", "http", &mut local_err);

    let chain_id = chain
        .chain(&mut local_err)
        .get_key("chainId")
        .parse_string()
        .end()
        .or_else(|| {
            local_err.push(&chain.cwp + "chain_id", eyre!("Missing chain id for chain"));
            None
        });

    let prefix = chain
        .chain(err)
        .get_key("bech32Prefix")
        .parse_string()
        .end()
        .or_else(|| {
            local_err.push(
                &chain.cwp + "bech32Prefix",
                eyre!("Missing bech32 prefix for chain"),
            );
            None
        });

    let canonical_asset = if let Some(asset) = chain
        .chain(err)
        .get_opt_key("canonicalAsset")
        .parse_string()
        .end()
    {
        Some(asset.to_string())
    } else if let Some(hrp) = prefix {
        Some(format!("u{}", hrp))
    } else {
        local_err.push(
            &chain.cwp + "canonical_asset",
            eyre!("Missing canonical asset for chain"),
        );
        None
    };

    let gas_price = chain
        .chain(err)
        .get_opt_key("gasPrice")
        .and_then(parse_cosmos_gas_price)
        .end();

    let contract_address_bytes = chain
        .chain(err)
        .get_opt_key("contractAddressBytes")
        .parse_u64()
        .end();

    let native_token = parse_native_token(chain, err, 18);

    if !local_err.is_ok() {
        err.merge(local_err);
        None
    } else {
        Some(ChainConnectionConf::Cosmos(h_cosmos::ConnectionConf::new(
            grpcs,
            rpcs.to_owned(),
            chain_id.unwrap().to_string(),
            prefix.unwrap().to_string(),
            canonical_asset.unwrap(),
            gas_price.unwrap(),
            contract_address_bytes.unwrap().try_into().unwrap(),
            operation_batch,
            native_token,
        )))
    }
}

pub fn build_cosmos_native_connection_conf(
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    operation_batch: OpSubmissionConfig,
) -> Option<ChainConnectionConf> {
    let mut local_err = ConfigParsingError::default();
    let grpcs =
        parse_base_and_override_urls(chain, "grpcUrls", "customGrpcUrls", "http", &mut local_err);

    let chain_id = chain
        .chain(&mut local_err)
        .get_key("chainId")
        .parse_string()
        .end()
        .or_else(|| {
            local_err.push(&chain.cwp + "chain_id", eyre!("Missing chain id for chain"));
            None
        });

    let prefix = chain
        .chain(err)
        .get_key("bech32Prefix")
        .parse_string()
        .end()
        .or_else(|| {
            local_err.push(
                &chain.cwp + "bech32Prefix",
                eyre!("Missing bech32 prefix for chain"),
            );
            None
        });

    let canonical_asset = if let Some(asset) = chain
        .chain(err)
        .get_opt_key("canonicalAsset")
        .parse_string()
        .end()
    {
        Some(asset.to_string())
    } else if let Some(hrp) = prefix {
        Some(format!("u{}", hrp))
    } else {
        local_err.push(
            &chain.cwp + "canonical_asset",
            eyre!("Missing canonical asset for chain"),
        );
        None
    };

    let gas_price = chain
        .chain(err)
        .get_opt_key("gasPrice")
        .and_then(parse_cosmos_gas_price)
        .end();

    let gas_multiplier = chain
        .chain(err)
        .get_opt_key("gasMultiplier")
        .parse_f64()
        .end()
        .unwrap_or(1.8);

    let contract_address_bytes = chain
        .chain(err)
        .get_opt_key("contractAddressBytes")
        .parse_u64()
        .end();

    let native_token = parse_native_token(chain, err, 18);

    if !local_err.is_ok() {
        err.merge(local_err);
        None
    } else {
        let gas_price = gas_price.unwrap();
        let gas_price = h_cosmos_native::RawCosmosAmount {
            denom: gas_price.denom,
            amount: gas_price.amount,
        };

        Some(ChainConnectionConf::CosmosNative(
            h_cosmos_native::ConnectionConf::new(
                rpcs.to_owned(),
                grpcs,
                chain_id.unwrap().to_string(),
                prefix.unwrap().to_string(),
                canonical_asset.unwrap(),
                gas_price,
                gas_multiplier,
                contract_address_bytes.unwrap().try_into().unwrap(),
                operation_batch,
                native_token,
            ),
        ))
    }
}

pub fn build_kaspa_connection_conf(
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    operation_batch: OpSubmissionConfig,
) -> Option<ChainConnectionConf> {
    let escrow_address = chain
        .chain(err)
        .get_opt_key("escrowAddress")
        .parse_string()
        .end();

    let rest_url_s = chain
        .chain(err)
        .get_opt_key("kaspaRestUrl")
        .parse_string()
        .end()?;

    let rest_url = Url::parse(&rest_url_s).unwrap(); // TODO: avoid unwrap

    let validator_hosts: Vec<String> = chain
        .chain(err)
        .get_key("validatorHosts")
        .parse_string()
        .end()?
        .split(',')
        .map(|s| s.trim().to_string())
        .collect();

    let validator_ids: Vec<H256> = chain
        .chain(err)
        .get_key("validatorIDS")
        .parse_string()
        .end()?
        .split(',')
        .map(|s| hex_or_base58_to_h256(s).unwrap()) // TODO: avoid unwrap
        .collect();

    Some(ChainConnectionConf::Kaspa(
        dymension_kaspa::ConnectionConf::new(
            rest_url,
            escrow_address.unwrap().to_string(),
            validator_hosts,
            validator_ids,
        ),
    ))
}

fn build_sealevel_connection_conf(
    urls: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    operation_batch: OpSubmissionConfig,
) -> Option<ChainConnectionConf> {
    let mut local_err = ConfigParsingError::default();

    let native_token = parse_native_token(chain, err, 9);
    let priority_fee_oracle = parse_sealevel_priority_fee_oracle_config(chain, &mut local_err);
    let transaction_submitter = parse_transaction_submitter_config(chain, &mut local_err);

    if !local_err.is_ok() {
        err.merge(local_err);
        None
    } else {
        Some(ChainConnectionConf::Sealevel(h_sealevel::ConnectionConf {
            urls: urls.to_owned(),
            op_submission_config: operation_batch,
            native_token,
            priority_fee_oracle: priority_fee_oracle.unwrap(),
            transaction_submitter: transaction_submitter.unwrap(),
        }))
    }
}

fn parse_native_token(
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    default_decimals: u32,
) -> NativeToken {
    let native_token_decimals = chain
        .chain(err)
        .get_opt_key("nativeToken")
        .get_opt_key("decimals")
        .parse_u32()
        .unwrap_or(default_decimals);

    let native_token_denom = chain
        .chain(err)
        .get_opt_key("nativeToken")
        .get_opt_key("denom")
        .parse_string()
        .unwrap_or("");

    NativeToken {
        decimals: native_token_decimals,
        denom: native_token_denom.to_owned(),
    }
}

fn parse_sealevel_priority_fee_oracle_config(
    chain: &ValueParser,
    err: &mut ConfigParsingError,
) -> Option<PriorityFeeOracleConfig> {
    let value_parser = chain.chain(err).get_opt_key("priorityFeeOracle").end();

    let priority_fee_oracle = if let Some(value_parser) = value_parser {
        let oracle_type = value_parser
            .chain(err)
            .get_key("type")
            .parse_string()
            .end()
            .or_else(|| {
                err.push(
                    &value_parser.cwp + "type",
                    eyre!("Missing priority fee oracle type"),
                );
                None
            })
            .unwrap_or_default();

        match oracle_type {
            "constant" => {
                let fee = value_parser
                    .chain(err)
                    .get_key("fee")
                    .parse_u64()
                    .end()
                    .unwrap_or(0);
                Some(PriorityFeeOracleConfig::Constant(fee))
            }
            "helius" => {
                let fee_level = parse_helius_priority_fee_level(&value_parser, err);
                if !err.is_ok() {
                    return None;
                }
                let config = HeliusPriorityFeeOracleConfig {
                    url: value_parser
                        .chain(err)
                        .get_key("url")
                        .parse_from_str("Invalid url")
                        .end()
                        .unwrap(),
                    fee_level: fee_level.unwrap(),
                };
                Some(PriorityFeeOracleConfig::Helius(config))
            }
            _ => {
                err.push(
                    &value_parser.cwp + "type",
                    eyre!("Unknown priority fee oracle type"),
                );
                None
            }
        }
    } else {
        // If not specified at all, use default
        Some(PriorityFeeOracleConfig::default())
    };

    priority_fee_oracle
}

fn parse_helius_priority_fee_level(
    value_parser: &ValueParser,
    err: &mut ConfigParsingError,
) -> Option<HeliusPriorityFeeLevel> {
    let level = value_parser
        .chain(err)
        .get_opt_key("feeLevel")
        .parse_string()
        .end();

    if let Some(level) = level {
        match level.to_lowercase().as_str() {
            "recommended" => Some(HeliusPriorityFeeLevel::Recommended),
            "min" => Some(HeliusPriorityFeeLevel::Min),
            "low" => Some(HeliusPriorityFeeLevel::Low),
            "medium" => Some(HeliusPriorityFeeLevel::Medium),
            "high" => Some(HeliusPriorityFeeLevel::High),
            "veryhigh" => Some(HeliusPriorityFeeLevel::VeryHigh),
            "unsafemax" => Some(HeliusPriorityFeeLevel::UnsafeMax),
            _ => {
                err.push(
                    &value_parser.cwp + "fee_level",
                    eyre!("Unknown priority fee level"),
                );
                None
            }
        }
    } else {
        // If not specified at all, use the default
        Some(HeliusPriorityFeeLevel::default())
    }
}

fn parse_transaction_submitter_config(
    chain: &ValueParser,
    err: &mut ConfigParsingError,
) -> Option<h_sealevel::config::TransactionSubmitterConfig> {
    let submitter_type = chain
        .chain(err)
        .get_opt_key("transactionSubmitter")
        .get_opt_key("type")
        .parse_string()
        .end();

    if let Some(submitter_type) = submitter_type {
        match submitter_type.to_lowercase().as_str() {
            "rpc" => {
                let urls: Vec<String> = chain
                    .chain(err)
                    .get_opt_key("transactionSubmitter")
                    .get_opt_key("urls")
                    .parse_string()
                    .map(|str| str.split(",").map(|s| s.to_owned()).collect())
                    .unwrap_or_default();
                Some(h_sealevel::config::TransactionSubmitterConfig::Rpc { urls })
            }
            "jito" => {
                let urls: Vec<String> = chain
                    .chain(err)
                    .get_opt_key("transactionSubmitter")
                    .get_opt_key("urls")
                    .parse_string()
                    .map(|str| str.split(",").map(|s| s.to_owned()).collect())
                    .unwrap_or_default();
                Some(h_sealevel::config::TransactionSubmitterConfig::Jito { urls })
            }
            _ => {
                err.push(
                    &chain.cwp + "transaction_submitter.type",
                    eyre!("Unknown transaction submitter type"),
                );
                None
            }
        }
    } else {
        // If not specified at all, use default
        Some(h_sealevel::config::TransactionSubmitterConfig::default())
    }
}

pub fn build_connection_conf(
    domain_protocol: HyperlaneDomainProtocol,
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    default_rpc_consensus_type: &str,
    operation_batch: OpSubmissionConfig,
) -> Option<ChainConnectionConf> {
    match domain_protocol {
        HyperlaneDomainProtocol::Ethereum => build_ethereum_connection_conf(
            rpcs,
            chain,
            err,
            default_rpc_consensus_type,
            operation_batch,
        ),
        HyperlaneDomainProtocol::Fuel => rpcs
            .iter()
            .next()
            .map(|url| ChainConnectionConf::Fuel(h_fuel::ConnectionConf { url: url.clone() })),
        HyperlaneDomainProtocol::Sealevel => {
            let urls = rpcs.to_vec();
            build_sealevel_connection_conf(&urls, chain, err, operation_batch)
        }
        HyperlaneDomainProtocol::Cosmos => {
            build_cosmos_connection_conf(rpcs, chain, err, operation_batch)
        }
        HyperlaneDomainProtocol::Starknet => rpcs.iter().next().map(|url| {
            ChainConnectionConf::Starknet(h_starknet::ConnectionConf { url: url.clone() })
        }),
        HyperlaneDomainProtocol::CosmosNative => {
            build_cosmos_native_connection_conf(rpcs, chain, err, operation_batch)
        }
        HyperlaneDomainProtocol::Kaspa => {
            build_kaspa_connection_conf(rpcs, chain, err, operation_batch)
        }
    }
}
