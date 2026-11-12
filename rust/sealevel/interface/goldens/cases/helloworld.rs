// Golden cases for the HelloWorld example program. `include!`d by both the program-side
// oracle and the interface crate; see ../src/lib.rs.

pub fn cases() -> GoldenFile {
    use connection_client::router::RemoteRouterConfig;
    use helloworld::{accounts::*, instruction::*};
    use igp::accounts::InterchainGasPaymasterType;

    let program_id = pk(0xA6);
    let mut g = GoldenFile::new("helloworld");

    // Plain borsh. The program also accepts the message-recipient interface.
    let ty = "HelloWorldInstruction";
    g.borsh(
        ty,
        var!(HelloWorldInstruction::Init(rec!(Init {
            local_domain: 1399811149u32,
            mailbox: pk(1),
            ism: Some(pk(2)),
            igp: Some((pk(3), var!(InterchainGasPaymasterType::Igp(pk(4))))),
            owner: Some(pk(5)),
        }))),
    );
    g.borsh(
        ty,
        var!(HelloWorldInstruction::SendHelloWorld(rec!(
            HelloWorldMessage {
                destination: 42161u32,
                message: "hello, world",
            }
        ))),
    );
    g.borsh(
        ty,
        var!(HelloWorldInstruction::SetInterchainSecurityModule(none::<
            Pubkey,
        >(
        ))),
    );
    g.borsh(
        ty,
        var!(HelloWorldInstruction::EnrollRemoteRouters(vec![rec!(
            RemoteRouterConfig {
                domain: 42161u32,
                router: Some(h256(6)),
            }
        )])),
    );
    g.assert_variants(
        ty,
        &variants!(helloworld::instruction::HelloWorldInstruction => [
            Init(_),
            SendHelloWorld(_),
            SetInterchainSecurityModule(_),
            EnrollRemoteRouters(_),
        ]),
    );

    g.account(
        "HelloWorldStorage",
        rec!(HelloWorldStorage {
            local_domain: 1399811149u32,
            mailbox: pk(7),
            ism: Some(pk(8)),
            igp: Some((pk(9), var!(InterchainGasPaymasterType::OverheadIgp(pk(10))))),
            owner: Some(pk(11)),
            sent: 12u64,
            received: 13u64,
            sent_to: hash_map(vec![(1u32, 2u64), (42161u32, 10u64)]),
            received_from: hash_map(vec![(1u32, 3u64)]),
            routers: hash_map(vec![(1u32, h256(12)), (42161u32, h256(13))]),
        }),
    );

    g.instruction(
        "init_instruction",
        init_instruction(
            program_id,
            pk(20),
            1399811149,
            pk(1),
            Some(pk(2)),
            Some((pk(3), InterchainGasPaymasterType::Igp(pk(4)))),
            Some(pk(5)),
        )
        .unwrap(),
    );
    g.instruction(
        "enroll_remote_routers_instruction",
        enroll_remote_routers_instruction(
            program_id,
            pk(21),
            vec![RemoteRouterConfig {
                domain: 1,
                router: None,
            }],
        )
        .unwrap(),
    );
    g.instruction(
        "set_interchain_security_module_instruction",
        set_interchain_security_module_instruction(program_id, pk(21), Some(pk(22))).unwrap(),
    );

    g.pda(
        "storage",
        &program_id,
        helloworld::program_storage_pda_seeds!(),
    );

    g
}
