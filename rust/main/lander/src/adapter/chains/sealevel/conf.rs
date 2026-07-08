use eyre::{bail, ContextCompat};

use hyperlane_base::settings::{ChainConf, ChainConnectionConf, SignerConf};
use hyperlane_sealevel::{create_keypair as create_raw_keypair, ConnectionConf, SealevelKeypair};
use solana_sdk::signature::Signer;

#[allow(clippy::panic)]
pub fn get_connection_conf(conf: &ChainConf) -> &ConnectionConf {
    match &conf.connection {
        ChainConnectionConf::Sealevel(connection_conf) => connection_conf,
        _ => panic!(),
    }
}

pub fn create_keypair(conf: &ChainConf) -> eyre::Result<SealevelKeypair> {
    let signer = conf.signer.as_ref().wrap_err("Signer is missing")?;
    let key = match signer {
        SignerConf::HexKey { key } => key,
        _ => bail!("Sealevel supports only hex key"),
    };
    let keypair = create_raw_keypair(key)?;
    Ok(SealevelKeypair(keypair))
}

/// Returns the identity keypair if configured and distinct from the payer, otherwise `None`.
/// Used as a co-signer for TrustedRelayer ISMs.
///
/// Semantics mirror `ChainConf::sealevel_identity_signer` in `hyperlane-base`: when `identity`
/// is absent both functions return `None`; when present both derive the key from `SignerConf`.
/// Any change to supported `SignerConf` variants here must be mirrored there, and vice versa.
pub fn create_identity_keypair(
    conf: &ChainConf,
    payer: &SealevelKeypair,
) -> eyre::Result<Option<SealevelKeypair>> {
    let identity_conf = match &conf.identity {
        Some(c) => c,
        None => return Ok(None),
    };
    let key = match identity_conf {
        SignerConf::HexKey { key } => key,
        _ => bail!("Sealevel supports only hex key for identity"),
    };
    let keypair = SealevelKeypair(create_raw_keypair(key)?);
    if keypair.pubkey() == payer.pubkey() {
        return Ok(None);
    }
    Ok(Some(keypair))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use hyperlane_base::settings::{ChainConf, ChainConnectionConf, SignerConf};
    use hyperlane_core::{
        config::OpSubmissionConfig, HyperlaneDomain, KnownHyperlaneDomain, ReorgPeriod,
        SubmitterType, H256,
    };
    use hyperlane_sealevel::{create_keypair as create_raw_keypair, SealevelKeypair};
    use solana_sdk::signature::Signer;

    use super::create_identity_keypair;

    fn sealevel_conf(identity: Option<SignerConf>) -> ChainConf {
        ChainConf {
            domain: HyperlaneDomain::Known(KnownHyperlaneDomain::SolanaMainnet),
            signer: Some(SignerConf::HexKey {
                key: Default::default(),
            }),
            identity,
            submitter: SubmitterType::Lander,
            estimated_block_time: Duration::from_secs(1),
            reorg_period: ReorgPeriod::None,
            addresses: Default::default(),
            connection: ChainConnectionConf::Sealevel(hyperlane_sealevel::ConnectionConf {
                urls: vec![],
                op_submission_config: OpSubmissionConfig::default(),
                native_token: Default::default(),
                priority_fee_oracle: Default::default(),
                transaction_submitter: Default::default(),
                mailbox_process_alt: None,
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

    fn make_payer(seed: u8) -> SealevelKeypair {
        let mut key = [0u8; 32];
        key[0] = seed;
        SealevelKeypair(create_raw_keypair(&H256::from(key)).unwrap())
    }

    /// When `identity` is absent, returns `None` — matches `sealevel_identity_signer` behavior.
    #[test]
    fn identity_absent_returns_none() {
        let payer = make_payer(1);
        let conf = sealevel_conf(None);
        let result = create_identity_keypair(&conf, &payer).unwrap();
        assert!(result.is_none());
    }

    /// When `identity` key matches the payer, returns `None` (no extra co-signer needed).
    #[test]
    fn identity_same_as_payer_returns_none() {
        let payer = make_payer(1);
        let key = H256::from([1u8; 32]);
        let conf = sealevel_conf(Some(SignerConf::HexKey { key }));
        // payer seed=1 means key[0]=1; identity key is all-1s — they are different raw bytes
        // so build a payer that IS all-1s to trigger the dedup path
        let payer_all_ones = SealevelKeypair(create_raw_keypair(&key).unwrap());
        let result = create_identity_keypair(&conf, &payer_all_ones).unwrap();
        assert!(result.is_none());
    }

    /// When `identity` differs from payer, returns `Some` with the correct pubkey.
    #[test]
    fn identity_distinct_returns_keypair() {
        let payer = make_payer(1);
        let identity_key = H256::from([2u8; 32]);
        let conf = sealevel_conf(Some(SignerConf::HexKey { key: identity_key }));
        let result = create_identity_keypair(&conf, &payer).unwrap().unwrap();
        let expected_pubkey = SealevelKeypair(create_raw_keypair(&identity_key).unwrap()).pubkey();
        assert_eq!(result.pubkey(), expected_pubkey);
        assert_ne!(result.pubkey(), payer.pubkey());
    }
}
