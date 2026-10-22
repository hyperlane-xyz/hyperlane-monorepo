// Golden cases for the shared Hyperlane token logic and the synthetic / collateral /
// native token programs. `include!`d by both the program-side oracle and the interface
// crate; see ../src/lib.rs.

fn token_init(n: u8) -> Rec<token::instruction::Init> {
    use igp::accounts::InterchainGasPaymasterType;
    use token::instruction::Init;
    rec!(Init {
        mailbox: pk(n),
        interchain_security_module: Some(pk(n + 1)),
        interchain_gas_paymaster: Some((
            pk(n + 2),
            var!(InterchainGasPaymasterType::OverheadIgp(pk(n + 3))),
        )),
        decimals: 6u8,
        remote_decimals: 18u8,
    })
}

fn transfer_remote() -> Rec<token::instruction::TransferRemote> {
    use token::instruction::TransferRemote;
    rec!(TransferRemote {
        destination_domain: 42161u32,
        recipient: h256(0x50),
        amount_or_id: U256::from_dec_str("123456789012345678901234567890").unwrap(),
    })
}

fn fee_config() -> Rec<token::accounts::FeeConfig> {
    use token::accounts::FeeConfig;
    rec!(FeeConfig {
        fee_program: pk(0x60),
        fee_account: pk(0x61),
    })
}

/// A `HyperlaneToken<T>` with every optional field populated.
fn hyperlane_token<T>(
    plugin_data: Rec<T>,
    with_fee: bool,
) -> Rec<token::accounts::HyperlaneToken<T>> {
    use igp::accounts::InterchainGasPaymasterType;
    use token::accounts::HyperlaneToken;
    rec!(HyperlaneToken {
        bump: 255u8,
        mailbox: pk(0x70),
        mailbox_process_authority: pk(0x71),
        dispatch_authority_bump: 254u8,
        decimals: 9u8,
        remote_decimals: 18u8,
        owner: Some(pk(0x72)),
        interchain_security_module: Some(pk(0x73)),
        interchain_gas_paymaster: Some(
            (pk(0x74), var!(InterchainGasPaymasterType::Igp(pk(0x75))),)
        ),
        destination_gas: hash_map(vec![(1u32, 68_000u64), (42161u32, 100_000u64)]),
        remote_routers: hash_map(vec![(1u32, h256(0x76)), (42161u32, h256(0x77))]),
        plugin_data: plugin_data,
        fee_config: if with_fee {
            opt_disc(Some(fee_config()))
        } else {
            opt_disc_none()
        },
    })
}

pub fn cases() -> GoldenFile {
    use connection_client::{gas_router::GasRouterConfig, router::RemoteRouterConfig};
    use igp::accounts::InterchainGasPaymasterType;
    use token::{accounts::*, instruction::*};
    use token_collateral::plugin::CollateralPlugin;
    use token_native::plugin::NativePlugin;
    use token_synthetic::plugin::SyntheticPlugin;

    let program_id = pk(0xA5);
    let mut g = GoldenFile::new("token");

    // Shared token instructions: `PROGRAM_INSTRUCTION_DISCRIMINATOR || borsh(Instruction)`.
    // Token programs also accept the message-recipient interface; see interfaces.json.
    let ty = "Instruction";
    g.discriminated(ty, var!(Instruction::Init(token_init(1))));
    g.discriminated(ty, var!(Instruction::TransferRemote(transfer_remote())));
    g.discriminated(
        ty,
        var!(Instruction::EnrollRemoteRouter(rec!(RemoteRouterConfig {
            domain: 10u32,
            router: Some(h256(0x10)),
        }))),
    );
    g.discriminated(
        ty,
        var!(Instruction::EnrollRemoteRouters(vec![
            rec!(RemoteRouterConfig {
                domain: 10u32,
                router: Some(h256(0x11)),
            }),
            rec!(RemoteRouterConfig {
                domain: 11u32,
                router: none::<H256>(),
            }),
        ])),
    );
    g.discriminated(
        ty,
        var!(Instruction::SetDestinationGasConfigs(vec![
            rec!(GasRouterConfig {
                domain: 10u32,
                gas: Some(64_000u64),
            }),
            rec!(GasRouterConfig {
                domain: 11u32,
                gas: none::<u64>(),
            }),
        ])),
    );
    g.discriminated(
        ty,
        var!(Instruction::SetInterchainSecurityModule(Some(pk(2)))),
    );
    g.discriminated_named(
        ty,
        Some("some"),
        var!(Instruction::SetInterchainGasPaymaster(Some((
            pk(3),
            var!(InterchainGasPaymasterType::Igp(pk(4))),
        )))),
    );
    g.discriminated_named(
        ty,
        Some("none"),
        var!(Instruction::SetInterchainGasPaymaster(none::<(
            Pubkey,
            InterchainGasPaymasterType
        )>())),
    );
    g.discriminated(ty, var!(Instruction::TransferOwnership(none::<Pubkey>())));
    g.discriminated(
        ty,
        var!(Instruction::TransferRemoteWithMemo(rec!(
            TransferRemoteWithMemo {
                xfer: transfer_remote(),
                memo: bytes(b"memo: hello".to_vec()),
            }
        ))),
    );
    g.discriminated_named(
        ty,
        Some("some"),
        var!(Instruction::SetFeeConfig(Some(fee_config()))),
    );
    g.discriminated_named(
        ty,
        Some("none"),
        var!(Instruction::SetFeeConfig(none::<FeeConfig>())),
    );
    g.assert_variants(
        ty,
        &variants!(token::instruction::Instruction => [
            Init(_),
            TransferRemote(_),
            EnrollRemoteRouter(_),
            EnrollRemoteRouters(_),
            SetDestinationGasConfigs(_),
            SetInterchainSecurityModule(_),
            SetInterchainGasPaymaster(_),
            TransferOwnership(_),
            TransferRemoteWithMemo(_),
            SetFeeConfig(_),
        ]),
    );

    // Token accounts: `AccountData<HyperlaneToken<Plugin>>`.
    g.account_named(
        "HyperlaneToken<SyntheticPlugin>",
        Some("with_fee_config"),
        hyperlane_token(
            rec!(SyntheticPlugin {
                mint: pk(0x80),
                mint_bump: 253u8,
                ata_payer_bump: 252u8,
            }),
            true,
        ),
    );
    g.account_named(
        "HyperlaneToken<CollateralPlugin>",
        Some("without_fee_config"),
        hyperlane_token(
            rec!(CollateralPlugin {
                spl_token_program: pk(0x81),
                mint: pk(0x82),
                escrow: pk(0x83),
                escrow_bump: 251u8,
                ata_payer_bump: 250u8,
            }),
            false,
        ),
    );
    g.account_named(
        "HyperlaneToken<NativePlugin>",
        Some("with_fee_config"),
        hyperlane_token(
            rec!(NativePlugin {
                native_collateral_bump: 249u8,
            }),
            true,
        ),
    );
    g.account_named(
        "HyperlaneToken<NativePlugin>",
        Some("minimal"),
        rec!(HyperlaneToken {
            bump: 248u8,
            mailbox: pk(0x90),
            mailbox_process_authority: pk(0x91),
            dispatch_authority_bump: 247u8,
            decimals: 9u8,
            remote_decimals: 9u8,
            owner: none::<Pubkey>(),
            interchain_security_module: none::<Pubkey>(),
            interchain_gas_paymaster: none::<(Pubkey, InterchainGasPaymasterType)>(),
            destination_gas: hash_map(Vec::<(u32, u64)>::new()),
            remote_routers: hash_map(Vec::<(u32, H256)>::new()),
            plugin_data: rec!(NativePlugin {
                native_collateral_bump: 246u8,
            }),
            fee_config: opt_disc_none(),
        }),
    );

    // Instruction builders.
    g.instruction(
        "token.init_instruction",
        token::instruction::init_instruction(program_id, pk(0x20), token_init(1).value).unwrap(),
    );
    g.instruction(
        "token.enroll_remote_routers_instruction",
        enroll_remote_routers_instruction(
            program_id,
            pk(0x21),
            vec![RemoteRouterConfig {
                domain: 1,
                router: Some(h256(1)),
            }],
        )
        .unwrap(),
    );
    g.instruction(
        "token.set_destination_gas_configs",
        set_destination_gas_configs(
            program_id,
            pk(0x21),
            vec![GasRouterConfig {
                domain: 1,
                gas: Some(1),
            }],
        )
        .unwrap(),
    );
    g.instruction(
        "token.transfer_ownership_instruction",
        transfer_ownership_instruction(program_id, pk(0x21), Some(pk(0x22))).unwrap(),
    );
    g.instruction(
        "token.set_interchain_security_module_instruction",
        set_interchain_security_module_instruction(program_id, pk(0x21), Some(pk(0x23))).unwrap(),
    );
    g.instruction(
        "token.set_fee_config_instruction",
        set_fee_config_instruction(program_id, pk(0x21), pk(0x24), Some(fee_config().value))
            .unwrap(),
    );
    g.instruction(
        "token.set_igp_instruction",
        set_igp_instruction(
            program_id,
            pk(0x21),
            Some((pk(0x25), InterchainGasPaymasterType::Igp(pk(0x26)))),
        )
        .unwrap(),
    );
    g.instruction(
        "token_synthetic.init_instruction",
        token_synthetic::instruction::init_instruction(program_id, pk(0x20), token_init(2).value)
            .unwrap(),
    );
    g.instruction(
        "token_collateral.init_instruction",
        token_collateral::instruction::init_instruction(
            program_id,
            pk(0x20),
            token_init(3).value,
            pk(0x27),
            pk(0x28),
        )
        .unwrap(),
    );
    g.instruction(
        "token_native.init_instruction",
        token_native::instruction::init_instruction(program_id, pk(0x20), token_init(4).value)
            .unwrap(),
    );

    // PDAs.
    g.pda("token", &program_id, token::hyperlane_token_pda_seeds!());
    g.pda(
        "mint",
        &program_id,
        token_synthetic::hyperlane_token_mint_pda_seeds!(),
    );
    g.pda(
        "ata_payer (synthetic program macro)",
        &program_id,
        token_synthetic::hyperlane_token_ata_payer_pda_seeds!(),
    );
    g.pda(
        "ata_payer (collateral program macro)",
        &program_id,
        token_collateral::hyperlane_token_ata_payer_pda_seeds!(),
    );
    g.pda(
        "escrow",
        &program_id,
        token_collateral::hyperlane_token_escrow_pda_seeds!(),
    );
    g.pda(
        "native_collateral",
        &program_id,
        token_native::hyperlane_token_native_collateral_pda_seeds!(),
    );

    error_codes!(g, token::error::Error => [
        ExtraneousAccount,
        IntegerOverflow,
        MessageDecodeError,
        InvalidFeeReturnData,
        FeeAccountOwnerMismatch,
        FeeBeneficiaryNotFound,
        IgpNewFlowRequired,
        InvalidFeeAccountDomain,
    ]);

    g.constant_bytes("FeeConfig.DISCRIMINATOR", &FeeConfig::DISCRIMINATOR);
    g.constant_bytes(
        "PROGRAM_INSTRUCTION_DISCRIMINATOR",
        &<Instruction as DiscriminatorData>::DISCRIMINATOR,
    );

    g
}
