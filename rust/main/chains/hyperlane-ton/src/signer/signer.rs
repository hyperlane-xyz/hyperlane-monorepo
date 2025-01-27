use anyhow::Error;
use base64::{engine::general_purpose, Engine};
use tonlib_core::{
    cell::{ArcCell, BagOfCells, Cell},
    mnemonic::{KeyPair, Mnemonic},
    wallet::{TonWallet, WalletVersion},
    TonAddress,
};

use hyperlane_core::ChainCommunicationError;

use crate::error::HyperlaneTonError;

#[derive(Clone)]
pub struct TonSigner {
    pub address: TonAddress,
    pub wallet: TonWallet,
}

impl TonSigner {
    pub fn new(key_pair: KeyPair, wallet_version: WalletVersion) -> Result<Self, Error> {
        let wallet =
            TonWallet::derive_default(wallet_version, &key_pair).map_err(|e| Error::new(e))?;

        Ok(TonSigner {
            address: wallet.address.clone(),
            wallet,
        })
    }

    pub fn from_mnemonic(
        mnemonic_phrase: Vec<String>,
        wallet_version: WalletVersion,
    ) -> Result<Self, Error> {
        let mnemonic_phrase_str: Vec<&str> =
            mnemonic_phrase.iter().map(|item| item.as_str()).collect();
        let mnemonic = Mnemonic::new(mnemonic_phrase_str, &None).map_err(|e| Error::new(e))?;

        let key_pair = mnemonic.to_key_pair().map_err(|e| Error::new(e))?;

        Self::new(key_pair, wallet_version)
    }
    pub async fn sign_message(&self, body: &Cell) -> Result<Vec<u8>, Error> {
        let signature = self
            .wallet
            .sign_external_body(body)
            .map_err(|e| Error::new(e))?;

        Ok(signature.data().to_vec())
    }
    pub async fn create_signed_message(
        &self,
        transfer_message: Cell,
        now: u32,
        seqno: u32,
    ) -> Result<String, ChainCommunicationError> {
        let message = self
            .wallet
            .create_external_message(now + 60, seqno, vec![ArcCell::new(transfer_message)], false)
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::TonMessageError(format!(
                    "Failed to create external message: {}",
                    e
                )))
            })?;

        let boc = BagOfCells::from_root(message)
            .serialize(true)
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                    "Failed to serialize BOC: {}",
                    e
                )))
            })?;

        Ok(general_purpose::STANDARD.encode(boc))
    }
}

pub fn wallet_version_from_str(name: &str) -> Result<WalletVersion, &'static str> {
    match name {
        "V1R1" => Ok(WalletVersion::V1R1),
        "V1R2" => Ok(WalletVersion::V1R2),
        "V1R3" => Ok(WalletVersion::V1R3),
        "V2R1" => Ok(WalletVersion::V2R1),
        "V2R2" => Ok(WalletVersion::V2R2),
        "V3R1" => Ok(WalletVersion::V3R1),
        "V3R2" => Ok(WalletVersion::V3R2),
        "V4R1" => Ok(WalletVersion::V4R1),
        "V4R2" => Ok(WalletVersion::V4R2),
        "V5R1" => Ok(WalletVersion::V5R1),
        "HighloadV1R1" => Ok(WalletVersion::HighloadV1R1),
        "HighloadV1R2" => Ok(WalletVersion::HighloadV1R2),
        "HighloadV2" => Ok(WalletVersion::HighloadV2),
        "HighloadV2R1" => Ok(WalletVersion::HighloadV2R1),
        "HighloadV2R2" => Ok(WalletVersion::HighloadV2R2),
        _ => Err("Invalid wallet version string"),
    }
}
