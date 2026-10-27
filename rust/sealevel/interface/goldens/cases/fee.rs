// Golden cases for the warp fee program. Program-side oracle only: no off-chain Rust code
// consumes this program, so hyperlane-sealevel-interface does not mirror it.

fn fee_params(n: u64) -> Rec<fee::fee_math::FeeParams> {
    use fee::fee_math::FeeParams;
    rec!(FeeParams {
        max_fee: 1_000_000u64 + n,
        half_amount: 50_000_000u64 + n,
    })
}

fn signers() -> Rec<std::collections::BTreeSet<H160>> {
    btree_set(vec![h160(0x11), h160(0x22)])
}

fn fee_signed_quote() -> Rec<quote_verifier::SvmSignedQuote> {
    use quote_verifier::SvmSignedQuote;
    rec!(SvmSignedQuote {
        context: bytes(seq::<44>(0x30)),
        data: bytes(seq::<16>(0x70)),
        issued_at: byte_array([0, 0, 0x65, 0x53, 0xf1, 0x00]),
        expiry: byte_array([0, 0, 0x65, 0x53, 0xf1, 0x00]),
        client_salt: h256(0x45),
        signature: byte_array(seq::<65>(0xC0)),
    })
}

pub fn cases() -> GoldenFile {
    use fee::{accounts::*, fee_math::FeeDataStrategy, instruction::*};

    let program_id = pk(0xA8);
    let mut g = GoldenFile::new("fee");

    let ty = "Instruction";
    g.borsh_named(
        ty,
        Some("leaf"),
        var!(Instruction::InitFee(rec!(InitFee {
            salt: h256(1),
            beneficiary: pk(1),
            fee_data: var!(FeeData::Leaf(rec!(LeafFeeConfig {
                strategy: var!(FeeDataStrategy::Linear(fee_params(1))),
                signers: Some(signers()),
            }))),
            domain_id: 1399811149u32,
        }))),
    );
    g.borsh_named(
        ty,
        Some("routing"),
        var!(Instruction::InitFee(rec!(InitFee {
            salt: h256(2),
            beneficiary: pk(2),
            fee_data: var!(FeeData::Routing(rec!(RoutingFeeConfig {
                wildcard_signers: signers(),
            }))),
            domain_id: 1u32,
        }))),
    );
    g.borsh_named(
        ty,
        Some("cross_collateral_routing"),
        var!(Instruction::InitFee(rec!(InitFee {
            salt: h256(3),
            beneficiary: pk(3),
            fee_data: var!(FeeData::CrossCollateralRouting(rec!(
                CrossCollateralRoutingFeeConfig {
                    wildcard_signers: btree_set(Vec::<H160>::new()),
                }
            ))),
            domain_id: 2u32,
        }))),
    );
    g.borsh(
        ty,
        var!(Instruction::QuoteFee(rec!(QuoteFee {
            destination_domain: 42161u32,
            recipient: h256(4),
            amount: 123_456_789u64,
            target_router: h256(5),
        }))),
    );
    g.borsh(
        ty,
        var!(Instruction::SetRemoteFeeRoute(rec!(SetRemoteFeeRoute {
            domain: 10u32,
            target_router: Some(h256(6)),
            fee_data: var!(FeeDataStrategy::Regressive(fee_params(2))),
            signers: none::<std::collections::BTreeSet<H160>>(),
        }))),
    );
    g.borsh(
        ty,
        var!(Instruction::RemoveRemoteFeeRoute(rec!(
            RemoveRemoteFeeRoute {
                domain: 10u32,
                target_router: none::<H256>(),
            }
        ))),
    );
    g.borsh(ty, var!(Instruction::UpdateFeeParams(fee_params(3))));
    g.borsh(ty, var!(Instruction::SetBeneficiary(pk(4))));
    g.borsh(ty, var!(Instruction::TransferOwnership(Some(pk(5)))));
    g.borsh_named(
        ty,
        Some("add_domain"),
        var!(Instruction::SetQuoteSigner {
            operation: var!(SetQuoteSignerOperation::Add(h160(0x33))),
            route: Some(var!(RouteKey::Domain(8453u32))),
        }),
    );
    g.borsh_named(
        ty,
        Some("remove_cross_collateral"),
        var!(Instruction::SetQuoteSigner {
            operation: var!(SetQuoteSignerOperation::Remove(h160(0x34))),
            route: Some(var!(RouteKey::CrossCollateral {
                destination: 10u32,
                target_router: h256(7),
            })),
        }),
    );
    g.borsh_named(
        ty,
        Some("wildcard"),
        var!(Instruction::SetQuoteSigner {
            operation: var!(SetQuoteSignerOperation::Add(h160(0x35))),
            route: none::<RouteKey>(),
        }),
    );
    g.borsh(
        ty,
        var!(Instruction::SetMinIssuedAt {
            min_issued_at: 1_700_000_000i64,
        }),
    );
    g.borsh(
        ty,
        var!(Instruction::SetWildcardQuoteSigners { signers: signers() }),
    );
    g.borsh(ty, var!(Instruction::SubmitQuote(fee_signed_quote())));
    g.borsh(ty, var!(Instruction::CloseTransientQuote));
    g.borsh(
        ty,
        var!(Instruction::PruneExpiredQuotes {
            domain: 10u32,
            target_router: Some(h256(8)),
        }),
    );
    g.borsh(
        ty,
        var!(Instruction::GetQuoteAccountMetas(rec!(
            GetQuoteAccountMetas {
                destination_domain: 10u32,
                target_router: h256(9),
                scoped_salt: Some(h256(10)),
            }
        ))),
    );
    g.borsh(
        ty,
        var!(Instruction::GetSubmitQuoteAccountMetas(rec!(
            GetSubmitQuoteAccountMetas {
                destination_domain: 11u32,
                target_router: h256(11),
                scoped_salt: none::<H256>(),
            }
        ))),
    );
    g.assert_variants(
        ty,
        &variants!(fee::instruction::Instruction => [
            InitFee(_),
            QuoteFee(_),
            SetRemoteFeeRoute(_),
            RemoveRemoteFeeRoute(_),
            UpdateFeeParams(_),
            SetBeneficiary(_),
            TransferOwnership(_),
            SetQuoteSigner { .. },
            SetMinIssuedAt { .. },
            SetWildcardQuoteSigners { .. },
            SubmitQuote(_),
            CloseTransientQuote,
            PruneExpiredQuotes { .. },
            GetQuoteAccountMetas(_),
            GetSubmitQuoteAccountMetas(_),
        ]),
    );
    let _ = variants!(fee::fee_math::FeeDataStrategy => [Linear(_), Regressive(_), Progressive(_)]);
    g.borsh_named(
        "FeeDataStrategy",
        Some("progressive"),
        var!(FeeDataStrategy::Progressive(fee_params(4))),
    );

    g.account_prefixed(
        "FeeAccount",
        None,
        prefixed(rec!(FeeAccount {
            bump_seed: 255u8,
            owner: Some(pk(6)),
            beneficiary: pk(7),
            domain_id: 1399811149u32,
            min_issued_at: 1_700_000_000i64,
            fee_data: var!(FeeData::Leaf(rec!(LeafFeeConfig {
                strategy: var!(FeeDataStrategy::Progressive(fee_params(5))),
                signers: none::<std::collections::BTreeSet<H160>>(),
            }))),
        })),
    );
    g.account_prefixed(
        "RouteDomain",
        None,
        prefixed(rec!(RouteDomain {
            bump_seed: 254u8,
            fee_data: var!(FeeDataStrategy::Linear(fee_params(6))),
            signers: Some(signers()),
        })),
    );
    g.account_prefixed(
        "CrossCollateralRoute",
        None,
        prefixed(rec!(CrossCollateralRoute {
            bump_seed: 253u8,
            fee_data: var!(FeeDataStrategy::Regressive(fee_params(7))),
            signers: none::<std::collections::BTreeSet<H160>>(),
        })),
    );
    g.account_prefixed(
        "TransientQuote",
        None,
        prefixed(rec!(TransientQuote {
            bump_seed: 252u8,
            payer: pk(8),
            scoped_salt: h256(12),
            context: bytes(seq::<44>(0x40)),
            data: bytes(seq::<16>(0x50)),
            expiry: 1_700_000_300i64,
        })),
    );
    g.account_prefixed(
        "FeeStandingQuotePda",
        None,
        prefixed(rec!(FeeStandingQuotePda {
            bump_seed: 251u8,
            quotes: btree_map(vec![
                (
                    h256(0x01),
                    rec!(FeeStandingQuoteValue {
                        issued_at: 1_700_000_000i64,
                        expiry: 1_700_086_400i64,
                        fee_data: var!(FeeDataStrategy::Linear(fee_params(8))),
                    }),
                ),
                (
                    h256(0x80),
                    rec!(FeeStandingQuoteValue {
                        issued_at: 1_700_000_001i64,
                        expiry: 1_700_086_401i64,
                        fee_data: var!(FeeDataStrategy::Progressive(fee_params(9))),
                    }),
                ),
            ]),
        })),
    );

    g.instruction(
        "init_fee_instruction",
        init_fee_instruction(
            program_id,
            pk(20),
            h256(1),
            pk(1),
            FeeData::Routing(RoutingFeeConfig {
                wildcard_signers: signers().value,
            }),
            1399811149,
        )
        .unwrap(),
    );
    g.instruction(
        "set_remote_fee_route_instruction",
        set_remote_fee_route_instruction(
            program_id,
            pk(21),
            pk(22),
            10,
            Some(h256(6)),
            FeeDataStrategy::Linear(fee_params(10).value),
            Some(signers().value),
        )
        .unwrap(),
    );
    g.instruction(
        "remove_remote_fee_route_instruction",
        remove_remote_fee_route_instruction(program_id, pk(21), pk(22), 10, None).unwrap(),
    );
    g.instruction(
        "update_fee_params_instruction",
        update_fee_params_instruction(program_id, pk(21), pk(22), fee_params(11).value).unwrap(),
    );
    g.instruction(
        "set_beneficiary_instruction",
        set_beneficiary_instruction(program_id, pk(21), pk(22), pk(23)).unwrap(),
    );
    g.instruction(
        "transfer_ownership_instruction",
        transfer_ownership_instruction(program_id, pk(21), pk(22), None).unwrap(),
    );
    g.instruction(
        "set_quote_signer_instruction",
        set_quote_signer_instruction(
            program_id,
            pk(21),
            pk(22),
            SetQuoteSignerOperation::Add(h160(0x36)),
            Some(RouteKey::CrossCollateral {
                destination: 10,
                target_router: h256(7),
            }),
        )
        .unwrap(),
    );
    g.instruction(
        "set_wildcard_quote_signers_instruction",
        set_wildcard_quote_signers_instruction(program_id, pk(21), pk(22), signers().value)
            .unwrap(),
    );
    g.instruction(
        "set_min_issued_at_instruction",
        set_min_issued_at_instruction(program_id, pk(21), pk(22), 1_700_000_000).unwrap(),
    );
    g.instruction(
        "submit_transient_quote_instruction",
        submit_transient_quote_instruction(
            program_id,
            pk(20),
            pk(21),
            h256(12),
            fee_signed_quote().value,
            &[pk(24)],
        )
        .unwrap(),
    );
    g.instruction(
        "submit_standing_quote_instruction",
        submit_standing_quote_instruction(
            program_id,
            pk(20),
            pk(21),
            10,
            h256(13),
            fee_signed_quote().value,
            &[pk(24), pk(25)],
        )
        .unwrap(),
    );
    g.instruction(
        "close_transient_quote_instruction",
        close_transient_quote_instruction(program_id, pk(21), pk(26), pk(20)).unwrap(),
    );
    g.instruction(
        "prune_expired_quotes_instruction",
        prune_expired_quotes_instruction(program_id, pk(21), pk(22), 10, Some(h256(13))).unwrap(),
    );

    let salt = h256(1);
    let fee_account = pk(21);
    let domain_le = 10u32.to_le_bytes();
    let target_router = h256(7);
    let scoped_salt = h256(12);
    g.pda(
        "fee_account",
        &program_id,
        fee::fee_account_pda_seeds!(salt),
    );
    g.pda(
        "route_domain",
        &program_id,
        fee::route_domain_pda_seeds!(fee_account, &domain_le),
    );
    g.pda(
        "cc_route",
        &program_id,
        fee::cc_route_pda_seeds!(fee_account, &domain_le, target_router),
    );
    g.pda(
        "transient_quote",
        &program_id,
        fee::transient_quote_pda_seeds!(fee_account, scoped_salt),
    );
    g.pda(
        "standing_quote",
        &program_id,
        fee::fee_standing_quote_pda_seeds!(fee_account, &domain_le),
    );

    error_codes!(g, fee::error::Error => [
        FeeComputationOverflow,
        NotLeafFeeData,
        NotRoutingFeeData,
        NotCrossCollateralRoutingFeeData,
        RouteNotFound,
        TransientPdaMismatch,
        InvalidTransientData,
        StandingQuoteAmountNotWildcard,
        InvalidStandingQuoteContext,
        InvalidStandingQuoteData,
        ZeroTargetRouterNotAllowed,
        InvalidRouteDomain,
        OffchainQuotingNotConfigured,
        WildcardSignersNotApplicable,
        MinIssuedAtMustBeMonotonic,
        CurveVariantMismatch,
        ZeroFeeParams,
        InvalidTransientSlot,
    ]);

    g.constant_bytes("FEE_ACCOUNT_DISCRIMINATOR", &FEE_ACCOUNT_DISCRIMINATOR);
    g.constant_bytes("ROUTE_DOMAIN_DISCRIMINATOR", &ROUTE_DOMAIN_DISCRIMINATOR);
    g.constant_bytes("CC_ROUTE_DISCRIMINATOR", &CC_ROUTE_DISCRIMINATOR);
    g.constant_bytes(
        "TRANSIENT_QUOTE_DISCRIMINATOR",
        &TRANSIENT_QUOTE_DISCRIMINATOR,
    );
    g.constant_bytes(
        "STANDING_QUOTE_DISCRIMINATOR",
        &STANDING_QUOTE_DISCRIMINATOR,
    );
    g.constant("WILDCARD_RECIPIENT", WILDCARD_RECIPIENT);
    g.constant("WILDCARD_DOMAIN", WILDCARD_DOMAIN);
    g.constant("WILDCARD_AMOUNT", WILDCARD_AMOUNT);
    g.constant("DEFAULT_ROUTER", DEFAULT_ROUTER);

    g
}
