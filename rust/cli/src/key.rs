use std::path::Path;
use std::{fs, path::PathBuf};

use ethers::core::k256::ecdsa::SigningKey;
use ethers::core::rand::thread_rng;
use ethers::types::Address;
use ethers::utils::secret_key_to_address;

use anyhow::Result;

#[derive(Debug, clap::Subcommand)]
pub enum KeyCommands {
    /// Generates a signing key for ethereum chain.
    GenerateEthereum {
        /// Full path to the signing key file.
        path: PathBuf,
    },
}

impl KeyCommands {
    pub fn process(&self) -> Result<()> {
        match self {
            Self::GenerateEthereum { path } => {
                // Prevents wiping an existing key file.
                if path.exists() {
                    println!("Signing key: {path:?} already exitsts");
                    return Ok(());
                }

                _ = Self::generate_ethereum(path)?;
                Ok(())
            }
        }
    }

    /// Generates and saves an ethereum signing key into `path`.
    fn generate_ethereum(path: &Path) -> Result<SigningKey> {
        let secret = SigningKey::random(thread_rng());
        let secret_hex = hex::encode(secret.to_bytes());
        fs::write(path, &secret_hex)?;
        println!("\n\nSigning key successfully created:");
        println!("Key in hex: {secret_hex}");
        println!("Key address: {}", get_ethereum_address(&secret));
        Ok(secret)
    }
}

pub fn get_ethereum_signing_key(path: &Path) -> Result<String> {
    Ok(fs::read_to_string(path)?)
}

pub fn get_ethereum_address(key: &SigningKey) -> Address {
    secret_key_to_address(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests creating and retrieving the signing key.
    ///
    /// This test ensures that saved hex key can be restored back
    /// into it's original form.
    #[test]
    fn test_generate_ethereum_success() -> Result<()> {
        let tempdir = tempfile::tempdir()?;
        let tempfile = tempdir.path().join("test_key");

        let expected = KeyCommands::generate_ethereum(&tempfile)?;
        let secret_hex = get_ethereum_signing_key(&tempfile)?;
        let secret_raw = hex::decode(secret_hex)?;
        let actual = SigningKey::from_bytes(&secret_raw)?;
        assert_eq!(expected, actual);

        Ok(())
    }
}
