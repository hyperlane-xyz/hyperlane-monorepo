use eyre::{bail, ContextCompat};

use hyperlane_base::settings::{ChainConf, SignerConf};
use hyperlane_radix::RadixSigner;

pub fn create_signer(conf: &ChainConf) -> eyre::Result<RadixSigner> {
    let signer_conf = conf.signer.as_ref().wrap_err("Signer is missing")?;
    if let SignerConf::RadixKey { key, suffix } = signer_conf {
        Ok(hyperlane_radix::RadixSigner::new(
            key.as_bytes().to_vec(),
            suffix.to_string(),
        )?)
    } else {
        bail!(format!("{conf:?} key is not supported by radix"));
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, time::Duration};

    use ethers_prometheus::middleware::PrometheusMiddlewareConf;
    use hyperlane_ethereum::{RpcConnectionConf, TransactionOverrides};
    use scrypto::network::NetworkDefinition;

    use hyperlane_base::settings::{
        ChainConf, ChainConnectionConf, CoreContractAddresses, IndexSettings, SignerConf,
    };
    use hyperlane_core::{
        config::OpSubmissionConfig, HyperlaneDomain, KnownHyperlaneDomain, ReorgPeriod,
        SubmitterType, H256,
    };
    use url::Url;

    use super::*;

    fn create_chain_conf(
        domain: HyperlaneDomain,
        signer: Option<SignerConf>,
        connection: ChainConnectionConf,
    ) -> ChainConf {
        ChainConf {
            domain,
            signer,
            submitter: SubmitterType::Lander,
            gas_estimator: SubmitterType::Lander,
            estimated_block_time: Duration::from_secs(1),
            reorg_period: ReorgPeriod::None,
            addresses: CoreContractAddresses::default(),
            connection,
            metrics_conf: PrometheusMiddlewareConf {
                contracts: HashMap::new(),
                chain: None,
            },
            index: IndexSettings::default(),
            ignore_reorg_reports: false,
        }
    }

    #[test]
    fn test_create_signer_happy_path() {
        let conf = create_chain_conf(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Radix),
            Some(SignerConf::HexKey { key: H256::zero() }),
            ChainConnectionConf::Radix(hyperlane_radix::ConnectionConf {
                core: Vec::new(),
                gateway: Vec::new(),
                network: NetworkDefinition::mainnet(),
            }),
        );

        let res = create_signer(&conf);
        assert!(res.is_err())
    }

    #[test]
    fn test_create_signer_no_signer() {
        let conf = create_chain_conf(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Radix),
            None,
            ChainConnectionConf::Radix(hyperlane_radix::ConnectionConf {
                core: Vec::new(),
                gateway: Vec::new(),
                network: NetworkDefinition::mainnet(),
            }),
        );

        let res = create_signer(&conf);
        assert!(res.is_err())
    }

    #[test]
    fn test_create_signer_wrong_conf() {
        let conf = create_chain_conf(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Radix),
            Some(SignerConf::Node),
            ChainConnectionConf::Ethereum(hyperlane_ethereum::ConnectionConf {
                rpc_connection: RpcConnectionConf::Http {
                    url: Url::parse("https://hyperlane.xyz").expect("Failed to parse url"),
                },
                transaction_overrides: TransactionOverrides::default(),
                op_submission_config: OpSubmissionConfig::default(),
                consider_null_transaction_receipt: false,
            }),
        );

        let res = create_signer(&conf);
        assert!(res.is_err())
    }
}
