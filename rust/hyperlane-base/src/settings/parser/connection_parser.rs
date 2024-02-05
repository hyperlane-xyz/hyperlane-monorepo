use eyre::eyre;
use hyperlane_core::config::ConfigErrResultExt;
use hyperlane_core::{config::ConfigParsingError, HyperlaneDomainProtocol};
use url::Url;

use crate::settings::envs::*;
use crate::settings::ChainConnectionConf;

use super::{parse_cosmos_gas_price, ValueParser};

pub fn build_ethereum_connection_conf(
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    default_rpc_consensus_type: &str,
) -> Option<ChainConnectionConf> {
    let Some(first_url) = rpcs.to_owned().clone().into_iter().next() else {
        return None;
    };
    let rpc_consensus_type = chain
        .chain(err)
        .get_opt_key("rpcConsensusType")
        .parse_string()
        .unwrap_or(default_rpc_consensus_type);

    match rpc_consensus_type {
        "single" => Some(h_eth::ConnectionConf::Http { url: first_url }),
        "fallback" => Some(h_eth::ConnectionConf::HttpFallback {
            urls: rpcs.to_owned().clone(),
        }),
        "quorum" => Some(h_eth::ConnectionConf::HttpQuorum {
            urls: rpcs.to_owned().clone(),
        }),
        ty => Err(eyre!("unknown rpc consensus type `{ty}`"))
            .take_err(err, || &chain.cwp + "rpc_consensus_type"),
    }
    .map(ChainConnectionConf::Ethereum)
}

pub fn build_swisstronik_connection_conf(
    rpcs: &[Url],
    _chain: &ValueParser,
) -> Option<ChainConnectionConf> {
    let Some(first_url) = rpcs.to_owned().clone().into_iter().next() else {
        return None;
    };

    let connection_conf = h_swisstronik::ConnectionConf::Http { url: first_url };
    Some(ChainConnectionConf::Swisstronik(connection_conf))
}

pub fn build_cosmos_connection_conf(
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
) -> Option<ChainConnectionConf> {
    let mut local_err = ConfigParsingError::default();

    let grpc_url = chain
        .chain(&mut local_err)
        .get_key("grpcUrl")
        .parse_string()
        .end()
        .or_else(|| {
            local_err.push(
                &chain.cwp + "grpc_url",
                eyre!("Missing grpc definitions for chain"),
            );
            None
        });

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

    if !local_err.is_ok() {
        err.merge(local_err);
        None
    } else {
        Some(ChainConnectionConf::Cosmos(h_cosmos::ConnectionConf::new(
            grpc_url.unwrap().to_string(),
            rpcs.first().unwrap().to_string(),
            chain_id.unwrap().to_string(),
            prefix.unwrap().to_string(),
            canonical_asset.unwrap(),
            gas_price.unwrap(),
            contract_address_bytes.unwrap().try_into().unwrap(),
        )))
    }
}

pub fn build_connection_conf(
    domain_protocol: HyperlaneDomainProtocol,
    rpcs: &[Url],
    chain: &ValueParser,
    err: &mut ConfigParsingError,
    default_rpc_consensus_type: &str,
) -> Option<ChainConnectionConf> {
    match domain_protocol {
        HyperlaneDomainProtocol::Ethereum => {
            build_ethereum_connection_conf(rpcs, chain, err, default_rpc_consensus_type)
        },
        HyperlaneDomainProtocol::Swisstronik => {
            build_swisstronik_connection_conf(rpcs, chain)
        },
        HyperlaneDomainProtocol::Fuel => rpcs
            .iter()
            .next()
            .map(|url| ChainConnectionConf::Fuel(h_fuel::ConnectionConf { url: url.clone() })),
        HyperlaneDomainProtocol::Sealevel => rpcs.iter().next().map(|url| {
            ChainConnectionConf::Sealevel(h_sealevel::ConnectionConf { url: url.clone() })
        }),
        HyperlaneDomainProtocol::Cosmos => build_cosmos_connection_conf(rpcs, chain, err),
    }
}
