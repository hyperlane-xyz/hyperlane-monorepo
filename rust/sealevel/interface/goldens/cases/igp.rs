// Golden cases for the Interchain Gas Paymaster program. `include!`d by both the
// program-side oracle and the interface crate; see ../src/lib.rs.

fn remote_gas_data(n: u8) -> Rec<igp::accounts::RemoteGasData> {
    use igp::accounts::RemoteGasData;
    rec!(RemoteGasData {
        token_exchange_rate: 10_000_000_000_000_000_000u128 + n as u128,
        gas_price: 25_000_000_000u128 + n as u128,
        token_decimals: 9u8 + n,
    })
}

fn gas_oracle(n: u8) -> Rec<igp::accounts::GasOracle> {
    use igp::accounts::GasOracle;
    var!(GasOracle::RemoteGasData(remote_gas_data(n)))
}

fn igp_fee_config() -> Rec<igp::accounts::IgpFeeConfig> {
    use igp::accounts::IgpFeeConfig;
    rec!(IgpFeeConfig {
        signers: btree_set(vec![h160(0x11), h160(0x22)]),
        domain_id: 1399811149u32,
        min_issued_at: 1_700_000_000i64,
    })
}

fn signed_quote() -> Rec<quote_verifier::SvmSignedQuote> {
    use quote_verifier::SvmSignedQuote;
    rec!(SvmSignedQuote {
        context: bytes(seq::<68>(0x30)),
        data: bytes(seq::<33>(0x70)),
        issued_at: byte_array([0, 0, 0x65, 0x53, 0xf1, 0x00]),
        expiry: byte_array([0, 0, 0x65, 0x53, 0xff, 0x10]),
        client_salt: h256(0x44),
        signature: byte_array(seq::<65>(0xB0)),
    })
}

pub fn cases() -> GoldenFile {
    use igp::{accounts::*, instruction::*};

    let program_id = pk(0xA1);
    let mut g = GoldenFile::new("igp");

    // Instructions (plain borsh).
    let ty = "Instruction";
    g.borsh(ty, var!(Instruction::Init));
    g.borsh(
        ty,
        var!(Instruction::InitIgp(rec!(InitIgp {
            salt: h256(1),
            owner: Some(pk(1)),
            beneficiary: pk(2),
        }))),
    );
    g.borsh(
        ty,
        var!(Instruction::InitOverheadIgp(rec!(InitOverheadIgp {
            salt: h256(2),
            owner: none::<Pubkey>(),
            inner: pk(3),
        }))),
    );
    g.borsh(
        ty,
        var!(Instruction::PayForGas(rec!(PayForGas {
            message_id: h256(3),
            destination_domain: 42161u32,
            gas_amount: 300_000u64,
        }))),
    );
    g.borsh(
        ty,
        var!(Instruction::QuoteGasPayment(rec!(QuoteGasPayment {
            destination_domain: 10u32,
            gas_amount: 200_000u64,
        }))),
    );
    g.borsh(ty, var!(Instruction::TransferIgpOwnership(Some(pk(4)))));
    g.borsh(
        ty,
        var!(Instruction::TransferOverheadIgpOwnership(none::<Pubkey>())),
    );
    g.borsh(ty, var!(Instruction::SetIgpBeneficiary(pk(5))));
    g.borsh(
        ty,
        var!(Instruction::SetDestinationGasOverheads(vec![
            rec!(GasOverheadConfig {
                destination_domain: 1u32,
                gas_overhead: Some(50_000u64),
            }),
            rec!(GasOverheadConfig {
                destination_domain: 2u32,
                gas_overhead: none::<u64>(),
            }),
        ])),
    );
    g.borsh(
        ty,
        var!(Instruction::SetGasOracleConfigs(vec![
            rec!(GasOracleConfig {
                domain: 1u32,
                gas_oracle: Some(gas_oracle(1)),
            }),
            rec!(GasOracleConfig {
                domain: 2u32,
                gas_oracle: none::<GasOracle>(),
            }),
        ])),
    );
    g.borsh(ty, var!(Instruction::Claim));
    g.borsh_named(
        ty,
        Some("some"),
        var!(Instruction::SetIgpQuoteConfig(Some(igp_fee_config()))),
    );
    g.borsh_named(
        ty,
        Some("none"),
        var!(Instruction::SetIgpQuoteConfig(none::<IgpFeeConfig>())),
    );
    g.borsh_named(
        ty,
        Some("add"),
        var!(Instruction::SetIgpQuoteSigner(var!(
            SetIgpQuoteSignerOperation::Add(h160(0x33))
        ))),
    );
    g.borsh_named(
        ty,
        Some("remove"),
        var!(Instruction::SetIgpQuoteSigner(var!(
            SetIgpQuoteSignerOperation::Remove(h160(0x34))
        ))),
    );
    g.borsh(ty, var!(Instruction::SetIgpMinIssuedAt(-1_234_567i64)));
    g.borsh(ty, var!(Instruction::SubmitIgpQuote(signed_quote())));
    g.borsh(ty, var!(Instruction::CloseIgpTransientQuote));
    g.borsh(ty, var!(Instruction::CloseIgpStandingQuote));
    g.borsh(
        ty,
        var!(Instruction::GetIgpQuoteAccountMetas(rec!(
            GetIgpQuoteAccountMetas {
                destination_domain: 8453u32,
                sender: pk(6),
                scoped_salt: Some(h256(7)),
            }
        ))),
    );
    g.assert_variants(
        ty,
        &variants!(igp::instruction::Instruction => [
            Init,
            InitIgp(_),
            InitOverheadIgp(_),
            PayForGas(_),
            QuoteGasPayment(_),
            TransferIgpOwnership(_),
            TransferOverheadIgpOwnership(_),
            SetIgpBeneficiary(_),
            SetDestinationGasOverheads(_),
            SetGasOracleConfigs(_),
            Claim,
            SetIgpQuoteConfig(_),
            SetIgpQuoteSigner(_),
            SetIgpMinIssuedAt(_),
            SubmitIgpQuote(_),
            CloseIgpTransientQuote,
            CloseIgpStandingQuote,
            GetIgpQuoteAccountMetas(_),
        ]),
    );

    // Standalone types that appear in return data / configs.
    g.borsh_named(
        "InterchainGasPaymasterType",
        Some("igp"),
        var!(InterchainGasPaymasterType::Igp(pk(8))),
    );
    g.borsh_named(
        "InterchainGasPaymasterType",
        Some("overhead_igp"),
        var!(InterchainGasPaymasterType::OverheadIgp(pk(9))),
    );

    // Accounts (`AccountData<DiscriminatorPrefixed<T>>` unless noted).
    g.account_prefixed(
        "ProgramData",
        None,
        prefixed(rec!(ProgramData {
            bump_seed: 255u8,
            payment_count: 99u64,
        })),
    );
    g.account_prefixed(
        "OverheadIgp",
        None,
        prefixed(rec!(OverheadIgp {
            bump_seed: 254u8,
            salt: h256(10),
            owner: Some(pk(10)),
            inner: pk(11),
            gas_overheads: hash_map(vec![(1u32, 10_000u64), (10u32, 20_000u64)]),
        })),
    );
    g.account_prefixed(
        "Igp",
        Some("with_fee_config"),
        prefixed(rec!(Igp {
            bump_seed: 253u8,
            salt: h256(12),
            owner: Some(pk(12)),
            beneficiary: pk(13),
            gas_oracles: hash_map(vec![(1u32, gas_oracle(1)), (42161u32, gas_oracle(2))]),
            fee_config: opt_disc(Some(igp_fee_config())),
        })),
    );
    g.account_prefixed(
        "Igp",
        Some("without_fee_config"),
        prefixed(rec!(Igp {
            bump_seed: 252u8,
            salt: h256(14),
            owner: none::<Pubkey>(),
            beneficiary: pk(14),
            gas_oracles: hash_map(vec![(5u32, gas_oracle(3))]),
            fee_config: opt_disc_none(),
        })),
    );
    g.account_prefixed(
        "GasPaymentData",
        None,
        prefixed(rec!(GasPaymentData {
            sequence_number: 1234u64,
            igp: pk(15),
            destination_domain: 137u32,
            message_id: h256(15),
            gas_amount: 100_000u64,
            payment: 2_500_000u64,
            unique_gas_payment_pubkey: pk(16),
            slot: 300_000_000u64,
        })),
    );
    g.account_prefixed(
        "IgpStandingQuote",
        None,
        prefixed(rec!(IgpStandingQuote {
            bump_seed: 251u8,
            fee_token_mint: pk(17),
            destination_domain: 56u32,
            sender: pk(18),
            token_exchange_rate: 12_345_678_901_234_567_890u128,
            gas_price: 3_000_000_000u128,
            token_decimals: 18u8,
            issued_at: 1_700_000_100i64,
            expiry: 1_700_086_500i64,
        })),
    );
    g.account_prefixed(
        "IgpTransientQuote",
        None,
        prefixed(rec!(IgpTransientQuote {
            bump_seed: 250u8,
            payer: pk(19),
            scoped_salt: h256(19),
            fee_token_mint: pk(20),
            destination_domain: 43114u32,
            sender: pk(21),
            token_exchange_rate: 98_765_432_109_876_543_210u128,
            gas_price: 1_000_000u128,
            token_decimals: 6u8,
            expiry: 1_700_000_200i64,
        })),
    );

    // Signed-quote payloads: fixed-layout byte strings parsed with `TryFrom<&[u8]>`
    // (decode direction; `hex` is the input).
    let ctx_bytes = seq::<IGP_QUOTE_CONTEXT_SIZE>(0x30);
    let ctx = IgpQuoteContext::try_from(&ctx_bytes[..]).unwrap();
    g.record(
        "IgpQuoteContext",
        None,
        "custom:IgpQuoteContext::try_from",
        None,
        rec!(IgpQuoteContext {
            fee_token_mint: ctx.fee_token_mint,
            destination_domain: ctx.destination_domain,
            sender: ctx.sender,
        }),
        |_| ctx_bytes.to_vec(),
    );
    let data_bytes = seq::<IGP_QUOTE_DATA_SIZE>(0x70);
    let data = IgpQuoteData::try_from(&data_bytes[..]).unwrap();
    g.record(
        "IgpQuoteData",
        None,
        "custom:IgpQuoteData::try_from",
        None,
        rec!(IgpQuoteData {
            token_exchange_rate: data.token_exchange_rate,
            gas_price: data.gas_price,
            token_decimals: data.token_decimals,
        }),
        |_| data_bytes.to_vec(),
    );

    // Instruction builders.
    g.instruction(
        "init_instruction",
        init_instruction(program_id, pk(30)).unwrap(),
    );
    g.instruction(
        "init_igp_instruction",
        init_igp_instruction(program_id, pk(30), h256(1), Some(pk(31)), pk(32)).unwrap(),
    );
    g.instruction(
        "init_overhead_igp_instruction",
        init_overhead_igp_instruction(program_id, pk(30), h256(2), None, pk(33)).unwrap(),
    );
    g.instruction(
        "set_destination_gas_overheads",
        set_destination_gas_overheads(
            program_id,
            pk(34),
            pk(35),
            vec![GasOverheadConfig {
                destination_domain: 1,
                gas_overhead: Some(5),
            }],
        )
        .unwrap(),
    );
    g.instruction(
        "set_gas_oracle_configs_instruction",
        set_gas_oracle_configs_instruction(
            program_id,
            pk(36),
            pk(35),
            vec![GasOracleConfig {
                domain: 1,
                gas_oracle: Some(gas_oracle(4).value),
            }],
        )
        .unwrap(),
    );
    let (pay_ix, gas_payment_pda) = pay_for_gas_instruction(
        program_id,
        pk(30),
        pk(36),
        Some(pk(34)),
        pk(37),
        h256(3),
        42161,
        300_000,
    )
    .unwrap();
    g.instruction("pay_for_gas_instruction", pay_ix);
    g.constant("pay_for_gas_instruction.gas_payment_pda", gas_payment_pda);
    g.instruction(
        "transfer_igp_account_ownership_instruction.igp",
        transfer_igp_account_ownership_instruction(
            program_id,
            InterchainGasPaymasterType::Igp(pk(36)),
            pk(35),
            Some(pk(38)),
        )
        .unwrap(),
    );
    g.instruction(
        "transfer_igp_account_ownership_instruction.overhead_igp",
        transfer_igp_account_ownership_instruction(
            program_id,
            InterchainGasPaymasterType::OverheadIgp(pk(34)),
            pk(35),
            None,
        )
        .unwrap(),
    );
    g.instruction(
        "claim_instruction",
        claim_instruction(program_id, pk(36), pk(39)).unwrap(),
    );
    g.instruction(
        "set_beneficiary_instruction",
        set_beneficiary_instruction(program_id, pk(36), pk(35), pk(40)).unwrap(),
    );
    g.instruction(
        "set_igp_quote_config_instruction",
        set_igp_quote_config_instruction(program_id, pk(36), pk(35), Some(igp_fee_config().value))
            .unwrap(),
    );
    g.instruction(
        "set_igp_quote_signer_instruction",
        set_igp_quote_signer_instruction(
            program_id,
            pk(36),
            pk(35),
            SetIgpQuoteSignerOperation::Add(h160(0x33)),
        )
        .unwrap(),
    );
    g.instruction(
        "set_igp_min_issued_at_instruction",
        set_igp_min_issued_at_instruction(program_id, pk(36), pk(35), 1_700_000_000).unwrap(),
    );
    g.instruction(
        "submit_igp_quote_instruction",
        submit_igp_quote_instruction(program_id, pk(30), pk(36), pk(41), signed_quote().value)
            .unwrap(),
    );
    g.instruction(
        "close_igp_transient_quote_instruction",
        close_igp_transient_quote_instruction(program_id, pk(41), pk(30), pk(36)).unwrap(),
    );
    g.instruction(
        "close_igp_standing_quote_instruction",
        close_igp_standing_quote_instruction(program_id, pk(42), pk(36), pk(39)).unwrap(),
    );
    g.instruction(
        "get_igp_quote_account_metas_instruction",
        get_igp_quote_account_metas_instruction(program_id, pk(36), 8453, pk(6), Some(h256(7)))
            .unwrap(),
    );

    // PDAs.
    let salt = h256(1);
    let igp_account = pk(36);
    let mint = pk(17);
    let dest_le = 56u32.to_le_bytes();
    let sender = pk(18);
    let scoped_salt = h256(19);
    let unique = pk(37);
    g.pda(
        "program_data",
        &program_id,
        igp::igp_program_data_pda_seeds!(),
    );
    g.pda("igp", &program_id, igp::igp_pda_seeds!(salt));
    g.pda(
        "overhead_igp",
        &program_id,
        igp::overhead_igp_pda_seeds!(salt),
    );
    g.pda(
        "standing_quote",
        &program_id,
        igp::igp_standing_quote_pda_seeds!(igp_account, mint, &dest_le, sender),
    );
    g.pda(
        "transient_quote",
        &program_id,
        igp::igp_transient_quote_pda_seeds!(igp_account, scoped_salt),
    );
    g.pda(
        "quote_authority (derived under the calling program)",
        &pk(0xB5),
        igp::igp_quote_authority_pda_seeds!(),
    );
    g.pda(
        "gas_payment",
        &program_id,
        igp::igp_gas_payment_pda_seeds!(unique),
    );

    error_codes!(g, igp::error::Error => [
        NoGasOracleSetForDestinationDomain,
        QuoteConfigNotSet,
        InvalidIgpQuoteContext,
        InvalidIgpQuoteData,
        NonDefaultFeeTokenMint,
        StandingQuoteNotExpired,
        BeneficiaryMismatch,
    ]);

    g.constant("TOKEN_EXCHANGE_RATE_SCALE", TOKEN_EXCHANGE_RATE_SCALE);
    g.constant("SOL_DECIMALS", SOL_DECIMALS);
    g.constant_bytes("GAS_PAYMENT_DISCRIMINATOR", GAS_PAYMENT_DISCRIMINATOR);
    g.constant_bytes("ProgramData.DISCRIMINATOR", &ProgramData::DISCRIMINATOR);
    g.constant_bytes("OverheadIgp.DISCRIMINATOR", &OverheadIgp::DISCRIMINATOR);
    g.constant_bytes("Igp.DISCRIMINATOR", &Igp::DISCRIMINATOR);
    g.constant_bytes("IgpFeeConfig.DISCRIMINATOR", &IgpFeeConfig::DISCRIMINATOR);
    g.constant_bytes(
        "IgpStandingQuote.DISCRIMINATOR",
        &IgpStandingQuote::DISCRIMINATOR,
    );
    g.constant_bytes(
        "IgpTransientQuote.DISCRIMINATOR",
        &IgpTransientQuote::DISCRIMINATOR,
    );
    g.constant("WILDCARD_SENDER", WILDCARD_SENDER);
    g.constant("WILDCARD_DOMAIN", WILDCARD_DOMAIN);
    g.constant("IGP_QUOTE_CONTEXT_SIZE", IGP_QUOTE_CONTEXT_SIZE);
    g.constant("IGP_QUOTE_DATA_SIZE", IGP_QUOTE_DATA_SIZE);

    g
}
