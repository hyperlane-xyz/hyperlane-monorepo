use crate::contracts::{MockHyperlaneEnvironment, MockMailbox, TestRecipient};
use color_eyre::Result;
use ethers::{
    core::utils::Anvil,
    middleware::SignerMiddleware,
    providers::{Http, Middleware, Provider},
    signers::{LocalWallet, Signer},
};

use super::anvil::AnvilInstanceWrapper;
use hyperlane_core::{H160, H256};
use std::{sync::Arc, time::Duration};

#[derive(Debug)]
pub struct MockEnvironment {
    #[allow(dead_code)] // Not exposed; need to keep it alive.
    anvil: AnvilInstanceWrapper,
    // Not using this currently:
    // environment: MockHyperlaneEnvironment<SignerMiddleware<Provider<Http>, LocalWallet>>,
    provider: Provider<Http>,
    pub sender_key: H256,
    pub origin_domain: u32,
    pub destination_domain: u32,
    pub gas_pay_address: H160,
    pub rpc_url: String,
    pub mailbox_address: H160,
    pub recipient_address: H160,

    pub origin_mbox_mock: MockMailbox<SignerMiddleware<Provider<Http>, LocalWallet>>,
    pub destination_mbox_mock: MockMailbox<SignerMiddleware<Provider<Http>, LocalWallet>>,
}

impl MockEnvironment {
    pub async fn new() -> Result<Self> {
        let anvil = Anvil::new().spawn();
        let sender_key: [u8; 32] = anvil.keys()[0].to_bytes().try_into()?;
        let sender_key: H256 = sender_key.into();
        let rpc_url = anvil.endpoint();
        let origin_domain = anvil.chain_id() as u32;
        let destination_domain = origin_domain + 1;

        let sender_wallet =
            LocalWallet::from_bytes(sender_key.as_bytes())?.with_chain_id(origin_domain);
        let provider =
            Provider::<Http>::try_from(rpc_url.clone())?.interval(Duration::from_millis(10u64));

        let client = create_client(sender_wallet, provider.clone())?;
        let environment = create_mock_environment_contract(
            Arc::clone(&client),
            origin_domain,
            destination_domain,
        )
        .await?;

        let recipient = create_test_recipient_contract(client.clone()).await?;
        let recipient_address = recipient.address();

        let mailbox_address: H160 = environment.mailboxes(origin_domain).await?;

        let origin_mbox_mock = MockMailbox::new(mailbox_address, client.clone());

        let destination_mbox_addr = environment.mailboxes(destination_domain).await?;
        let destination_mbox_mock = MockMailbox::new(destination_mbox_addr, client.clone());

        Ok(Self {
            anvil: AnvilInstanceWrapper(anvil),
            provider,
            // environment,
            sender_key,
            origin_domain,
            destination_domain,
            gas_pay_address: H160::default(),
            rpc_url,
            mailbox_address,
            recipient_address,
            origin_mbox_mock,
            destination_mbox_mock,
        })
    }

    pub async fn get_block_number(&self) -> Result<u64> {
        Ok(self.provider.get_block_number().await?.as_u64())
    }
}

async fn create_mock_environment_contract<M: Middleware + 'static>(
    client: Arc<M>,
    origin_domain: u32,
    destination_domain: u32,
) -> Result<MockHyperlaneEnvironment<M>> {
    let contract = MockHyperlaneEnvironment::deploy(client, (origin_domain, destination_domain))?;

    let environment = contract.send().await?;

    Ok(environment)
}

async fn create_test_recipient_contract<M: Middleware + 'static>(
    client: Arc<M>,
) -> Result<TestRecipient<M>> {
    let contract = TestRecipient::deploy(client, ())?;

    let recipient = contract.send().await?;

    Ok(recipient)
}

fn create_client(
    wallet: LocalWallet,
    provider: Provider<Http>,
) -> Result<Arc<SignerMiddleware<Provider<Http>, LocalWallet>>> {
    let client = SignerMiddleware::new(provider, wallet);

    Ok(Arc::new(client))
}
