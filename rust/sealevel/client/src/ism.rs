use solana_program::pubkey::Pubkey;

use crate::{
    deploy_test_ism, multisig_ism::deploy_multisig_ism_message_id,
    trusted_relayer_ism::deploy_trusted_relayer_ism, Context, IsmCmd, IsmDeploy, IsmRead,
    IsmSubCmd, IsmType,
};
use hyperlane_sealevel_multisig_ism_message_id::{
    access_control_pda_seeds,
    accounts::{AccessControlAccount, DomainDataAccount},
    domain_data_pda_seeds,
};
use hyperlane_sealevel_test_ism::program::TestIsmStorageAccount;
use hyperlane_sealevel_trusted_relayer_ism::{
    accounts::StorageAccount as TrustedRelayerStorageAccount,
    storage_pda_seeds as trusted_relayer_pda_seeds,
};

pub(crate) fn process_ism_cmd(mut ctx: Context, cmd: IsmCmd) {
    match cmd.cmd {
        IsmSubCmd::Deploy(deploy) => process_deploy(&mut ctx, deploy),
        IsmSubCmd::Read(read) => process_read(&ctx, read),
    }
}

fn process_deploy(ctx: &mut Context, deploy: IsmDeploy) {
    let program_id = match deploy.ism_type {
        IsmType::MultisigMessageId => deploy_multisig_ism_message_id(
            ctx,
            &deploy.built_so_dir,
            &deploy.key_dir,
            deploy.local_domain,
        ),
        IsmType::TrustedRelayer => {
            let relayer = deploy
                .relayer
                .expect("--relayer is required for --ism-type trusted-relayer");
            deploy_trusted_relayer_ism(
                ctx,
                &deploy.built_so_dir,
                &deploy.key_dir,
                deploy.local_domain,
                relayer,
            )
        }
        IsmType::Test => deploy_test_ism(ctx, &deploy.built_so_dir, &deploy.key_dir),
    };

    println!("Program ID: {}", program_id);
}

fn process_read(ctx: &Context, read: IsmRead) {
    match read.ism_type {
        IsmType::MultisigMessageId => read_multisig_ism(ctx, read.address, read.domains),
        IsmType::TrustedRelayer => read_trusted_relayer_ism(ctx, read.address),
        IsmType::Test => read_test_ism(ctx, read.address),
    }
}

fn read_multisig_ism(ctx: &Context, program_id: Pubkey, domains: Option<Vec<u32>>) {
    let (access_control_pda_key, _) =
        Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);

    let accounts = ctx
        .client
        .get_multiple_accounts_with_commitment(&[access_control_pda_key], ctx.commitment)
        .unwrap()
        .value;

    let access_control = AccessControlAccount::fetch(&mut &accounts[0].as_ref().unwrap().data[..])
        .unwrap()
        .into_inner();
    println!("Access control: {:#?}", access_control);

    if let Some(domains) = domains {
        for domain in domains {
            let (domain_data_pda_key, _) =
                Pubkey::find_program_address(domain_data_pda_seeds!(domain), &program_id);

            let accounts = ctx
                .client
                .get_multiple_accounts_with_commitment(&[domain_data_pda_key], ctx.commitment)
                .unwrap()
                .value;

            if let Some(account) = &accounts[0] {
                let domain_data = DomainDataAccount::fetch(&mut &account.data[..])
                    .unwrap()
                    .into_inner();
                println!("Domain data for {}:\n{:#?}", domain, domain_data);
            } else {
                println!("No domain data for domain {}", domain);
            }
        }
    }
}

fn read_trusted_relayer_ism(ctx: &Context, program_id: Pubkey) {
    let (storage_pda_key, _) =
        Pubkey::find_program_address(trusted_relayer_pda_seeds!(), &program_id);

    let accounts = ctx
        .client
        .get_multiple_accounts_with_commitment(&[storage_pda_key], ctx.commitment)
        .unwrap()
        .value;

    if let Some(account) = &accounts[0] {
        let storage = TrustedRelayerStorageAccount::fetch(&mut &account.data[..])
            .unwrap()
            .into_inner();
        println!("Storage PDA: {}", storage_pda_key);
        println!("{:#?}", storage);
    } else {
        println!("Storage PDA not initialized");
    }
}

fn read_test_ism(ctx: &Context, program_id: Pubkey) {
    let (storage_pda_key, _) = Pubkey::find_program_address(
        hyperlane_sealevel_test_ism::test_ism_storage_pda_seeds!(),
        &program_id,
    );

    let accounts = ctx
        .client
        .get_multiple_accounts_with_commitment(&[storage_pda_key], ctx.commitment)
        .unwrap()
        .value;

    if let Some(account) = &accounts[0] {
        let storage = TestIsmStorageAccount::fetch(&mut &account.data[..])
            .unwrap()
            .into_inner();
        println!("Storage PDA: {}", storage_pda_key);
        println!("{:#?}", storage);
    } else {
        println!("Storage PDA not initialized");
    }
}
