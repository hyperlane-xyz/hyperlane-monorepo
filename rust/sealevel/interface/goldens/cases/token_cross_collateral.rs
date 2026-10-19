// Golden cases for the cross-collateral token program. Program-side oracle only: no
// off-chain Rust code consumes this program, so hyperlane-sealevel-interface does not
// mirror it. It also accepts the shared token instructions (token.json).

pub fn cases() -> GoldenFile {
    use connection_client::router::RemoteRouterConfig;
    use token_cross_collateral::{accounts::*, instruction::*};

    let program_id = pk(0xA9);
    let mut g = GoldenFile::new("token_cross_collateral");

    let ty = "CrossCollateralInstruction";
    g.discriminated(
        ty,
        var!(CrossCollateralInstruction::SetCrossCollateralRouters(vec![
            var!(CrossCollateralRouterUpdate::Add {
                domain: 10u32,
                router: h256(1),
            }),
            var!(CrossCollateralRouterUpdate::Remove(rec!(
                RemoteRouterConfig {
                    domain: 11u32,
                    router: Some(h256(2)),
                }
            ))),
        ])),
    );
    g.discriminated(
        ty,
        var!(CrossCollateralInstruction::TransferRemoteTo(rec!(
            TransferRemoteTo {
                destination_domain: 42161u32,
                recipient: h256(3),
                amount_or_id: U256::from(987_654_321u64),
                target_router: h256(4),
            }
        ))),
    );
    g.discriminated(
        ty,
        var!(CrossCollateralInstruction::HandleLocal(rec!(HandleLocal {
            sender_program_id: pk(1),
            message: bytes(seq::<60>(0x10)),
        }))),
    );
    g.discriminated(
        ty,
        var!(CrossCollateralInstruction::HandleLocalAccountMetas(rec!(
            HandleLocal {
                sender_program_id: pk(2),
                message: bytes(seq::<8>(0x20)),
            }
        ))),
    );
    g.assert_variants(
        ty,
        &variants!(token_cross_collateral::instruction::CrossCollateralInstruction => [
            SetCrossCollateralRouters(_),
            TransferRemoteTo(_),
            HandleLocal(_),
            HandleLocalAccountMetas(_),
        ]),
    );

    g.account(
        "CrossCollateralState",
        rec!(CrossCollateralState {
            bump: 255u8,
            dispatch_authority_bump: 254u8,
            local_domain: 1399811149u32,
            enrolled_routers: btree_map(vec![
                (10u32, btree_set(vec![h256(1), h256(0x40)])),
                (11u32, btree_set(Vec::<H256>::new())),
            ]),
        }),
    );

    g.instruction(
        "set_cross_collateral_routers_instruction",
        set_cross_collateral_routers_instruction(
            program_id,
            pk(3),
            vec![CrossCollateralRouterUpdate::Add {
                domain: 10,
                router: h256(1),
            }],
        )
        .unwrap(),
    );

    g.pda(
        "cross_collateral",
        &program_id,
        token_cross_collateral::cross_collateral_pda_seeds!(),
    );
    g.pda(
        "dispatch_authority",
        &program_id,
        token_cross_collateral::cross_collateral_dispatch_authority_pda_seeds!(),
    );

    error_codes!(g, token_cross_collateral::error::Error => [
        UnauthorizedRouter,
        InvalidDispatchAuthority,
        SameDomainViaMailbox,
    ]);

    g.constant_bytes(
        "CROSS_COLLATERAL_INSTRUCTION_DISCRIMINATOR",
        &CROSS_COLLATERAL_INSTRUCTION_DISCRIMINATOR,
    );

    g
}
