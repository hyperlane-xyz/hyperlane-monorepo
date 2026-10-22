//! hyperlane-sealevel-token-cross-collateral encodings beyond the shared
//! goldens: map/set normalization of the CC state, every instruction shape
//! and the decoder's rejects.

use std::collections::{BTreeMap, BTreeSet};

use account_utils::{AccountData, DiscriminatorDecode, DiscriminatorEncode};
use hyperlane_core::{Encode, H256, U256};
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_token_cross_collateral::{
    accounts::CrossCollateralState,
    instruction::{
        CrossCollateralInstruction, CrossCollateralRouterUpdate, HandleLocal, TransferRemoteTo,
        CROSS_COLLATERAL_INSTRUCTION_DISCRIMINATOR,
    },
};
use hyperlane_warp_route::TokenMessage;
use serde_json::{json, Map, Value};
use solana_program::pubkey::Pubkey;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn h(b: u8) -> H256 {
    let mut x = [0u8; 32];
    x[0] = b;
    x[31] = b;
    H256::from(x)
}

pub fn cc_group() -> Map<String, Value> {
    let mut g = Map::new();
    let ok = |g: &mut Map<String, Value>, name: &str, bytes: Vec<u8>| {
        g.insert(name.into(), json!({"hex": hex(&bytes), "ok": true}));
    };
    let ix = |g: &mut Map<String, Value>, name: &str, v: CrossCollateralInstruction| {
        let bytes = borsh::to_vec(&v).unwrap();
        let mut bytes_d = CROSS_COLLATERAL_INSTRUCTION_DISCRIMINATOR.to_vec();
        bytes_d.extend_from_slice(&bytes);
        let bytes = bytes_d;
        assert_eq!(CrossCollateralInstruction::decode(&bytes).unwrap(), v);
        assert_eq!(v.encode().unwrap(), bytes);
        g.insert(name.into(), json!({"hex": hex(&bytes), "ok": true}));
    };

    ix(
        &mut g,
        "set_routers_all_shapes",
        CrossCollateralInstruction::SetCrossCollateralRouters(vec![
            CrossCollateralRouterUpdate::Add {
                domain: 7,
                router: h(1),
            },
            CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                domain: 8,
                router: Some(h(2)),
            }),
            CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
                domain: 9,
                router: None,
            }),
        ]),
    );
    ix(
        &mut g,
        "set_routers_empty",
        CrossCollateralInstruction::SetCrossCollateralRouters(vec![]),
    );
    ix(
        &mut g,
        "transfer_remote_to_u256_max",
        CrossCollateralInstruction::TransferRemoteTo(TransferRemoteTo {
            destination_domain: u32::MAX,
            recipient: h(3),
            amount_or_id: U256::MAX,
            target_router: h(4),
        }),
    );
    // The HandleLocal the local transfer path CPIs with.
    let sender = Pubkey::new_from_array([5; 32]);
    let message = TokenMessage::new(h(6), U256::from(123_456_789u64), vec![]).to_vec();
    ix(
        &mut g,
        "handle_local_cpi",
        CrossCollateralInstruction::HandleLocal(HandleLocal {
            sender_program_id: sender,
            message,
        }),
    );
    ix(
        &mut g,
        "handle_local_account_metas_empty",
        CrossCollateralInstruction::HandleLocalAccountMetas(HandleLocal {
            sender_program_id: sender,
            message: vec![],
        }),
    );

    let good = CrossCollateralInstruction::SetCrossCollateralRouters(vec![
        CrossCollateralRouterUpdate::Remove(RemoteRouterConfig {
            domain: 1,
            router: None,
        }),
    ])
    .encode()
    .unwrap();
    let reject = |g: &mut Map<String, Value>, name: &str, bytes: Vec<u8>| {
        assert!(
            CrossCollateralInstruction::decode(&bytes).is_err(),
            "{name}"
        );
        g.insert(name.into(), json!({"hex": hex(&bytes), "ok": false}));
    };
    let mut b = good.clone();
    b[8] = 4;
    reject(&mut g, "reject_variant", b);
    let mut b = good.clone();
    b[13] = 2;
    reject(&mut g, "reject_update_tag", b);
    let mut b = good.clone();
    let last = b.len() - 1;
    b[last] = 2;
    reject(&mut g, "reject_option_tag", b);
    let mut b = good.clone();
    b.push(0);
    reject(&mut g, "reject_trailing", b);
    reject(&mut g, "reject_truncated", good[..good.len() - 1].to_vec());
    let mut b = good.clone();
    b[0] = 1;
    reject(&mut g, "reject_discriminator", b);

    // State input with unsorted keys, a repeated key and repeated set
    // entries: AccountData::fetch accepts it; the canonical re-encoding is
    // what store writes.
    let entries: Vec<(u32, Vec<H256>)> = vec![
        (20, vec![h(9), h(1)]),
        (10, vec![h(5)]),
        (20, vec![h(7), h(7), h(2)]),
        (30, vec![]),
    ];
    let mut input = vec![1u8, 0xfe, 0xfd];
    input.extend_from_slice(&0x0102_0304u32.to_le_bytes());
    input.extend_from_slice(&borsh::to_vec(&entries).unwrap());
    let state = AccountData::<CrossCollateralState>::fetch(&mut &input[..])
        .unwrap()
        .into_inner();
    let mut canonical = vec![1u8];
    canonical.extend_from_slice(&borsh::to_vec(&*state).unwrap());
    ok(&mut g, "state_unsorted_input", input);
    ok(&mut g, "state_unsorted_canonical", canonical);

    let mut routers = BTreeMap::new();
    routers.insert(1u32, BTreeSet::from([h(1), h(2)]));
    ok(
        &mut g,
        "state_canonical",
        borsh::to_vec(&CrossCollateralState {
            bump: 1,
            dispatch_authority_bump: 2,
            local_domain: 3,
            enrolled_routers: routers,
        })
        .unwrap(),
    );
    g
}
