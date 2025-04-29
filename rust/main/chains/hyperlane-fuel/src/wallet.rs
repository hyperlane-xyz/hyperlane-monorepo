use async_trait::async_trait;
use fuels::{
    accounts::{
        provider::Provider,
        signers::{kms::aws::AwsKmsSigner, private_key::PrivateKeySigner},
        wallet::Unlocked,
        wallet::Wallet,
        Account, ViewOnlyAccount,
    },
    core::traits::Signer,
    types::{
        bech32::Bech32Address, coin_type_id::CoinTypeId, input::Input,
        transaction_builders::TransactionBuilder, AssetId,
    },
};

/// A wrapper around different types of signers supported by Fuel
pub enum FuelSigners {
    /// A private key signer
    PrivateKey(PrivateKeySigner),
    /// An AWS KMS signer
    AwsKms(AwsKmsSigner),
}

impl FuelSigners {
    /// Get the address of the signer
    pub fn address(&self) -> &Bech32Address {
        match self {
            FuelSigners::PrivateKey(signer) => signer.address(),
            FuelSigners::AwsKms(signer) => signer.address(),
        }
    }
}

/// A wrapper around different types of wallets supported by Fuel
#[derive(Debug, Clone)]
pub enum FuelWallets {
    /// A wallet derived from a private key
    Local(Wallet<Unlocked<PrivateKeySigner>>),
    /// A wallet derived from AWS KMS
    Kms(Wallet<Unlocked<AwsKmsSigner>>),
}

impl FuelWallets {
    /// Create a new wallet from a signer
    pub fn new(signer: FuelSigners, provider: Provider) -> Self {
        match signer {
            FuelSigners::PrivateKey(signer) => FuelWallets::Local(Wallet::new(signer, provider)),
            FuelSigners::AwsKms(signer) => FuelWallets::Kms(Wallet::new(signer, provider)),
        }
    }

    /// Set the provider for the wallet
    pub fn set_provider(&mut self, provider: Provider) {
        match self {
            FuelWallets::Local(wallet) => wallet.set_provider(provider),
            FuelWallets::Kms(wallet) => wallet.set_provider(provider),
        }
    }
}

#[async_trait]
impl ViewOnlyAccount for FuelWallets {
    fn address(&self) -> &Bech32Address {
        match self {
            FuelWallets::Local(wallet) => wallet.address(),
            FuelWallets::Kms(wallet) => wallet.address(),
        }
    }

    fn try_provider(&self) -> fuels::types::errors::Result<&Provider> {
        match self {
            FuelWallets::Local(wallet) => wallet.try_provider(),
            FuelWallets::Kms(wallet) => wallet.try_provider(),
        }
    }

    async fn get_asset_inputs_for_amount(
        &self,
        asset_id: AssetId,
        amount: u128,
        excluded_coins: Option<Vec<CoinTypeId>>,
    ) -> fuels::types::errors::Result<Vec<Input>> {
        match self {
            FuelWallets::Local(wallet) => {
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
            FuelWallets::Local(wallet) => wallet.add_witnesses(_tb),
            FuelWallets::Kms(wallet) => wallet.add_witnesses(_tb),
        }
    }
}
