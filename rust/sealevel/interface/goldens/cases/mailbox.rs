// Golden cases for the Mailbox program. `include!`d by both the program-side oracle
// and the interface crate; see ../src/lib.rs.

pub fn cases() -> GoldenFile {
    use mailbox::{accounts::*, instruction::*, protocol_fee::ProtocolFee};

    let program_id = pk(0xA0);
    let mut g = GoldenFile::new("mailbox");

    // Instructions (plain borsh, `Instruction::into_instruction_data`).
    let ty = "Instruction";
    g.borsh(
        ty,
        var!(Instruction::Init(rec!(Init {
            local_domain: 1399811149u32,
            default_ism: pk(1),
            max_protocol_fee: 1_000_000_000u64,
            protocol_fee: rec!(ProtocolFee {
                fee: 5_000u64,
                beneficiary: pk(2),
            }),
        }))),
    );
    g.borsh(
        ty,
        var!(Instruction::InboxProcess(rec!(InboxProcess {
            metadata: bytes(seq::<70>(0x10)),
            message: bytes(seq::<90>(0x40)),
        }))),
    );
    g.borsh(ty, var!(Instruction::InboxSetDefaultIsm(pk(3))));
    g.borsh(ty, var!(Instruction::InboxGetRecipientIsm(pk(4))));
    g.borsh(
        ty,
        var!(Instruction::OutboxDispatch(rec!(OutboxDispatch {
            sender: pk(5),
            destination_domain: 42161u32,
            recipient: h256(0x60),
            message_body: bytes(b"hello world".to_vec()),
        }))),
    );
    g.borsh(ty, var!(Instruction::OutboxGetCount));
    g.borsh(ty, var!(Instruction::OutboxGetLatestCheckpoint));
    g.borsh(ty, var!(Instruction::OutboxGetRoot));
    g.borsh(ty, var!(Instruction::GetOwner));
    g.borsh_named(
        ty,
        Some("some"),
        var!(Instruction::TransferOwnership(Some(pk(6)))),
    );
    g.borsh_named(
        ty,
        Some("none"),
        var!(Instruction::TransferOwnership(none::<Pubkey>())),
    );
    g.borsh(ty, var!(Instruction::ClaimProtocolFees));
    g.borsh(
        ty,
        var!(Instruction::SetProtocolFeeConfig(rec!(ProtocolFee {
            fee: 7u64,
            beneficiary: pk(7),
        }))),
    );
    g.assert_variants(
        ty,
        &variants!(mailbox::instruction::Instruction => [
            Init(_),
            InboxProcess(_),
            InboxSetDefaultIsm(_),
            InboxGetRecipientIsm(_),
            OutboxDispatch(_),
            OutboxGetCount,
            OutboxGetLatestCheckpoint,
            OutboxGetRoot,
            GetOwner,
            TransferOwnership(_),
            ClaimProtocolFees,
            SetProtocolFeeConfig(_),
        ]),
    );

    // Accounts (`AccountData<T>`: 0x01 || borsh(T)).
    g.account(
        "Inbox",
        rec!(Inbox {
            local_domain: 1399811149u32,
            inbox_bump_seed: 254u8,
            default_ism: pk(8),
            processed_count: 123_456_789u64,
        }),
    );
    let mut branch = [H256::zero(); 32];
    for (i, b) in branch.iter_mut().enumerate() {
        *b = h256(i as u8 * 7);
    }
    g.account_named(
        "Outbox",
        Some("owned"),
        rec!(Outbox {
            local_domain: 1399811149u32,
            outbox_bump_seed: 253u8,
            owner: Some(pk(9)),
            tree: rec!(
                hyperlane_core::accumulator::incremental::IncrementalMerkle {
                    branch: branch,
                    count: 77usize,
                }
            ),
            max_protocol_fee: 1_000_000_000u64,
            protocol_fee: rec!(ProtocolFee {
                fee: 5_000u64,
                beneficiary: pk(10),
            }),
        }),
    );
    g.account_named(
        "Outbox",
        Some("unowned"),
        rec!(Outbox {
            local_domain: 1u32,
            outbox_bump_seed: 255u8,
            owner: none::<Pubkey>(),
            tree: rec!(
                hyperlane_core::accumulator::incremental::IncrementalMerkle {
                    branch: [H256::zero(); 32],
                    count: 0usize,
                }
            ),
            max_protocol_fee: 0u64,
            protocol_fee: rec!(ProtocolFee {
                fee: 0u64,
                beneficiary: pk(11),
            }),
        }),
    );
    g.account(
        "DispatchedMessage",
        rec!(DispatchedMessage {
            discriminator: byte_array(*DISPATCHED_MESSAGE_DISCRIMINATOR),
            nonce: 4242u32,
            slot: 987_654_321u64,
            unique_message_pubkey: pk(12),
            encoded_message: bytes(seq::<100>(0x80)),
        }),
    );
    g.account(
        "ProcessedMessage",
        rec!(ProcessedMessage {
            discriminator: byte_array(*PROCESSED_MESSAGE_DISCRIMINATOR),
            sequence: 31337u64,
            message_id: h256(0x90),
            slot: 555_666_777u64,
        }),
    );

    // Instruction builders.
    g.instruction(
        "init_instruction",
        init_instruction(
            program_id,
            1399811149,
            pk(1),
            1_000_000_000,
            ProtocolFee {
                fee: 5_000,
                beneficiary: pk(2),
            },
            pk(13),
        )
        .unwrap(),
    );
    g.instruction(
        "transfer_ownership_instruction",
        transfer_ownership_instruction(program_id, pk(14), Some(pk(15))).unwrap(),
    );
    g.instruction(
        "set_default_ism_instruction",
        set_default_ism_instruction(program_id, pk(14), pk(16)).unwrap(),
    );

    // PDAs.
    let unique = pk(12);
    let recipient = pk(17);
    let message_id = h256(0x90);
    g.pda("inbox", &program_id, mailbox::mailbox_inbox_pda_seeds!());
    g.pda("outbox", &program_id, mailbox::mailbox_outbox_pda_seeds!());
    g.pda(
        "dispatched_message",
        &program_id,
        mailbox::mailbox_dispatched_message_pda_seeds!(unique),
    );
    g.pda(
        "message_dispatch_authority",
        &program_id,
        mailbox::mailbox_message_dispatch_authority_pda_seeds!(),
    );
    g.pda(
        "process_authority",
        &program_id,
        mailbox::mailbox_process_authority_pda_seeds!(recipient),
    );
    g.pda(
        "processed_message",
        &program_id,
        mailbox::mailbox_processed_message_pda_seeds!(message_id),
    );

    error_codes!(g, mailbox::error::Error => [
        EncodeError,
        DecodeError,
        UnsupportedMessageVersion,
        DestinationDomainNotLocalDomain,
        MessageAlreadyProcessed,
        ExtraneousAccount,
        MaxMessageSizeExceeded,
    ]);

    g.constant("VERSION", VERSION);
    g.constant_bytes(
        "DISPATCHED_MESSAGE_DISCRIMINATOR",
        DISPATCHED_MESSAGE_DISCRIMINATOR,
    );
    g.constant_bytes(
        "PROCESSED_MESSAGE_DISCRIMINATOR",
        PROCESSED_MESSAGE_DISCRIMINATOR,
    );

    g
}
