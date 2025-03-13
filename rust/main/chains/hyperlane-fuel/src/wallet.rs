use async_trait::async_trait;
use fuels::{
    accounts::{
        kms::{AwsKmsSigner, KmsWallet},
        provider::Provider,
        wallet::WalletUnlocked,
        Account, ViewOnlyAccount,
    },
    types::{
        bech32::Bech32Address, coin_type_id::CoinTypeId, input::Input,
        transaction_builders::TransactionBuilder, AssetId,
    },
};

/// A wrapper around different types of wallets supported by Fuel
#[derive(Debug, Clone)]
pub enum FuelWallets {
    /// A wallet derived from a private key
    Unlocked(WalletUnlocked),
    /// A wallet derived from AWS KMS
    Kms(KmsWallet<AwsKmsSigner>),
}

impl FuelWallets {
    /// Set the provider for the wallet
    pub fn set_provider(&mut self, provider: Provider) {
        match self {
            FuelWallets::Unlocked(wallet) => wallet.set_provider(provider),
            FuelWallets::Kms(wallet) => wallet.set_provider(provider),
        }
    }
}

#[async_trait]
impl ViewOnlyAccount for FuelWallets {
    fn address(&self) -> &Bech32Address {
        match self {
            FuelWallets::Unlocked(wallet) => wallet.address(),
            FuelWallets::Kms(wallet) => wallet.address(),
        }
    }

    fn try_provider(&self) -> fuels::types::errors::Result<&Provider> {
        match self {
            FuelWallets::Unlocked(wallet) => wallet.try_provider(),
            FuelWallets::Kms(wallet) => wallet.try_provider(),
        }
    }

    async fn get_asset_inputs_for_amount(
        &self,
        asset_id: AssetId,
        amount: u64,
        excluded_coins: Option<Vec<CoinTypeId>>,
    ) -> fuels::types::errors::Result<Vec<Input>> {
        match self {
            FuelWallets::Unlocked(wallet) => {
                wallet
                    .get_asset_inputs_for_amount(asset_id, amount, excluded_coins)
                    .await
            }
            FuelWallets::Kms(wallet) => {
                wallet
                    .get_asset_inputs_for_amount(asset_id, amount, excluded_coins)
                    .await
            }
        }
    }
}

#[async_trait]
impl Account for FuelWallets {
    fn add_witnesses<Tb: TransactionBuilder>(
        &self,
        _tb: &mut Tb,
    ) -> fuels::types::errors::Result<()> {
        match self {
            FuelWallets::Unlocked(wallet) => wallet.add_witnesses(_tb),
            FuelWallets::Kms(wallet) => wallet.add_witnesses(_tb),
        }
    }
}
