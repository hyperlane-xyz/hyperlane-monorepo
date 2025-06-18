use std::{num::NonZeroU32, time::Duration};

use hyperlane_base::settings::{ChainConf, ChainConnectionConf, SignerConf};
use hyperlane_core::{
    config::OpSubmissionConfig, HyperlaneDomain, KnownHyperlaneDomain, ReorgPeriod, SubmitterType,
};

use crate::adapter::{chains::sealevel::adapter::tests::tests_common::adapter_config, AdaptsChain};

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
            op_submission_config: OpSubmissionConfig {
                batch_contract_address: None,
                max_batch_size: expected_max_batch_size,
                ..Default::default()
            },
            native_token: Default::default(),
            priority_fee_oracle: Default::default(),
            transaction_submitter: Default::default(),
        }),
        metrics_conf: Default::default(),
        index: Default::default(),
        ignore_reorg_reports: false,
    };
    let adapter = adapter_config(conf);

    // when
    let estimated_block_time = adapter.estimated_block_time();
    let max_batch_size = adapter.max_batch_size();

    // then
    assert_eq!(estimated_block_time, &expected_estimated_block_time);
    assert_eq!(max_batch_size, expected_max_batch_size);
}
