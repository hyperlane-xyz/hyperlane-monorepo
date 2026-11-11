use eyre::ContextCompat;

use hyperlane_base::settings::{ChainConf, ChainConnectionConf};
use hyperlane_sealevel::{ConnectionConf, SealevelSigner};

#[allow(clippy::panic)]
pub fn get_connection_conf(conf: &ChainConf) -> &ConnectionConf {
    match &conf.connection {
        ChainConnectionConf::Sealevel(connection_conf) => connection_conf,
        _ => panic!(),
    }
}

pub async fn create_signer(conf: &ChainConf) -> eyre::Result<SealevelSigner> {
    conf.signer
        .as_ref()
        .wrap_err("Signer is missing")?
        .build()
        .await
}

/// Returns a distinct configured identity signer, or None when absent or equal
/// to the payer. Legacy delivery deduplicates the same keys in SealevelMailbox.
pub async fn create_identity_signer(
    conf: &ChainConf,
    payer: &SealevelSigner,
) -> eyre::Result<Option<SealevelSigner>> {
    let Some(identity_conf) = &conf.identity else {
        return Ok(None);
    };
    let identity: SealevelSigner = identity_conf.build().await?;
    Ok((identity.pubkey() != payer.pubkey()).then_some(identity))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use hyperlane_base::settings::{ChainConf, ChainConnectionConf, SignerConf};
    use hyperlane_core::{
        config::OpSubmissionConfig, HyperlaneDomain, KnownHyperlaneDomain, ReorgPeriod,
        SubmitterType, H256,
    };
    use hyperlane_sealevel::{
        create_keypair as create_raw_keypair, SealevelKeypair, SealevelSigner,
        SealevelTransactionFormat,
    };
    use solana_sdk::signature::Signer;

    use super::create_identity_signer;

    fn sealevel_conf(identity: Option<SignerConf>) -> ChainConf {
        ChainConf {
            domain: HyperlaneDomain::Known(KnownHyperlaneDomain::SolanaMainnet),
            signer: Some(SignerConf::HexKey {
                key: Default::default(),
            }),
            ccs_signer: None,
            identity,
            submitter: SubmitterType::Lander,
            estimated_block_time: Duration::from_secs(1),
            reorg_period: ReorgPeriod::None,
            addresses: Default::default(),
            connection: ChainConnectionConf::Sealevel(hyperlane_sealevel::ConnectionConf {
                max_supported_transaction_version: 0,
                urls: vec![].into(),
                op_submission_config: OpSubmissionConfig::default(),
                native_token: Default::default(),
                priority_fee_oracle: Default::default(),
                transaction_submitter: Default::default(),
                mailbox_process_alts: SealevelTransactionFormat::Legacy,
                process_alt_overrides: vec![],
                ur_reveal: None,
            }),
            metrics_conf: Default::default(),
            index: Default::default(),
            confirmations: Default::default(),
            chain_id: Default::default(),
            ignore_reorg_reports: false,
            native_token: Default::default(),
        }
    }

    fn make_payer(seed: u8) -> SealevelSigner {
        let mut key = [0u8; 32];
        key[0] = seed;
        SealevelKeypair(create_raw_keypair(&H256::from(key)).unwrap()).into()
    }

    /// When `identity` is absent, returns `None` — matches `sealevel_identity_signer` behavior.
    #[tokio::test]
    async fn identity_absent_returns_none() {
        let payer = make_payer(1);
        let conf = sealevel_conf(None);
        let result = create_identity_signer(&conf, &payer).await.unwrap();
        assert!(result.is_none());
    }

    /// When `identity` key matches the payer, returns `None` (no extra co-signer needed).
    #[tokio::test]
    async fn identity_same_as_payer_returns_none() {
        let payer = make_payer(1);
        let key = H256::from([1u8; 32]);
        let conf = sealevel_conf(Some(SignerConf::HexKey { key: key.into() }));
        // payer seed=1 means key[0]=1; identity key is all-1s — they are different raw bytes
        // so build a payer that IS all-1s to trigger the dedup path
        let payer_all_ones: SealevelSigner =
            SealevelKeypair(create_raw_keypair(&key).unwrap()).into();
        let result = create_identity_signer(&conf, &payer_all_ones)
            .await
            .unwrap();
        assert!(result.is_none());
    }

    /// When `identity` differs from payer, returns `Some` with the correct pubkey.
    #[tokio::test]
    async fn identity_distinct_returns_signer() {
        let payer = make_payer(1);
        let identity_key = H256::from([2u8; 32]);
        let conf = sealevel_conf(Some(SignerConf::HexKey {
            key: identity_key.into(),
        }));
        let result = create_identity_signer(&conf, &payer)
            .await
            .unwrap()
            .unwrap();
        let expected_pubkey = SealevelKeypair(create_raw_keypair(&identity_key).unwrap()).pubkey();
        assert_eq!(result.pubkey(), expected_pubkey);
        assert_ne!(result.pubkey(), payer.pubkey());
    }
}
