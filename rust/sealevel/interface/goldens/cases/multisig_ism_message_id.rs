// Golden cases for the MultisigIsmMessageId program. `include!`d by both the program-side
// oracle and the interface crate; see ../src/lib.rs.

fn validators_and_threshold() -> Rec<multisig_ism_message_id::instruction::ValidatorsAndThreshold> {
    use multisig_ism_message_id::instruction::ValidatorsAndThreshold;
    rec!(ValidatorsAndThreshold {
        validators: vec![h160(0x01), h160(0x40), h160(0x80)],
        threshold: 2u8,
    })
}

pub fn cases() -> GoldenFile {
    use multisig_ism_message_id::{accounts::*, instruction::*};

    let program_id = pk(0xA3);
    let mut g = GoldenFile::new("multisig_ism_message_id");

    // Program instructions are `PROGRAM_INSTRUCTION_DISCRIMINATOR || borsh(Instruction)`.
    // The program also accepts the multisig-ism / ISM interface instructions; see interfaces.json.
    let ty = "Instruction";
    g.discriminated(ty, var!(Instruction::Initialize));
    g.discriminated(
        ty,
        var!(Instruction::SetValidatorsAndThreshold(rec!(Domained {
            domain: 1399811149u32,
            data: validators_and_threshold(),
        }))),
    );
    g.discriminated(ty, var!(Instruction::GetOwner));
    g.discriminated_named(
        ty,
        Some("some"),
        var!(Instruction::TransferOwnership(Some(pk(1)))),
    );
    g.discriminated_named(
        ty,
        Some("none"),
        var!(Instruction::TransferOwnership(none::<Pubkey>())),
    );
    g.assert_variants(
        ty,
        &variants!(multisig_ism_message_id::instruction::Instruction => [
            Initialize,
            SetValidatorsAndThreshold(_),
            GetOwner,
            TransferOwnership(_),
        ]),
    );

    g.account(
        "DomainData",
        rec!(DomainData {
            bump_seed: 255u8,
            validators_and_threshold: validators_and_threshold(),
        }),
    );
    g.account_named(
        "AccessControlData",
        Some("owned"),
        rec!(AccessControlData {
            bump_seed: 254u8,
            owner: Some(pk(2)),
        }),
    );
    g.account_named(
        "AccessControlData",
        Some("unowned"),
        rec!(AccessControlData {
            bump_seed: 253u8,
            owner: none::<Pubkey>(),
        }),
    );

    g.instruction(
        "init_instruction",
        init_instruction(program_id, pk(3)).unwrap(),
    );
    g.instruction(
        "transfer_ownership_instruction",
        transfer_ownership_instruction(program_id, pk(3), Some(pk(4))).unwrap(),
    );
    g.instruction(
        "set_validators_and_threshold_instruction",
        set_validators_and_threshold_instruction(
            program_id,
            pk(3),
            1399811149,
            validators_and_threshold().value,
        )
        .unwrap(),
    );

    let domain = 1399811149u32;
    g.pda(
        "access_control",
        &program_id,
        multisig_ism_message_id::access_control_pda_seeds!(),
    );
    g.pda(
        "domain_data",
        &program_id,
        multisig_ism_message_id::domain_data_pda_seeds!(domain),
    );

    error_codes!(g, multisig_ism_message_id::error::Error => [
        AccountOutOfOrder,
        AccountNotOwner,
        ProgramIdNotOwner,
        AccountNotInitialized,
        InvalidSignatureRecoveryId,
        InvalidSignature,
        ThresholdNotMet,
        InvalidValidatorsAndThreshold,
        AlreadyInitialized,
        InvalidMetadata,
    ]);

    g
}
