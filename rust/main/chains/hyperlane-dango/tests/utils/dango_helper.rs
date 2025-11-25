use {
    async_trait::async_trait,
    dango_hyperlane_types::isms,
    dango_testing::{TestAccount, TestAccounts},
    dango_types::{
        config::AppConfig,
        gateway::{self, Origin, Remote},
    },
    grug::{
        btree_set, Addr, BroadcastClientExt, ClientWrapper, Coin, Coins, GasOption, HexByteArray,
        Message, QueryClientExt, SearchTxClient, SearchTxOutcome, Signer,
    },
    hyperlane_base::settings::SignerConf,
    std::{collections::BTreeSet, time::Duration},
    tokio::time::sleep,
};

const PREDEFINED_GAS: GasOption = GasOption::Predefined {
    gas_limit: 10_000_000,
};

pub struct ChainHelper {
    pub cfg: AppConfig,
    pub client: ClientWrapper<anyhow::Error>,
    pub accounts: TestAccounts,
    pub chain_id: String,
    pub hyperlane_domain: u32,
    pub httpd_urls: Vec<String>,
}

impl ChainHelper {
    pub async fn new(
        client: ClientWrapper<anyhow::Error>,
        accounts: TestAccounts,
        chain_id: String,
        hyperlane_domain: u32,
        httpd_urls: Vec<String>,
    ) -> anyhow::Result<Self> {
        let cfg = client.query_app_config(None).await?;

        Ok(Self {
            cfg,
            client,
            accounts,
            chain_id,
            hyperlane_domain,
            httpd_urls,
        })
    }

    pub async fn send_remote(
        &mut self,
        sender: &str,
        coin: Coin,
        destination_domain: u32,
        remote_warp: Addr,
        recipient: Addr,
    ) -> anyhow::Result<SearchTxOutcome> {
        self.client
            .broadcast_and_find(
                self.accounts
                    .users_mut()
                    .find(|user| user.username.to_string() == sender)
                    .expect(&format!("account not found: {}", sender)),
                Message::execute(
                    self.cfg.addresses.gateway,
                    &gateway::ExecuteMsg::TransferRemote {
                        remote: gateway::Remote::Warp {
                            domain: destination_domain,
                            contract: remote_warp.into(),
                        },
                        recipient: recipient.into(),
                    },
                    coin.clone(),
                )?,
                PREDEFINED_GAS,
                &self.chain_id,
            )
            .await
    }

    pub async fn set_route(
        &mut self,
        token: Origin,
        remote_warp: Addr,
        remote_domain: u32,
    ) -> anyhow::Result<SearchTxOutcome> {
        self.client
            .broadcast_and_find(
                &mut self.accounts.owner,
                Message::execute(
                    self.cfg.addresses.gateway,
                    &gateway::ExecuteMsg::SetRoutes(btree_set!((
                        token,
                        self.cfg.addresses.warp,
                        Remote::Warp {
                            domain: remote_domain,
                            contract: remote_warp.into()
                        }
                    ))),
                    Coins::default(),
                )?,
                PREDEFINED_GAS,
                &self.chain_id,
            )
            .await
    }

    pub async fn set_validator_set(
        &mut self,
        remote_domain: u32,
        threshold: u32,
        validators: BTreeSet<HexByteArray<20>>,
    ) -> anyhow::Result<SearchTxOutcome> {
        self.client
            .broadcast_and_find(
                &mut self.accounts.owner,
                Message::execute(
                    self.cfg.addresses.hyperlane.ism,
                    &isms::multisig::ExecuteMsg::SetValidators {
                        domain: remote_domain,
                        threshold,
                        validators,
                    },
                    Coins::default(),
                )?,
                PREDEFINED_GAS,
                &self.chain_id,
            )
            .await
    }

    pub fn get_account(&self, username: &str) -> &TestAccount {
        self.accounts
            .users()
            .find(|user| user.username.to_string() == username)
            .expect(&format!("account not found: {}", username))
    }
}

#[async_trait]
pub trait ClientExt {
    async fn broadcast_and_find<S>(
        &self,
        signer: &mut S,
        message: Message,
        gas_opt: GasOption,
        chain_id: &str,
    ) -> anyhow::Result<SearchTxOutcome>
    where
        S: Signer + Send + Sync + 'static;
}

#[async_trait]
impl ClientExt for ClientWrapper<anyhow::Error> {
    async fn broadcast_and_find<S>(
        &self,
        signer: &mut S,
        message: Message,
        gas_opt: GasOption,
        chain_id: &str,
    ) -> anyhow::Result<SearchTxOutcome>
    where
        S: Signer + Send + Sync + 'static,
    {
        let broadcast_outcome = self
            .send_message(signer, message, gas_opt, chain_id)
            .await?
            .into_result()
            .map_err(|e| anyhow::anyhow!(e.check_tx.error))?;

        let hash = broadcast_outcome.tx_hash;

        let mut counter = 0;

        while counter < 100 {
            let outcome = self.search_tx(hash).await;

            if let Ok(outcome) = outcome {
                return Ok(outcome);
            }

            counter += 1;
            sleep(Duration::from_millis(100)).await;
        }

        Err(anyhow::anyhow!("error while broadcasting tx: {}", hash))
    }
}

pub trait IntoSignerConf {
    fn as_signer_conf(&self) -> SignerConf;
}

impl IntoSignerConf for &TestAccount {
    fn as_signer_conf(&self) -> SignerConf {
        SignerConf::Dango {
            username: self.username.clone(),
            key: HexByteArray::from_inner(self.first_sk().to_bytes().into()),
            address: self.address.into_inner(),
        }
    }
}

impl IntoSignerConf for SignerConf {
    fn as_signer_conf(&self) -> SignerConf {
        self.clone()
    }
}
