// Golden cases for the ValidatorAnnounce program. `include!`d by both the program-side
// oracle and the interface crate; see ../src/lib.rs.

pub fn cases() -> GoldenFile {
    use validator_announce::{accounts::*, instruction::*};

    let program_id = pk(0xA2);
    let mut g = GoldenFile::new("validator_announce");

    let ty = "Instruction";
    g.borsh(
        ty,
        var!(Instruction::Init(rec!(InitInstruction {
            mailbox: pk(1),
            local_domain: 1399811149u32,
        }))),
    );
    g.borsh(
        ty,
        var!(Instruction::Announce(rec!(AnnounceInstruction {
            validator: h160(0x20),
            storage_location: "s3://hyperlane-validator-signatures/us-east-1",
            signature: bytes(seq::<65>(0x50)),
        }))),
    );
    g.assert_variants(
        ty,
        &variants!(validator_announce::instruction::Instruction => [Init(_), Announce(_)]),
    );

    g.account(
        "ValidatorAnnounce",
        rec!(ValidatorAnnounce {
            bump_seed: 255u8,
            mailbox: pk(2),
            local_domain: 1399811149u32,
        }),
    );
    g.account_named(
        "ValidatorStorageLocations",
        Some("two"),
        rec!(ValidatorStorageLocations {
            bump_seed: 254u8,
            storage_locations: vec!["s3://bucket-a/region", "gs://bucket-b"],
        }),
    );
    g.account_named(
        "ValidatorStorageLocations",
        Some("empty"),
        rec!(ValidatorStorageLocations {
            bump_seed: 253u8,
            storage_locations: empty::<String>(),
        }),
    );
    g.account(
        "ReplayProtection",
        Rec::raw(ReplayProtection(()), J::Arr(vec![J::Null])),
    );

    let announce = AnnounceInstruction {
        validator: h160(0x20),
        storage_location: "s3://hyperlane-validator-signatures/us-east-1".to_string(),
        signature: seq::<65>(0x50).to_vec(),
    };
    g.constant_bytes("AnnounceInstruction.replay_id", &announce.replay_id());

    g.instruction(
        "init_instruction",
        init_instruction(program_id, pk(3), pk(1), 1399811149).unwrap(),
    );

    let validator = h160(0x20);
    let replay_id = announce.replay_id();
    g.pda(
        "validator_announce",
        &program_id,
        validator_announce::validator_announce_pda_seeds!(),
    );
    g.pda(
        "validator_storage_locations",
        &program_id,
        validator_announce::validator_storage_locations_pda_seeds!(validator),
    );
    g.pda(
        "replay_protection",
        &program_id,
        validator_announce::replay_protection_pda_seeds!(replay_id),
    );

    error_codes!(g, validator_announce::error::Error => [SignatureError, SignerMismatch]);

    g
}
