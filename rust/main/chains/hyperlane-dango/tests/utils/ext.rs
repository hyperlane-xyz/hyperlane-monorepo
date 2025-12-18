use {
    async_trait::async_trait,
    dango_client::{Secret, SingleSigner},
    dango_types::{
        account_factory::{self, UserIndex, UserIndexOrName},
        auth::Nonce,
        config::AppConfig,
    },
    grug::{Defined, QueryClient, QueryClientExt, Undefined},
};

#[async_trait]
pub trait SingleSignerExt<S>: Sized {
    async fn new_first_account<C>(
        client: &C,
        sk: S,
        app_cfg: Option<&AppConfig>,
    ) -> anyhow::Result<Self>
    where
        C: QueryClient,
        anyhow::Error: From<C::Error>;
}

#[async_trait]
impl<S> SingleSignerExt<S> for SingleSigner<S, Defined<UserIndex>, Undefined<Nonce>>
where
    S: Secret + Send + Sync,
{
    async fn new_first_account<C>(
        client: &C,
        sk: S,
        app_cfg: Option<&AppConfig>,
    ) -> anyhow::Result<Self>
    where
        C: QueryClientExt,
        anyhow::Error: From<C::Error>,
    {
        let key_hash = sk.key_hash();

        let factory_addr = match app_cfg {
            Some(cfg) => cfg.addresses.account_factory,
            None => {
                client
                    .query_app_config::<AppConfig>(None)
                    .await?
                    .addresses
                    .account_factory
            }
        };

        let user_index = client
            .query_wasm_smart(
                factory_addr,
                account_factory::QueryForgotUsernameRequest {
                    key_hash,
                    start_after: None,
                    limit: None,
                },
                None,
            )
            .await?
            .first()
            .ok_or(anyhow::anyhow!("No user index found"))?
            .index;

        let address = *client
            .query_wasm_smart(
                factory_addr,
                account_factory::QueryAccountsByUserRequest {
                    user: UserIndexOrName::Index(user_index),
                },
                None,
            )
            .await?
            .first_key_value()
            .ok_or(anyhow::anyhow!("No account found"))?
            .0;

        Ok(SingleSigner::new(address, sk).with_user_index(user_index))
    }
}
