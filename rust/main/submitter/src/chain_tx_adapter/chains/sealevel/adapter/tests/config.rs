use std::num::NonZeroU32;
use std::time::Duration;

use hyperlane_base::settings::{ChainConf, ChainConnectionConf, SignerConf};
use hyperlane_core::config::OperationBatchConfig;
use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, ReorgPeriod, SubmitterType};

use crate::chain_tx_adapter::chains::sealevel::adapter::tests::common::adapter_config;
use crate::chain_tx_adapter::AdaptsChain;

#[test]
fn test_configuration_fields() {
    // given
    let expected_estimated_block_time = Duration::from_secs_f64(2.6);
    let expected_max_batch_size = 43;
    let expected_reorg_period = ReorgPeriod::Blocks(NonZeroU32::new(42).unwrap());

    let conf = ChainConf {
        domain: HyperlaneDomain::Known(KnownHyperlaneDomain::SolanaMainnet),
        signer: Some(SignerConf::HexKey {
            key: Default::default(),
        }),
        submitter: SubmitterType::Lander,
        estimated_block_time: expected_estimated_block_time.clone(),
        reorg_period: expected_reorg_period.clone(),
        addresses: Default::default(),
        connection: ChainConnectionConf::Sealevel(hyperlane_sealevel::ConnectionConf {
            urls: vec![],
            operation_batch: OperationBatchConfig {
                batch_contract_address: None,
                max_batch_size: expected_max_batch_size,
            },
            native_token: Default::default(),
            priority_fee_oracle: Default::default(),
            transaction_submitter: Default::default(),
        }),
        metrics_conf: Default::default(),
        index: Default::default(),
    };
    let adapter = adapter_config(conf);

    // when
    let estimated_block_time = adapter.estimated_block_time();
    let max_batch_size = adapter.max_batch_size();
    let reorg_period = adapter.reorg_period.clone();

    // then
    assert_eq!(estimated_block_time, &expected_estimated_block_time);
    assert_eq!(max_batch_size, expected_max_batch_size);
    assert_eq!(reorg_period, expected_reorg_period);
}
