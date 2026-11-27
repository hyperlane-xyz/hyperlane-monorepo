use account_utils::SizedData;
use hyperlane_core::{Decode, Encode, HyperlaneMessage, H256, U256};
use hyperlane_sealevel_composite_ism::accounts::{
    derive_domain_pda, CompositeIsmAccount, CompositeIsmStorage, DomainIsmAccount,
    DomainIsmStorage, IsmNode,
};
use hyperlane_sealevel_interchain_account_router::{
    accounts::{config_address, interchain_account_address, RouterConfigAccount},
    instruction::{
        call_remote_with_overrides_instruction, init_instruction, CallRemoteWithOverrides,
    },
    message::{Call, InterchainAccountMessage, SealevelCallData},
    processor::{handle_account_metas, process_instruction as router_processor},
};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, MetadataSpec, MetadataSpecResult, VerifyInstruction,
    VerifyMetadataSpecInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_mailbox::{
    accounts::DispatchedMessageAccount,
    instruction::{InboxProcess, InboxProcessFromAccount, Instruction as MailboxInstruction},
    mailbox_dispatched_message_pda_seeds, mailbox_process_authority_pda_seeds,
    mailbox_processed_message_pda_seeds,
    protocol_fee::ProtocolFee,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_test_ism::test_client::TestIsmTestClient;
use hyperlane_sealevel_token_lib::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    hyperlane_token_pda_seeds,
    instruction::{set_interchain_security_module_instruction, transfer_ownership_instruction},
};
use hyperlane_sealevel_token_native::plugin::NativePlugin;
use hyperlane_test_utils::{
    get_ism_verify_account_metas, get_process_account_metas, get_recipient_ism, initialize_mailbox,
    mailbox_id, process_instruction, simulate_instruction, MailboxAccounts,
};
use serializable_account_meta::SimulationReturnData;
use solana_loader_v3_interface::{get_program_data_address, state::UpgradeableLoaderState};
use solana_program::{
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
    rent::Rent,
};
use solana_program_test::*;
use solana_sdk::{
    account::Account,
    signature::Signer,
    signer::keypair::Keypair,
    transaction::{Transaction, TransactionError},
};

const ROUTER: Pubkey = Pubkey::new_from_array([41; 32]);
const WARP: Pubkey = Pubkey::new_from_array([42; 32]);
const CUSTOM_ISM: Pubkey = Pubkey::new_from_array([43; 32]);
const ORIGIN: u32 = 1;
const DESTINATION: u32 = 1399811149;

fn body(calls: Vec<Call>) -> InterchainAccountMessage {
    InterchainAccountMessage {
        owner: [11; 32].into(),
        ism: H256::zero(),
        salt: H256::zero(),
        calls,
    }
}

fn message(body: InterchainAccountMessage) -> HyperlaneMessage {
    HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: ORIGIN,
        sender: [22; 32].into(),
        destination: DESTINATION,
        recipient: ROUTER.to_bytes().into(),
        body: body.encode(),
    }
}

fn handle(message: &HyperlaneMessage) -> HandleInstruction {
    HandleInstruction::new(message.origin, message.sender, message.body.clone())
}

fn ica() -> Pubkey {
    let body = body(vec![]);
    interchain_account_address(
        &ROUTER,
        ORIGIN,
        &body.owner,
        &[22; 32].into(),
        &body.ism,
        &body.salt,
    )
    .0
}

fn native_call(instruction: Instruction) -> Call {
    Call {
        to: instruction.program_id.to_bytes().into(),
        value: U256::zero(),
        data: borsh::to_vec(&SealevelCallData {
            accounts: instruction.accounts.into_iter().map(Into::into).collect(),
            data: instruction.data,
        })
        .unwrap(),
    }
}

struct TestContext {
    context: ProgramTestContext,
    mailbox: MailboxAccounts,
    token: Pubkey,
    upgrade_authority: Keypair,
}

impl TestContext {
    async fn new() -> Self {
        let mut test = Self::uninitialized().await;
        test.initialize().await.unwrap();
        test
    }

    async fn uninitialized() -> Self {
        let upgrade_authority = Keypair::new();
        let mut test = ProgramTest::new(
            "hyperlane_sealevel_interchain_account_router",
            ROUTER,
            processor!(router_processor),
        );
        // BPF_OUT_DIR selects the compiled router; dependencies remain native so
        // testing this program does not require building every other artifact.
        test.prefer_bpf(false);
        test.add_program(
            "hyperlane_sealevel_mailbox",
            mailbox_id(),
            processor!(hyperlane_sealevel_mailbox::processor::process_instruction),
        );
        test.add_program(
            "hyperlane_sealevel_test_ism",
            hyperlane_sealevel_test_ism::id(),
            processor!(hyperlane_sealevel_test_ism::program::process_instruction),
        );
        test.add_program(
            "hyperlane_sealevel_composite_ism",
            CUSTOM_ISM,
            processor!(hyperlane_sealevel_composite_ism::processor::process_instruction),
        );
        test.add_program(
            "hyperlane_sealevel_token_native",
            WARP,
            processor!(hyperlane_sealevel_token_native::processor::process_instruction),
        );
        let (token, bump) = Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &WARP);
        let token_state = HyperlaneTokenAccount::from(HyperlaneToken::<NativePlugin> {
            bump,
            owner: Some(ica()),
            interchain_security_module: Some(hyperlane_sealevel_test_ism::id()),
            ..Default::default()
        });
        let mut data = vec![0; token_state.size()];
        token_state.store_in_slice(&mut data).unwrap();
        test.add_account(
            token,
            Account {
                lamports: Rent::default().minimum_balance(data.len()),
                data,
                owner: WARP,
                ..Account::default()
            },
        );
        let data = bincode::serialize(&UpgradeableLoaderState::ProgramData {
            slot: 0,
            upgrade_authority_address: Some(upgrade_authority.pubkey()),
        })
        .unwrap();
        test.add_account(
            get_program_data_address(&ROUTER),
            Account {
                lamports: Rent::default().minimum_balance(data.len()),
                data,
                owner: solana_sdk_ids::bpf_loader_upgradeable::ID,
                ..Account::default()
            },
        );
        let mut context = test.start_with_context().await;
        let mailbox = initialize_mailbox(
            &mut context.banks_client,
            &mailbox_id(),
            &context.payer,
            DESTINATION,
            0,
            ProtocolFee {
                fee: 0,
                beneficiary: context.payer.pubkey(),
            },
        )
        .await
        .unwrap();
        Self {
            context,
            mailbox,
            token,
            upgrade_authority,
        }
    }

    async fn initialize(&mut self) -> Result<(), BanksClientError> {
        process_instruction(
            &mut self.context.banks_client,
            init_instruction(
                ROUTER,
                mailbox_id(),
                self.context.payer.pubkey(),
                self.upgrade_authority.pubkey(),
            )
            .unwrap(),
            &self.context.payer,
            &[&self.context.payer, &self.upgrade_authority],
        )
        .await
        .map(|_| ())
    }

    async fn delivery_instruction(&mut self, message: &HyperlaneMessage) -> Instruction {
        let accounts = get_process_account_metas(
            &mut self.context.banks_client,
            &self.context.payer,
            &self.mailbox,
            vec![],
            message,
        )
        .await
        .unwrap();
        Instruction {
            program_id: mailbox_id(),
            accounts,
            data: MailboxInstruction::InboxProcess(InboxProcess {
                metadata: vec![],
                message: message.to_vec(),
            })
            .into_instruction_data()
            .unwrap(),
        }
    }

    async fn buffered_delivery_instruction(&mut self, message: &HyperlaneMessage) -> Instruction {
        let mut instruction = self.delivery_instruction(message).await;
        // Uploading is outside this program's scope; seed the buffer directly.
        let buffer = Pubkey::new_unique();
        let data = message.to_vec();
        self.context.set_account(
            &buffer,
            &Account {
                lamports: Rent::default().minimum_balance(data.len()),
                data,
                owner: Pubkey::new_unique(),
                ..Account::default()
            }
            .into(),
        );
        instruction
            .accounts
            .insert(0, AccountMeta::new_readonly(buffer, false));
        instruction.data = MailboxInstruction::InboxProcessFromAccount(InboxProcessFromAccount {
            metadata: vec![],
        })
        .into_instruction_data()
        .unwrap();
        instruction
    }

    async fn submit(&mut self, instruction: Instruction) -> Result<(), BanksClientError> {
        process_instruction(
            &mut self.context.banks_client,
            instruction,
            &self.context.payer,
            &[&self.context.payer],
        )
        .await
        .map(|_| ())
    }

    async fn token_state(&mut self) -> HyperlaneToken<NativePlugin> {
        let account = self
            .context
            .banks_client
            .get_account(self.token)
            .await
            .unwrap()
            .unwrap();
        *HyperlaneTokenAccount::<NativePlugin>::fetch(&mut account.data.as_slice())
            .unwrap()
            .into_inner()
    }

    async fn delivered(&mut self, message: &HyperlaneMessage) -> bool {
        let key = Pubkey::find_program_address(
            mailbox_processed_message_pda_seeds!(message.id()),
            &mailbox_id(),
        )
        .0;
        self.context
            .banks_client
            .get_account(key)
            .await
            .unwrap()
            .is_some()
    }

    fn set_custom_ism(&mut self, node: IsmNode) {
        let (vam, bump_seed) =
            Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &CUSTOM_ISM);
        let storage = CompositeIsmAccount::from(CompositeIsmStorage {
            bump_seed,
            owner: None,
            root: Some(IsmNode::Routing),
        });
        let mut data = vec![0; storage.size()];
        storage.store_in_slice(&mut data).unwrap();
        self.context.set_account(
            &vam,
            &Account {
                lamports: Rent::default().minimum_balance(data.len()),
                data,
                owner: CUSTOM_ISM,
                ..Account::default()
            }
            .into(),
        );
        let (domain, bump_seed) = derive_domain_pda(&CUSTOM_ISM, ORIGIN);
        let storage = DomainIsmAccount::from(DomainIsmStorage {
            bump_seed,
            domain: ORIGIN,
            ism: Some(node),
        });
        let mut data = vec![0; storage.size()];
        storage.store_in_slice(&mut data).unwrap();
        self.context.set_account(
            &domain,
            &Account {
                lamports: Rent::default().minimum_balance(data.len()),
                data,
                owner: CUSTOM_ISM,
                ..Account::default()
            }
            .into(),
        );
    }

    async fn set_default_ism(&mut self, ism: Pubkey) {
        self.submit(Instruction {
            program_id: mailbox_id(),
            accounts: vec![
                AccountMeta::new(self.mailbox.inbox, false),
                AccountMeta::new_readonly(self.mailbox.outbox, false),
                AccountMeta::new_readonly(self.context.payer.pubkey(), true),
            ],
            data: MailboxInstruction::InboxSetDefaultIsm(ism)
                .into_instruction_data()
                .unwrap(),
        })
        .await
        .unwrap();
    }

    async fn metadata_spec(&mut self, message: &HyperlaneMessage) -> MetadataSpec {
        // Match the relayer: a fixed root VAM plus replaceable extra accounts.
        let mut keys = vec![
            config_address(&ROUTER).0,
            derive_domain_pda(&ROUTER, ORIGIN).0,
        ];
        for _ in 0..10 {
            let result = simulate_instruction::<SimulationReturnData<MetadataSpecResult>>(
                &mut self.context.banks_client,
                &self.context.payer,
                Instruction::new_with_bytes(
                    ROUTER,
                    &InterchainSecurityModuleInstruction::VerifyMetadataSpec(
                        VerifyMetadataSpecInstruction::new(message.to_vec()),
                    )
                    .encode()
                    .unwrap(),
                    keys.into_iter()
                        .map(|key| AccountMeta::new_readonly(key, false))
                        .collect(),
                ),
            )
            .await
            .unwrap()
            .unwrap()
            .return_data;
            if let Some(spec) = result.spec {
                return spec;
            }
            assert_eq!(result.accounts[0], config_address(&ROUTER).0);
            keys = result.accounts;
        }
        panic!("metadata discovery did not converge");
    }
}

#[tokio::test]
async fn requires_upgrade_authority_to_initialize() {
    let mut test = TestContext::uninitialized().await;
    let unauthorized = init_instruction(
        ROUTER,
        WARP,
        test.context.payer.pubkey(),
        test.context.payer.pubkey(),
    )
    .unwrap();
    assert!(test.submit(unauthorized).await.is_err());
    assert!(test
        .context
        .banks_client
        .get_account(config_address(&ROUTER).0)
        .await
        .unwrap()
        .is_none());

    // A forged account with a matching authority cannot replace canonical ProgramData.
    let mut forged = init_instruction(
        ROUTER,
        WARP,
        test.context.payer.pubkey(),
        test.context.payer.pubkey(),
    )
    .unwrap();
    let fake = Pubkey::new_unique();
    test.context.set_account(
        &fake,
        &Account {
            lamports: 1_000_000,
            owner: solana_sdk_ids::bpf_loader_upgradeable::ID,
            data: bincode::serialize(&UpgradeableLoaderState::ProgramData {
                slot: 0,
                upgrade_authority_address: Some(test.context.payer.pubkey()),
            })
            .unwrap(),
            ..Account::default()
        }
        .into(),
    );
    forged.accounts[3].pubkey = fake;
    assert!(test.submit(forged).await.is_err());
    let mut unsigned = init_instruction(
        ROUTER,
        mailbox_id(),
        test.context.payer.pubkey(),
        test.upgrade_authority.pubkey(),
    )
    .unwrap();
    unsigned.accounts[4].is_signer = false;
    assert!(test.submit(unsigned).await.is_err());
    test.initialize().await.unwrap();
    let config = test
        .context
        .banks_client
        .get_account(config_address(&ROUTER).0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        RouterConfigAccount::fetch(&mut config.data.as_slice())
            .unwrap()
            .into_inner()
            .mailbox,
        mailbox_id()
    );
    let overwrite = init_instruction(
        ROUTER,
        WARP,
        test.context.payer.pubkey(),
        test.upgrade_authority.pubkey(),
    )
    .unwrap();
    assert!(process_instruction(
        &mut test.context.banks_client,
        overwrite,
        &test.context.payer,
        &[&test.context.payer, &test.upgrade_authority]
    )
    .await
    .is_err());
}

#[tokio::test]
async fn rejects_wrong_programdata_owner_type_and_revoked_authority() {
    for case in 0..3 {
        let mut test = TestContext::uninitialized().await;
        let authority = Some(test.upgrade_authority.pubkey());
        let state = match case {
            1 => UpgradeableLoaderState::Buffer {
                authority_address: authority,
            },
            2 => UpgradeableLoaderState::ProgramData {
                slot: 0,
                upgrade_authority_address: None,
            },
            _ => UpgradeableLoaderState::ProgramData {
                slot: 0,
                upgrade_authority_address: authority,
            },
        };
        test.context.set_account(
            &get_program_data_address(&ROUTER),
            &Account {
                lamports: 1_000_000,
                data: bincode::serialize(&state).unwrap(),
                owner: if case == 0 {
                    Pubkey::new_unique()
                } else {
                    solana_sdk_ids::bpf_loader_upgradeable::ID
                },
                ..Account::default()
            }
            .into(),
        );
        assert!(test.initialize().await.is_err());
    }
}

#[tokio::test]
async fn handle_executes_warp_calls_and_mailbox_prevents_replay() {
    for buffered in [false, true] {
        let mut test = TestContext::new().await;
        let new_ism = Pubkey::new_unique();
        let new_owner = Pubkey::new_unique();
        let mut calls = vec![];
        if buffered {
            calls.push(native_call(
                set_interchain_security_module_instruction(WARP, ica(), Some(new_ism)).unwrap(),
            ));
        }
        calls.push(native_call(
            transfer_ownership_instruction(WARP, ica(), Some(new_owner)).unwrap(),
        ));
        let message = message(body(calls));
        let metas = handle_account_metas(&ROUTER, &handle(&message)).unwrap();
        assert_eq!(metas.len(), 4); // Config, ICA, warp program, shared token state.
        assert!(metas.iter().all(|meta| !meta.is_signer));
        let mut delivery = if buffered {
            test.buffered_delivery_instruction(&message).await
        } else {
            test.delivery_instruction(&message).await
        };
        let count = delivery.accounts.len();
        delivery.accounts.swap(count - 1, count - 2); // CPI order comes from the message.
        let transaction = Transaction::new_signed_with_payer(
            &[delivery.clone()],
            Some(&test.context.payer.pubkey()),
            &[&test.context.payer],
            test.context.last_blockhash,
        );
        assert!(bincode::serialized_size(&transaction).unwrap() <= 1232);
        test.submit(delivery).await.unwrap();
        let state = test.token_state().await;
        assert_eq!(
            state.interchain_security_module,
            Some(if buffered {
                new_ism
            } else {
                hyperlane_sealevel_test_ism::id()
            })
        );
        assert_eq!(state.owner, Some(new_owner));
        assert!(test.delivered(&message).await);
        // A fresh buffer ensures this is a distinct transaction for the same message.
        let replay = test.buffered_delivery_instruction(&message).await;
        assert!(test.submit(replay).await.is_err());
    }
}

#[tokio::test]
async fn handle_executes_a_large_buffered_sol_batch() {
    let mut test = TestContext::new().await;
    let recipient = Pubkey::new_unique();
    let initial_balance = 100_000_000;
    test.context.set_account(
        &ica(),
        &Account {
            lamports: initial_balance,
            ..Account::default()
        }
        .into(),
    );
    let transfer = native_call(solana_system_interface::instruction::transfer(
        &ica(),
        &recipient,
        1_000_000,
    ));
    let message = message(body(vec![transfer; 8]));
    // The full message exceeds Solana's transaction packet limit.
    assert!(message.to_vec().len() > 1232);
    let delivery = test.buffered_delivery_instruction(&message).await;
    test.submit(delivery).await.unwrap();
    for (key, balance) in [(ica(), initial_balance - 8_000_000), (recipient, 8_000_000)] {
        assert_eq!(
            test.context
                .banks_client
                .get_account(key)
                .await
                .unwrap()
                .unwrap()
                .lamports,
            balance
        );
    }
    assert!(test.delivered(&message).await);
}

#[tokio::test]
async fn failed_handle_rolls_back_calls_and_mailbox_delivery() {
    for buffered in [false, true] {
        let mut test = TestContext::new().await;
        let message = message(body(vec![
            native_call(
                transfer_ownership_instruction(WARP, ica(), Some(Pubkey::new_unique())).unwrap(),
            ),
            native_call(
                set_interchain_security_module_instruction(WARP, ica(), Some(Pubkey::new_unique()))
                    .unwrap(),
            ),
        ]));
        let delivery = if buffered {
            test.buffered_delivery_instruction(&message).await
        } else {
            test.delivery_instruction(&message).await
        };
        assert!(test.submit(delivery).await.is_err());
        let state = test.token_state().await;
        assert_eq!(state.owner, Some(ica()));
        assert_eq!(
            state.interchain_security_module,
            Some(hyperlane_sealevel_test_ism::id())
        );
        assert!(!test.delivered(&message).await);
    }
}

#[tokio::test]
async fn custom_ism_overrides_default_without_failure_fallback() {
    for buffered in [false, true] {
        let mut test = TestContext::new().await;
        test.set_custom_ism(IsmNode::Test { accept: true });
        let mut default = TestIsmTestClient::new(
            test.context.banks_client.clone(),
            test.context.payer.insecure_clone(),
        );
        default.set_accept(false).await.unwrap();
        let mut custom_body = body(vec![]);
        custom_body.ism = CUSTOM_ISM.to_bytes().into();
        let custom_ica = interchain_account_address(
            &ROUTER,
            ORIGIN,
            &custom_body.owner,
            &[22; 32].into(),
            &custom_body.ism,
            &custom_body.salt,
        )
        .0;
        assert_ne!(custom_ica, ica());
        test.context.set_account(
            &custom_ica,
            &Account {
                lamports: 1_000_000_000,
                owner: solana_system_interface::program::ID,
                ..Account::default()
            }
            .into(),
        );
        let recipient = Pubkey::new_unique();
        custom_body
            .calls
            .push(native_call(solana_system_interface::instruction::transfer(
                &custom_ica,
                &recipient,
                1_000_000,
            )));
        let custom_message = message(custom_body.clone());
        assert_eq!(
            get_recipient_ism(
                &mut test.context.banks_client,
                &test.context.payer,
                &test.mailbox,
                ROUTER,
            )
            .await
            .unwrap(),
            ROUTER
        );
        assert_eq!(
            test.metadata_spec(&custom_message).await,
            MetadataSpec::Null
        );
        let delivery = if buffered {
            test.buffered_delivery_instruction(&custom_message).await
        } else {
            test.delivery_instruction(&custom_message).await
        };
        test.submit(delivery).await.unwrap();
        assert!(test.delivered(&custom_message).await);
        assert_eq!(
            test.context
                .banks_client
                .get_balance(recipient)
                .await
                .unwrap(),
            1_000_000
        );

        // A rejecting custom ISM must not fall back to an accepting default.
        default.set_accept(true).await.unwrap();
        test.set_custom_ism(IsmNode::Test { accept: false });
        let mut rejected = message(custom_body);
        rejected.nonce = 1;
        assert_eq!(
            test.metadata_spec(&rejected).await,
            MetadataSpec::CannotVerify
        );
        let delivery = test.buffered_delivery_instruction(&rejected).await;
        assert!(test.submit(delivery).await.is_err());
        assert!(!test.delivered(&rejected).await);
        assert_eq!(
            test.context
                .banks_client
                .get_balance(recipient)
                .await
                .unwrap(),
            1_000_000
        );
    }
}

#[tokio::test]
async fn zero_ism_tracks_mailbox_default_and_rejects_stale_accounts() {
    let mut test = TestContext::new().await;
    let message = message(body(vec![native_call(
        transfer_ownership_instruction(WARP, ica(), None).unwrap(),
    )]));
    assert_eq!(test.metadata_spec(&message).await, MetadataSpec::Null);
    let stale = test.delivery_instruction(&message).await;
    test.set_custom_ism(IsmNode::Test { accept: false });
    test.set_default_ism(CUSTOM_ISM).await;
    assert!(test.submit(stale).await.is_err());
    assert!(!test.delivered(&message).await);
    assert_eq!(
        test.metadata_spec(&message).await,
        MetadataSpec::CannotVerify
    );
    let rejected = test.buffered_delivery_instruction(&message).await;
    assert!(test.submit(rejected).await.is_err());
    assert_eq!(test.token_state().await.owner, Some(ica()));
    test.set_custom_ism(IsmNode::Test { accept: true });
    let accepted = test.buffered_delivery_instruction(&message).await;
    test.submit(accepted).await.unwrap();
    assert!(test.delivered(&message).await);
    // Changing the default ISM doesn't change the zero-ISM ICA authority.
    assert_eq!(test.token_state().await.owner, None);
}

#[tokio::test]
async fn forwards_metadata_and_discovers_nested_ism_accounts() {
    let mut test = TestContext::new().await;
    test.set_custom_ism(IsmNode::Aggregation {
        threshold: 1,
        sub_isms: vec![IsmNode::Test { accept: true }],
    });
    let mut custom = body(vec![]);
    custom.ism = CUSTOM_ISM.to_bytes().into();
    let message = message(custom);
    assert_eq!(
        test.metadata_spec(&message).await,
        MetadataSpec::Aggregation {
            threshold: 1,
            sub_specs: vec![MetadataSpec::Null],
        }
    );
    // Discover with valid aggregation metadata; malformed metadata can itself
    // prevent the child's account discovery from succeeding.
    let metadata = vec![0, 0, 0, 8, 0, 0, 0, 8];
    let mut delivery = Instruction {
        program_id: mailbox_id(),
        accounts: get_process_account_metas(
            &mut test.context.banks_client,
            &test.context.payer,
            &test.mailbox,
            metadata.clone(),
            &message,
        )
        .await
        .unwrap(),
        data: MailboxInstruction::InboxProcess(InboxProcess {
            metadata: vec![],
            message: message.to_vec(),
        })
        .into_instruction_data()
        .unwrap(),
    };
    // Routing discovery must resolve the composite's domain PDA.
    assert!(delivery
        .accounts
        .iter()
        .any(|meta| meta.pubkey == derive_domain_pda(&CUSTOM_ISM, ORIGIN).0));
    assert!(test.submit(delivery.clone()).await.is_err());
    assert!(!test.delivered(&message).await);
    // One empty sub-metadata entry: start=end=8, encoded big-endian.
    delivery.data = MailboxInstruction::InboxProcess(InboxProcess {
        metadata,
        message: message.to_vec(),
    })
    .into_instruction_data()
    .unwrap();
    test.submit(delivery).await.unwrap();
    assert!(test.delivered(&message).await);
}

#[tokio::test]
async fn ism_rejects_substituted_accounts_and_recursive_routes() {
    let mut test = TestContext::new().await;
    test.set_custom_ism(IsmNode::Test { accept: true });
    let mut custom = body(vec![]);
    custom.ism = CUSTOM_ISM.to_bytes().into();
    let message = message(custom.clone());
    let accounts = get_ism_verify_account_metas(
        &mut test.context.banks_client,
        &test.context.payer,
        ROUTER,
        vec![],
        message.to_vec(),
    )
    .await
    .unwrap();
    let verify = |accounts, message: &HyperlaneMessage| {
        Instruction::new_with_bytes(
            ROUTER,
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction::new(
                vec![],
                message.to_vec(),
            ))
            .encode()
            .unwrap(),
            accounts,
        )
    };
    for index in 0..4 {
        let mut substituted = accounts.clone();
        substituted[index].pubkey = test.context.payer.pubkey();
        assert!(test.submit(verify(substituted, &message)).await.is_err());
    }
    let inbox = test
        .context
        .banks_client
        .get_account(test.mailbox.inbox)
        .await
        .unwrap()
        .unwrap();
    let mut forged = inbox.clone();
    forged.owner = ROUTER;
    test.context
        .set_account(&test.mailbox.inbox, &forged.into());
    assert!(test
        .submit(verify(accounts.clone(), &message))
        .await
        .is_err());
    test.context.set_account(&test.mailbox.inbox, &inbox.into());
    for ism in [ROUTER, mailbox_id()] {
        let mut recursive = custom.clone();
        recursive.ism = ism.to_bytes().into();
        let recursive = crate::message(recursive);
        assert!(test
            .submit(verify(accounts.clone(), &recursive))
            .await
            .is_err());
    }
    // The zero-body-ISM fallback must also reject a default pointing to self.
    test.set_default_ism(ROUTER).await;
    assert!(test
        .submit(verify(accounts, &crate::message(body(vec![]))))
        .await
        .is_err());
}

#[tokio::test]
async fn requires_mailbox_authentication_and_ism_acceptance() {
    let mut test = TestContext::new().await;
    let message = message(body(vec![native_call(
        transfer_ownership_instruction(WARP, ica(), Some(Pubkey::new_unique())).unwrap(),
    )]));
    let authority =
        Pubkey::find_program_address(mailbox_process_authority_pda_seeds!(&ROUTER), &mailbox_id())
            .0;
    for (key, signer) in [(test.context.payer.pubkey(), true), (authority, false)] {
        let mut accounts = vec![AccountMeta::new_readonly(key, signer)];
        accounts.extend(handle_account_metas(&ROUTER, &handle(&message)).unwrap());
        let direct = Instruction {
            program_id: ROUTER,
            accounts,
            data: MessageRecipientInstruction::Handle(handle(&message))
                .encode()
                .unwrap(),
        };
        assert!(test.submit(direct).await.is_err());
    }
    let delivery = test.delivery_instruction(&message).await;
    let mut ism = TestIsmTestClient::new(
        test.context.banks_client.clone(),
        test.context.payer.insecure_clone(),
    );
    ism.set_accept(false).await.unwrap();
    assert!(test.submit(delivery).await.is_err());
    assert_eq!(test.token_state().await.owner, Some(ica()));
    assert!(!test.delivered(&message).await);
}

#[tokio::test]
async fn handle_rejects_a_substituted_ica_authority() {
    let mut test = TestContext::new().await;
    let message = message(body(vec![native_call(
        transfer_ownership_instruction(WARP, ica(), Some(Pubkey::new_unique())).unwrap(),
    )]));
    let mut delivery = test.delivery_instruction(&message).await;
    for meta in &mut delivery.accounts {
        if meta.pubkey == ica() {
            meta.pubkey = test.context.payer.pubkey();
        }
    }
    assert!(test.submit(delivery).await.is_err());
    assert_eq!(test.token_state().await.owner, Some(ica()));
    assert!(!test.delivered(&message).await);
}

#[tokio::test]
async fn rejects_zero_destination_router() {
    let mut test = TestContext::new().await;
    let instruction = call_remote_with_overrides_instruction(
        ROUTER,
        mailbox_id(),
        test.context.payer.pubkey(),
        test.context.payer.pubkey(),
        test.context.payer.pubkey(),
        CallRemoteWithOverrides {
            destination: ORIGIN,
            router: H256::zero(),
            ism: H256::zero(),
            salt: H256::zero(),
            calls: vec![],
        },
    )
    .unwrap();
    assert!(test.submit(instruction).await.is_err());
}

#[tokio::test]
async fn retries_failed_delivery_after_funding_the_ica() {
    let mut test = TestContext::new().await;
    let recipient = Pubkey::new_unique();
    let message = message(body(vec![native_call(
        solana_system_interface::instruction::transfer(&ica(), &recipient, 1_000_000),
    )]));
    let delivery = test.delivery_instruction(&message).await;
    assert!(test.submit(delivery).await.is_err());
    assert!(!test.delivered(&message).await);
    test.context.set_account(
        &ica(),
        &Account {
            lamports: 100_000_000,
            ..Account::default()
        }
        .into(),
    );
    // A fresh buffer avoids transaction-signature deduplication; same message.
    let retry = test.buffered_delivery_instruction(&message).await;
    test.submit(retry).await.unwrap();
    assert!(test.delivered(&message).await);
    assert_eq!(
        test.context
            .banks_client
            .get_account(recipient)
            .await
            .unwrap()
            .unwrap()
            .lamports,
        1_000_000
    );
}

#[tokio::test]
async fn does_not_inherit_writable_privileges() {
    let mut test = TestContext::new().await;
    let mut call = transfer_ownership_instruction(WARP, ica(), Some(Pubkey::new_unique())).unwrap();
    call.accounts[0].is_writable = false;
    let message = message(body(vec![native_call(call)]));
    let mut delivery = test.delivery_instruction(&message).await;
    for meta in &mut delivery.accounts {
        if meta.pubkey == test.token {
            meta.is_writable = true;
        }
    }
    assert!(test.submit(delivery).await.is_err());
    assert_eq!(test.token_state().await.owner, Some(ica()));
    assert!(!test.delivered(&message).await);
}

#[tokio::test]
async fn does_not_inherit_the_relayer_signature() {
    let mut test = TestContext::new().await;
    let recipient = Pubkey::new_unique();
    let mut transfer = solana_system_interface::instruction::transfer(
        &test.context.payer.pubkey(),
        &recipient,
        1_000_000,
    );
    // This account signs the outer transaction, but the authenticated CPI does
    // not request its signature. Passing all AccountInfos must not lend it one.
    transfer.accounts[0].is_signer = false;
    let message = message(body(vec![native_call(transfer)]));
    let delivery = test.delivery_instruction(&message).await;
    assert!(test.submit(delivery).await.is_err());
    assert!(!test.delivered(&message).await);
    assert!(test
        .context
        .banks_client
        .get_account(recipient)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn dispatches_evm_calls_with_authenticated_owner() {
    let mut test = TestContext::new().await;
    let owner = Keypair::new();
    let unique_message = Keypair::new();
    let evm = InterchainAccountMessage {
        owner: owner.pubkey().to_bytes().into(),
        ism: [33; 32].into(),
        salt: [44; 32].into(),
        calls: vec![Call {
            to: [55; 32].into(),
            value: U256::MAX,
            data: vec![0x12, 0x34],
        }],
    };
    let instruction = call_remote_with_overrides_instruction(
        ROUTER,
        mailbox_id(),
        owner.pubkey(),
        test.context.payer.pubkey(),
        unique_message.pubkey(),
        CallRemoteWithOverrides {
            destination: ORIGIN,
            router: [22; 32].into(),
            ism: evm.ism,
            salt: evm.salt,
            calls: evm.calls.clone(),
        },
    )
    .unwrap();
    for missing_signer in [1, 8] {
        let mut unsigned = instruction.clone();
        unsigned.accounts[missing_signer].is_signer = false;
        let signers = if missing_signer == 1 {
            vec![&test.context.payer, &unique_message]
        } else {
            vec![&test.context.payer, &owner]
        };
        assert!(process_instruction(
            &mut test.context.banks_client,
            unsigned,
            &test.context.payer,
            &signers,
        )
        .await
        .is_err());
    }
    let mut wrong_storage = instruction.clone();
    wrong_storage.accounts[9].pubkey = Pubkey::new_unique();
    assert!(process_instruction(
        &mut test.context.banks_client,
        wrong_storage,
        &test.context.payer,
        &[&test.context.payer, &owner, &unique_message],
    )
    .await
    .is_err());
    process_instruction(
        &mut test.context.banks_client,
        instruction,
        &test.context.payer,
        &[&test.context.payer, &owner, &unique_message],
    )
    .await
    .unwrap();
    let unique = unique_message.pubkey();
    let dispatched = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(&unique),
        &mailbox_id(),
    )
    .0;
    let account = test
        .context
        .banks_client
        .get_account(dispatched)
        .await
        .unwrap()
        .unwrap();
    let dispatched = DispatchedMessageAccount::fetch(&mut account.data.as_slice())
        .unwrap()
        .into_inner();
    let message = HyperlaneMessage::read_from(&mut dispatched.encoded_message.as_slice()).unwrap();
    assert_eq!(message.sender, ROUTER.to_bytes().into());
    assert_eq!(message.destination, ORIGIN);
    assert_eq!(message.recipient, [22; 32].into());
    assert_eq!(message.body, evm.encode());
}

#[tokio::test]
async fn rejects_reused_unique_message_signer_even_with_a_different_salt() {
    let mut test = TestContext::new().await;
    let first = Keypair::new();
    let second = Keypair::new();
    for (unique, salt, succeeds) in [(&first, 0, true), (&first, 1, false), (&second, 0, true)] {
        let instruction = call_remote_with_overrides_instruction(
            ROUTER,
            mailbox_id(),
            test.context.payer.pubkey(),
            test.context.payer.pubkey(),
            unique.pubkey(),
            CallRemoteWithOverrides {
                destination: ORIGIN,
                router: [22; 32].into(),
                ism: H256::zero(),
                salt: H256::repeat_byte(salt),
                calls: vec![],
            },
        )
        .unwrap();
        // A different salt makes the replay a distinct transaction, while
        // retaining the same unique signer and dispatched-message account.
        let dispatched_key = instruction.accounts[9].pubkey;
        assert_eq!(
            process_instruction(
                &mut test.context.banks_client,
                instruction,
                &test.context.payer,
                &[&test.context.payer, unique],
            )
            .await
            .is_ok(),
            succeeds
        );
        let account = test
            .context
            .banks_client
            .get_account(dispatched_key)
            .await
            .unwrap()
            .unwrap();
        let dispatched = DispatchedMessageAccount::fetch(&mut account.data.as_slice())
            .unwrap()
            .into_inner();
        let message =
            HyperlaneMessage::read_from(&mut dispatched.encoded_message.as_slice()).unwrap();
        // The failed send must not overwrite the original dispatched message.
        assert_eq!(
            InterchainAccountMessage::decode(&message.body)
                .unwrap()
                .salt,
            H256::zero()
        );
    }
}

#[tokio::test]
async fn mailbox_callbacks_fail_and_roll_back_the_batch() {
    let mut test = TestContext::new().await;
    test.context.set_account(
        &ica(),
        &Account {
            lamports: 100_000_000,
            ..Account::default()
        }
        .into(),
    );
    let direct_callback = Instruction {
        program_id: mailbox_id(),
        accounts: vec![AccountMeta::new_readonly(test.mailbox.outbox, false)],
        data: MailboxInstruction::OutboxGetCount
            .into_instruction_data()
            .unwrap(),
    };
    let dispatch_callback = call_remote_with_overrides_instruction(
        ROUTER,
        mailbox_id(),
        ica(),
        ica(),
        ica(),
        CallRemoteWithOverrides {
            destination: ORIGIN,
            router: [22; 32].into(),
            ism: H256::zero(),
            salt: H256::zero(),
            calls: vec![],
        },
    )
    .unwrap();
    for callback in [direct_callback, dispatch_callback] {
        let message = message(body(vec![
            native_call(
                transfer_ownership_instruction(WARP, ica(), Some(Pubkey::new_unique())).unwrap(),
            ),
            native_call(callback),
        ]));
        let delivery = test.buffered_delivery_instruction(&message).await;
        let error = test.submit(delivery).await.unwrap_err();
        // ProgramTest's native CPI shim panics when converting the runtime's
        // reentrancy error, surfacing it as ProgramFailedToComplete.
        assert!(
            matches!(
                error,
                BanksClientError::TransactionError(TransactionError::InstructionError(
                    _,
                    InstructionError::ReentrancyNotAllowed
                        | InstructionError::ProgramFailedToComplete
                ))
            ),
            "unexpected callback failure: {error:?}"
        );
        assert_eq!(test.token_state().await.owner, Some(ica()));
        assert!(!test.delivered(&message).await);
    }
}

#[tokio::test]
async fn rejects_value_and_foreign_signers() {
    let mut test = TestContext::new().await;
    let call = native_call(
        transfer_ownership_instruction(WARP, ica(), Some(Pubkey::new_unique())).unwrap(),
    );
    let valid = message(body(vec![call.clone()]));
    let mut valued_call = call;
    valued_call.value = 1.into();
    let foreign_signer =
        native_call(transfer_ownership_instruction(WARP, Pubkey::new_unique(), None).unwrap());
    for body in [body(vec![valued_call]), body(vec![foreign_signer])] {
        let message = message(body);
        assert!(handle_account_metas(&ROUTER, &handle(&message)).is_err());
        // Bypass metadata discovery to prove Handle itself enforces these checks.
        let mut delivery = test.delivery_instruction(&valid).await;
        delivery.accounts[4].pubkey = Pubkey::find_program_address(
            mailbox_processed_message_pda_seeds!(message.id()),
            &mailbox_id(),
        )
        .0;
        delivery.data = MailboxInstruction::InboxProcess(InboxProcess {
            metadata: vec![],
            message: message.to_vec(),
        })
        .into_instruction_data()
        .unwrap();
        assert!(test.submit(delivery).await.is_err());
        assert!(!test.delivered(&message).await);
    }
    assert_eq!(test.token_state().await.owner, Some(ica()));
}

#[test]
fn derives_separate_authorities_for_all_identity_fields() {
    let identity = body(vec![]);
    let sender: H256 = [22; 32].into();
    for (origin, owner, router, ism, salt) in [
        (
            ORIGIN + 1,
            identity.owner,
            sender,
            identity.ism,
            identity.salt,
        ),
        (ORIGIN, [12; 32].into(), sender, identity.ism, identity.salt),
        (
            ORIGIN,
            identity.owner,
            [23; 32].into(),
            identity.ism,
            identity.salt,
        ),
        (
            ORIGIN,
            identity.owner,
            sender,
            [1; 32].into(),
            identity.salt,
        ),
        (ORIGIN, identity.owner, sender, identity.ism, [1; 32].into()),
    ] {
        assert_ne!(
            interchain_account_address(&ROUTER, origin, &owner, &router, &ism, &salt).0,
            ica()
        );
    }
    assert_ne!(config_address(&ROUTER).0, ica());
}
