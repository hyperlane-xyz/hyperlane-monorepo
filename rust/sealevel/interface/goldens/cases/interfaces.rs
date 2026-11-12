// Golden cases for the shared interface libraries (ISM, message recipient, multisig ISM,
// simulation return data). These libraries are used directly by both the programs and the
// off-chain code, so this file guards their wire format for non-Rust ports.

pub fn cases() -> GoldenFile {
    use ism_interface::{
        InterchainSecurityModuleInstruction as IsmIx, MetadataSpec, MetadataSpecResult,
        VerifyInstruction, VerifyMetadataSpecInstruction,
    };
    use message_recipient_interface::{HandleInstruction, MessageRecipientInstruction as MrIx};
    use multisig_ism::interface::{MultisigIsmInstruction as MsIx, ValidatorsAndThreshold};
    use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};

    let mut g = GoldenFile::new("interfaces");

    // Interchain security module interface.
    let ty = "ism.InterchainSecurityModuleInstruction";
    let enc = |v: &IsmIx| v.encode().unwrap();
    g.variant_discriminated(ty, None, var!(IsmIx::Type), enc);
    g.variant_discriminated(
        ty,
        None,
        var!(IsmIx::Verify(rec!(VerifyInstruction {
            metadata: bytes(seq::<68>(0x01)),
            message: bytes(seq::<77>(0x80)),
        }))),
        enc,
    );
    g.variant_discriminated(
        ty,
        None,
        var!(IsmIx::VerifyAccountMetas(rec!(VerifyInstruction {
            metadata: bytes(seq::<3>(0x10)),
            message: bytes(seq::<5>(0x20)),
        }))),
        enc,
    );
    g.variant_discriminated(
        ty,
        None,
        var!(IsmIx::VerifyMetadataSpec(rec!(
            VerifyMetadataSpecInstruction {
                message: bytes(seq::<77>(0x30)),
            }
        ))),
        enc,
    );
    g.assert_variants(
        ty,
        &variants!(ism_interface::InterchainSecurityModuleInstruction => [
            Type,
            Verify(_),
            VerifyAccountMetas(_),
            VerifyMetadataSpec(_),
        ]),
    );
    let _ = variants!(ism_interface::MetadataSpec => [
        Null,
        MultisigMessageId { .. },
        Aggregation { .. },
        TrustedRelayer { .. },
        CannotVerify,
    ]);
    g.borsh(
        "ism.MetadataSpecResult",
        rec!(MetadataSpecResult {
            spec: Some(var!(MetadataSpec::Aggregation {
                threshold: 2u8,
                sub_specs: vec![
                    var!(MetadataSpec::Null),
                    var!(MetadataSpec::MultisigMessageId {
                        validators: vec![h160(0x40), h160(0x50)],
                        threshold: 1u8,
                    }),
                    var!(MetadataSpec::TrustedRelayer { relayer: pk(1) }),
                    var!(MetadataSpec::CannotVerify),
                ],
            })),
            accounts: vec![pk(2), pk(3)],
        }),
    );
    g.borsh_named(
        "ism.MetadataSpecResult",
        Some("none"),
        rec!(MetadataSpecResult {
            spec: none::<MetadataSpec>(),
            accounts: empty::<Pubkey>(),
        }),
    );

    // Message recipient interface.
    let ty = "message_recipient.MessageRecipientInstruction";
    let enc = |v: &MrIx| v.encode().unwrap();
    g.variant_discriminated(ty, None, var!(MrIx::InterchainSecurityModule), enc);
    g.variant_discriminated(
        ty,
        None,
        var!(MrIx::InterchainSecurityModuleAccountMetas),
        enc,
    );
    g.variant_discriminated(
        ty,
        None,
        var!(MrIx::Handle(rec!(HandleInstruction {
            origin: 1u32,
            sender: h256(0x60),
            message: bytes(seq::<40>(0x70)),
        }))),
        enc,
    );
    g.variant_discriminated(
        ty,
        None,
        var!(MrIx::HandleAccountMetas(rec!(HandleInstruction {
            origin: 42161u32,
            sender: h256(0x61),
            message: bytes(seq::<4>(0x71)),
        }))),
        enc,
    );
    g.assert_variants(
        ty,
        &variants!(message_recipient_interface::MessageRecipientInstruction => [
            InterchainSecurityModule,
            InterchainSecurityModuleAccountMetas,
            Handle(_),
            HandleAccountMetas(_),
        ]),
    );

    // Multisig ISM interface. The payload is the raw encoded Hyperlane message.
    let ty = "multisig_ism.MultisigIsmInstruction";
    let enc = |v: &MsIx| v.encode().unwrap();
    g.variant_discriminated(
        ty,
        None,
        var!(MsIx::ValidatorsAndThreshold(bytes(seq::<77>(0x90)))),
        enc,
    );
    g.variant_discriminated(
        ty,
        None,
        var!(MsIx::ValidatorsAndThresholdAccountMetas(bytes(seq::<6>(
            0x91
        )))),
        enc,
    );
    g.assert_variants(
        ty,
        &variants!(multisig_ism::interface::MultisigIsmInstruction => [
            ValidatorsAndThreshold(_),
            ValidatorsAndThresholdAccountMetas(_),
        ]),
    );
    g.borsh(
        "multisig_ism.ValidatorsAndThreshold",
        rec!(ValidatorsAndThreshold {
            validators: vec![h160(0xA0), h160(0xB0)],
            threshold: 2u8,
        }),
    );

    // Simulation return data: `borsh(T) || 0xff`. The trailing byte stops the runtime
    // from truncating trailing zero bytes of return data.
    let metas = vec![
        SerializableAccountMeta {
            pubkey: pk(4),
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: pk(5),
            is_signer: true,
            is_writable: false,
        },
    ];
    let metas_json = J::obj([(
        "return_data",
        J::Arr(
            metas
                .iter()
                .map(|m| {
                    J::obj([
                        ("pubkey", J::Str(m.pubkey.to_string())),
                        ("is_signer", J::Bool(m.is_signer)),
                        ("is_writable", J::Bool(m.is_writable)),
                    ])
                })
                .collect(),
        ),
    )]);
    g.borsh_named(
        "serializable_account_meta.SimulationReturnData<Vec<SerializableAccountMeta>>",
        None,
        Rec::raw(SimulationReturnData::new(metas), metas_json),
    );
    g.borsh_named(
        "serializable_account_meta.SimulationReturnData<Option<Pubkey>>",
        None,
        Rec::raw(
            SimulationReturnData::new(Some(pk(6))),
            J::obj([("return_data", J::Str(pk(6).to_string()))]),
        ),
    );

    // PDA seed constants.
    let program_id = pk(0xA7);
    g.pda(
        "ism.VERIFY_ACCOUNT_METAS_PDA_SEEDS",
        &program_id,
        ism_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS,
    );
    g.pda(
        "message_recipient.INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS",
        &program_id,
        message_recipient_interface::INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
    );
    g.pda(
        "message_recipient.HANDLE_ACCOUNT_METAS_PDA_SEEDS",
        &program_id,
        message_recipient_interface::HANDLE_ACCOUNT_METAS_PDA_SEEDS,
    );
    g.pda(
        "multisig_ism.VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS",
        &program_id,
        multisig_ism::interface::VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS,
    );

    error_codes!(g, account_utils::error::AccountError => [ExtraneousAccount]);

    g.constant_bytes(
        "account_utils.PROGRAM_INSTRUCTION_DISCRIMINATOR",
        &account_utils::PROGRAM_INSTRUCTION_DISCRIMINATOR,
    );
    g.constant(
        "account_utils.SPL_NOOP_PROGRAM_ID",
        account_utils::SPL_NOOP_PROGRAM_ID,
    );

    g
}
