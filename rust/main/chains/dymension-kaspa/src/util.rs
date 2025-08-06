use hyperlane_core::{HyperlaneDomain, HyperlaneDomainProtocol};

use dym_kas_core::wallet::Network;
use dym_kas_hardcode::hl::{
    HL_DOMAIN_DYM_LOCAL, HL_DOMAIN_DYM_MAINNET, HL_DOMAIN_DYM_PLAYGROUND_202507,
    HL_DOMAIN_DYM_PLAYGROUND_202507_LEGACY, HL_DOMAIN_DYM_TESTNET_BLUMBUS, HL_DOMAIN_KASPA_MAINNET,
    HL_DOMAIN_KASPA_TEST10, HL_DOMAIN_KASPA_TEST10_LEGACY,
};

/// is it a kaspa domain?
pub fn is_kas(d: &HyperlaneDomain) -> bool {
    matches!(
        d,
        HyperlaneDomain::Unknown {
            domain_protocol: HyperlaneDomainProtocol::Kaspa,
            ..
        }
    )
}

/// is it a dym domain?
pub fn is_dym(d: &HyperlaneDomain) -> bool {
    HUB_DOMAINS.contains(&d.id())
}

/// domain to kas network
pub fn domain_to_kas_network(d: &HyperlaneDomain) -> Network {
    match d {
        HyperlaneDomain::Unknown {
            domain_protocol: HyperlaneDomainProtocol::Kaspa,
            domain_id: HL_DOMAIN_KASPA_TEST10,
            ..
        } => Network::KaspaTest10,
        HyperlaneDomain::Unknown {
            domain_protocol: HyperlaneDomainProtocol::Kaspa,
            domain_id: HL_DOMAIN_KASPA_TEST10_LEGACY,
            ..
        } => Network::KaspaTest10,
        HyperlaneDomain::Unknown {
            domain_protocol: HyperlaneDomainProtocol::Kaspa,
            domain_id: HL_DOMAIN_KASPA_MAINNET,
            ..
        } => Network::KaspaMainnet,

        _ => todo!("only kaspa supported"),
    }
}

/// List of kas domain.
pub const KAS_DOMAINS: [u32; 2] = [HL_DOMAIN_KASPA_MAINNET, HL_DOMAIN_KASPA_TEST10];

/// List of dym domain.
pub const HUB_DOMAINS: [u32; 5] = [
    HL_DOMAIN_DYM_LOCAL,
    HL_DOMAIN_DYM_MAINNET,
    HL_DOMAIN_DYM_TESTNET_BLUMBUS,
    HL_DOMAIN_DYM_PLAYGROUND_202507,
    HL_DOMAIN_DYM_PLAYGROUND_202507_LEGACY,
];
