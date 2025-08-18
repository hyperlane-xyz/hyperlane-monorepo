use hex::ToHex;
use hyperlane_core::utils::hex_or_base58_to_h256;
use hyperlane_sovereign::{ethereum, Crypto};
use serde_json::json;

use super::types::{get_or_create_client, ChainConfig, ChainRegistry};

pub async fn set_relayer_igp_configs(conf: &ChainRegistry, relayer_address: &str) {
    for chain in conf.chains.values() {
        let domain_oracle_data = conf
        .chains
        .values()
        .map(|c| json!({"domain": c.domain_id, "data_value": {"gas_price": 1, "token_exchange_rate": 1}})).collect::<Vec<_>>();
        let domain_default_gas = conf
            .chains
            .values()
            .map(|c| json!({"domain": c.domain_id, "default_gas": 2000}))
            .collect::<Vec<_>>();

        let client = get_or_create_client(chain).await;
        let call = serde_json::json!({
            "interchain_gas_paymaster": {
                "set_relayer_config": {
                    "domain_oracle_data": domain_oracle_data,
                    "domain_default_gas": domain_default_gas,
                    "default_gas": 10000,
                    "beneficiary": relayer_address
                }
            }
        });
        client
            .build_and_submit(call)
            .await
            .expect("failed to set relayer IGP config");
    }
}

async fn create_warp_route(
    chain: &ChainConfig,
    relayer_address: &str,
    validator_address: &str,
) -> String {
    let client = get_or_create_client(chain).await;
    let limit = u128::MAX.to_string();
    let call = json!({
        "warp": {
            "register": {
                "admin": {
                    "InsecureOwner": relayer_address,
                },
                "ism": {
                    "MessageIdMultisig": {
                        "threshold": 1,
                        "validators": [validator_address]
                    }
                },
                "token_source": "Native",
                "remote_routers": [],
                "inbound_transferrable_tokens_limit": limit,
                "inbound_limit_replenishment_per_slot": limit,
                "outbound_transferrable_tokens_limit": limit,
                "outbound_limit_replenishment_per_slot": limit
            }
        }
    });
    let (response, _) = client
        .build_and_submit(call)
        .await
        .expect("warp registration should succeed");
    let event = &response.events.unwrap()[0];
    event
        .value
        .get("route_registered")
        .expect("route_registered field not found")
        .get("route_id")
        .expect("route_id field not found")
        .as_str()
        .expect("should conver to string")
        .to_owned()
}

async fn create_warp_route_synth(
    chain: &ChainConfig,
    relayer_address: &str,
    validator_address: &str,
) -> String {
    // https://github.com/Sovereign-Labs/rollup-starter/blob/f8f18e933cbed3c2e0017610cc902951c0aabc8c/constants.toml#L52C28-L52C93
    let gas_token_id = "token_1nyl0e0yweragfsatygt24zmd8jrr2vqtvdfptzjhxkguz2xxx3vs0y07u7";
    let client = get_or_create_client(chain).await;
    let limit = u128::MAX.to_string();
    let call = json!({
        "warp": {
            "register": {
                "admin": {
                    "InsecureOwner": relayer_address,
                },
                "ism": {
                    "MessageIdMultisig": {
                        "threshold": 1,
                        "validators": [validator_address]
                    }
                },
                "token_source": "Native",
                "remote_routers": [],
                "inbound_transferrable_tokens_limit": limit,
                "inbound_limit_replenishment_per_slot": limit,
                "outbound_transferrable_tokens_limit": limit,
                "outbound_limit_replenishment_per_slot": limit
            }
        }
    });
    let (response, _) = client
        .build_and_submit(call)
        .await
        .expect("warp registration should succeed");
    let event = &response.events.unwrap()[0];
    event
        .value
        .get("route_registered")
        .expect("route_registered field not found")
        .get("route_id")
        .expect("route_id field not found")
        .as_str()
        .expect("should conver to string")
        .to_owned()
}

async fn enroll_remote_router(origin: (&ChainConfig, &str), remote: (&ChainConfig, &str)) {
    let (chain, route_id) = origin;
    let (remote_chain, remote_id) = remote;
    let client = get_or_create_client(chain).await;
    let call = json!({
        "warp": {
            "enroll_remote_router": {
                "warp_route": route_id,
                "remote_domain": remote_chain.domain_id,
                "remote_router_address": remote_id,
            }
        }
    });
    let _ = client
        .build_and_submit(call)
        .await
        .expect("remote router enroll should succeed");
}

pub struct ChainRouter {
    pub domain_id: u32,
    pub router_id: String,
}

pub async fn connect_chains(
    conf: &ChainRegistry,
    relayer_address: &str,
    validator_address: &str,
) -> Vec<ChainRouter> {
    let mut chains = conf.chains.values();
    let chain1 = chains.next().unwrap();
    let chain2 = chains.next().unwrap();

    let route1 = create_warp_route(chain1, relayer_address, validator_address).await;
    let route2 = create_warp_route(chain2, relayer_address, validator_address).await;
    enroll_remote_router((chain1, &route1), (&chain2, &route2)).await;
    enroll_remote_router((chain2, &route2), (&chain1, &route1)).await;

    vec![
        ChainRouter {
            domain_id: chain1.domain_id,
            router_id: route1,
        },
        ChainRouter {
            domain_id: chain2.domain_id,
            router_id: route2,
        },
    ]
}

// Convert the 20 byte eth address to address padded to 32 bytes for hyperlane.
pub fn address_to_padded(address: &str) -> String {
    let hash = hex_or_base58_to_h256(address).unwrap();
    let signer = ethereum::Signer::new(&hash).unwrap();
    let hash_addr = signer.h256_address();
    hash_addr.encode_hex()
}

pub async fn dispatch_transfers(
    config: &ChainRegistry,
    routers: &[ChainRouter],
    count: usize,
    relayer: &str,
) -> usize {
    let mut dispatched_count = 0;
    let recipient = address_to_padded(relayer);

    for conf in config.chains.values() {
        let targets = config
            .chains
            .values()
            .filter(|other| conf.domain_id != other.domain_id)
            .collect::<Vec<_>>();
        let client = get_or_create_client(conf).await;

        for target in targets {
            let router = routers
                .iter()
                .find(|r| r.domain_id == target.domain_id)
                .unwrap();
            let call = json!({
                "warp": {
                    "transfer_remote": {
                        "amount": "1",
                        "gas_payment_limit": u128::MAX.to_string(),
                        "destination_domain": router.domain_id,
                        "recipient": recipient,
                        "warp_route": router.router_id,
                        "relayer": relayer,
                    }
                }
            });

            for _ in 0..count {
                client
                    .build_and_submit(call.clone())
                    .await
                    .expect("message dispatch should succeed");
                dispatched_count += 1;
            }
        }
    }

    dispatched_count
}
