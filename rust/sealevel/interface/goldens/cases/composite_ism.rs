// Golden cases for the CompositeIsm program. `include!`d by both the program-side oracle
// and the interface crate; see ../src/lib.rs.

/// A tree that exercises every `IsmNode` variant.
fn ism_tree() -> Rec<composite_ism::accounts::IsmNode> {
    use composite_ism::accounts::IsmNode;
    var!(IsmNode::Aggregation {
        threshold: 2u8,
        sub_isms: vec![
            var!(IsmNode::TrustedRelayer { relayer: pk(1) }),
            var!(IsmNode::MultisigMessageId {
                validators: vec![h160(0x10), h160(0x20)],
                threshold: 1u8,
            }),
            var!(IsmNode::Test { accept: true }),
            var!(IsmNode::Pausable { paused: false }),
            var!(IsmNode::AmountRouting {
                threshold: U256::from(1_000_000_000_000_000_000u128),
                lower: Box::new(var!(IsmNode::Test { accept: false })),
                upper: Box::new(var!(IsmNode::RateLimited {
                    max_capacity: 5_000_000u64,
                    recipient: Some(h256(0x30)),
                    filled_level: 1_234u64,
                    last_updated: 1_700_000_000i64,
                    mailbox: pk(2),
                })),
            }),
            var!(IsmNode::Routing),
            var!(IsmNode::FallbackRouting {
                fallback_ism: pk(3)
            }),
        ],
    })
}

pub fn cases() -> GoldenFile {
    use composite_ism::{accounts::*, instruction::*};

    let program_id = pk(0xA4);
    let mut g = GoldenFile::new("composite_ism");

    // Program instructions are `PROGRAM_INSTRUCTION_DISCRIMINATOR || borsh(Instruction)`.
    // The program also accepts the ISM interface instructions; see interfaces.json.
    let ty = "Instruction";
    g.discriminated(ty, var!(Instruction::Initialize(ism_tree())));
    g.discriminated(
        ty,
        var!(Instruction::UpdateConfig(var!(IsmNode::TrustedRelayer {
            relayer: pk(4)
        }))),
    );
    g.discriminated(ty, var!(Instruction::GetOwner));
    g.discriminated(ty, var!(Instruction::TransferOwnership(Some(pk(5)))));
    g.discriminated(
        ty,
        var!(Instruction::SetDomainIsm {
            domain: 1399811149u32,
            ism: var!(IsmNode::MultisigMessageId {
                validators: vec![h160(0x40)],
                threshold: 1u8,
            }),
        }),
    );
    g.discriminated(ty, var!(Instruction::RemoveDomainIsm { domain: 42161u32 }));
    g.discriminated(ty, var!(Instruction::Pause));
    g.discriminated(ty, var!(Instruction::Unpause));
    g.assert_variants(
        ty,
        &variants!(composite_ism::instruction::Instruction => [
            Initialize(_),
            UpdateConfig(_),
            GetOwner,
            TransferOwnership(_),
            SetDomainIsm { .. },
            RemoveDomainIsm { .. },
            Pause,
            Unpause,
        ]),
    );
    let _ = variants!(composite_ism::accounts::IsmNode => [
        TrustedRelayer { .. },
        MultisigMessageId { .. },
        Aggregation { .. },
        Test { .. },
        Pausable { .. },
        AmountRouting { .. },
        RateLimited { .. },
        Routing,
        FallbackRouting { .. },
    ]);

    g.account_named(
        "CompositeIsmStorage",
        Some("configured"),
        rec!(CompositeIsmStorage {
            bump_seed: 255u8,
            owner: Some(pk(6)),
            root: Some(ism_tree()),
        }),
    );
    g.account_named(
        "CompositeIsmStorage",
        Some("empty"),
        rec!(CompositeIsmStorage {
            bump_seed: 254u8,
            owner: none::<Pubkey>(),
            root: none::<IsmNode>(),
        }),
    );
    g.account(
        "DomainIsmStorage",
        rec!(DomainIsmStorage {
            bump_seed: 253u8,
            domain: 1399811149u32,
            ism: Some(var!(IsmNode::Pausable { paused: true })),
        }),
    );

    g.instruction(
        "initialize_instruction",
        initialize_instruction(program_id, pk(7), ism_tree().value).unwrap(),
    );
    g.instruction(
        "update_config_instruction",
        update_config_instruction(program_id, pk(7), IsmNode::Routing).unwrap(),
    );
    g.instruction(
        "verify_metadata_spec_instruction",
        verify_metadata_spec_instruction(program_id, seq::<80>(0x60).to_vec(), vec![pk(8), pk(9)])
            .unwrap(),
    );
    g.instruction(
        "set_domain_ism_instruction",
        set_domain_ism_instruction(
            program_id,
            pk(7),
            1399811149,
            IsmNode::Test { accept: true },
        )
        .unwrap(),
    );
    g.instruction(
        "remove_domain_ism_instruction",
        remove_domain_ism_instruction(program_id, pk(7), 42161).unwrap(),
    );
    g.instruction(
        "transfer_ownership_instruction",
        transfer_ownership_instruction(program_id, pk(7), None).unwrap(),
    );
    g.instruction(
        "pause_instruction",
        pause_instruction(program_id, pk(7)).unwrap(),
    );
    g.instruction(
        "unpause_instruction",
        unpause_instruction(program_id, pk(7)).unwrap(),
    );

    let domain = 1399811149u32;
    let mailbox = pk(10);
    let domain_le = domain.to_le_bytes();
    g.pda("storage", &program_id, composite_ism::storage_pda_seeds!());
    g.pda("domain_ism", &program_id, &[DOMAIN_ISM_SEED, &domain_le]);
    assert_eq!(
        g.last_pda(),
        derive_domain_pda(&program_id, domain),
        "derive_domain_pda"
    );
    g.pda(
        "process_authority (derived under the mailbox)",
        &mailbox,
        &[PROCESS_AUTHORITY_SEED, program_id.as_ref()],
    );
    assert_eq!(
        g.last_pda(),
        derive_process_authority(&mailbox, &program_id),
        "derive_process_authority"
    );

    error_codes!(g, composite_ism::error::Error => [
        ProgramIdNotOwner,
        AccountNotInitialized,
        AlreadyInitialized,
        ConfigNotSet,
        InvalidMetadata,
        InvalidSignature,
        ThresholdNotMet,
        NoRouteForDomain,
        InvalidRelayer,
        RelayerNotSigner,
        VerifyRejected,
        InvalidConfig,
        InvalidMessageBody,
        RateLimitExceeded,
        RecipientMismatch,
        MultipleRoutingNodes,
        RoutingInDomainIsm,
        DomainPdaNotWritable,
        InvalidSystemProgram,
        InvalidStoragePda,
        InvalidDomainPda,
        FallbackRoutingInDomainIsm,
        InvalidFallbackIsmAccount,
        FallbackIsmCallFailed,
        FallbackRoutingNotLast,
        InvalidProcessAuthority,
        ProcessAuthorityNotSigner,
        PausableInDomainIsm,
        InvalidProgramDataAccount,
    ]);

    g.constant_bytes("DOMAIN_ISM_SEED", DOMAIN_ISM_SEED);
    g.constant_bytes("PROCESS_AUTHORITY_SEED", PROCESS_AUTHORITY_SEED);

    g
}
