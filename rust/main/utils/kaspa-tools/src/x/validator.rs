use dym_kas_core::escrow::generate_escrow_priv_key;
use dymension_kaspa::validator::signer::get_ethereum_style_signer;
use secp256k1::PublicKey;
use serde::Serialize;
use std::fs;

use super::args::{ValidatorAwsArgs, ValidatorLocalArgs};

#[derive(Debug, Serialize)]
pub struct ValidatorInfos {
    // HL style address to register on the Hub for the Kaspa multisig ISM
    pub validator_ism_addr: String,
    /// what validator will use to sign checkpoints for new deposits (and also progress indications)
    pub validator_ism_priv_key: String,
    /// secret key to sign kaspa inputs for withdrawals
    pub validator_escrow_secret: String,
    /// and pub key...
    pub validator_escrow_pub_key: String,
}

pub fn create_validator() -> (ValidatorInfos, PublicKey) {
    let kp = generate_escrow_priv_key();
    let s = serde_json::to_string(&kp).unwrap();

    let signer = get_ethereum_style_signer().unwrap();
    let pub_key = kp.public_key();

    let ism_unescaped = signer.address.replace("\"", "");

    (
        ValidatorInfos {
            validator_ism_addr: ism_unescaped,
            validator_ism_priv_key: signer.private_key,
            validator_escrow_secret: s,
            validator_escrow_pub_key: pub_key.to_string(),
        },
        pub_key,
    )
}

pub fn handle_local_backend(args: ValidatorLocalArgs) -> Result<(), Box<dyn std::error::Error>> {
    let mut infos = vec![];

    for _ in 0..args.count {
        let (v, _) = create_validator();
        infos.push(v);
    }

    // Sort required by Hyperlane Cosmos ISM creation
    infos.sort_by(|a, b| a.validator_ism_addr.cmp(&b.validator_ism_addr));

    let json_output = serde_json::to_string_pretty(&infos)?;

    match args.output {
        Some(path) => {
            fs::write(&path, json_output)?;
            println!("Validator keys saved to: {}", path);
        }
        None => {
            println!("{}", json_output);
        }
    }

    Ok(())
}

pub async fn handle_aws_backend(args: ValidatorAwsArgs) -> Result<(), Box<dyn std::error::Error>> {
    use aws_config::BehaviorVersion;
    use aws_sdk_kms::Client as KmsClient;
    use aws_sdk_secretsmanager::Client as SecretsManagerClient;

    let kaspa_keypair = generate_escrow_priv_key();
    let kaspa_pub_key = kaspa_keypair.public_key();

    // Initialize AWS SDK
    let config = aws_config::defaults(BehaviorVersion::latest()).load().await;

    let kms_client = KmsClient::new(&config);
    let sm_client = SecretsManagerClient::new(&config);

    // Validate KMS key exists and is usable
    validate_kms_key(&kms_client, &args.kms_key_id).await?;

    // Normalize the path (remove trailing slash if present)
    let secret_path = args.path.trim_end_matches('/');

    // Serialize ONLY the Kaspa keypair to JSON
    // This is compatible with KaspaSecpKeypair deserialization in the validator agent
    // The secp256k1 crate with serde serializes Keypair as a hex string of the secret key
    let keypair_json = serde_json::to_string(&kaspa_keypair)?;

    let encrypted_keypair = encrypt_with_kms(&kms_client, &args.kms_key_id, &keypair_json).await?;
    let secret_arn =
        store_encrypted_secret(&sm_client, secret_path, encrypted_keypair, "validator keys")
            .await?;

    println!();
    println!("✓ Successfully created Kaspa validator secret!");
    println!();
    println!("Secret ARN: {}", secret_arn);
    println!("Secret ID: {}", secret_path);
    println!("KMS Key ID: {}", args.kms_key_id);
    println!("Kaspa Escrow Public Key: {}", kaspa_pub_key.to_string());

    Ok(())
}

async fn validate_kms_key(
    kms_client: &aws_sdk_kms::Client,
    key_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    match kms_client.describe_key().key_id(key_id).send().await {
        Ok(response) => {
            let key_metadata = response
                .key_metadata()
                .ok_or("KMS key metadata not found")?;

            // Check if key is enabled
            if !key_metadata.enabled() {
                return Err(format!(
                    "KMS key '{}' exists but is not enabled. Please enable it first.",
                    key_id
                )
                .into());
            }

            // AWS Secrets Manager only supports symmetric KMS keys for encryption
            // Check if the key is symmetric (ENCRYPT_DECRYPT usage)
            if let Some(key_usage) = key_metadata.key_usage() {
                if key_usage.as_str() != "ENCRYPT_DECRYPT" {
                    return Err(format!(
                        "KMS key '{}' has key usage '{}' but AWS Secrets Manager requires a symmetric key with ENCRYPT_DECRYPT usage.\n\
                        Please create a symmetric encryption key:\n\
                          aws kms create-key --description \"Hyperlane Validator Keys\" --key-usage ENCRYPT_DECRYPT",
                        key_id, key_usage.as_str()
                    ).into());
                }
            }

            // Verify it's a symmetric key (not RSA or ECC)
            if let Some(key_spec) = key_metadata.key_spec() {
                if !key_spec.as_str().starts_with("SYMMETRIC") {
                    return Err(format!(
                        "KMS key '{}' has key spec '{}' but AWS Secrets Manager requires a symmetric key (SYMMETRIC_DEFAULT).\n\
                        Asymmetric keys (RSA, ECC) cannot be used for Secrets Manager encryption.\n\
                        Please create a symmetric encryption key:\n\
                          aws kms create-key --description \"Hyperlane Validator Keys\"",
                        key_id, key_spec.as_str()
                    ).into());
                }
            }

            Ok(())
        }
        Err(e) => Err(format!(
            "KMS key '{}' not found or not accessible: {}.\n\
                Please create a symmetric KMS key first:\n\
                  aws kms create-key --description \"Hyperlane Validator Keys\"",
            key_id, e
        )
        .into()),
    }
}

async fn encrypt_with_kms(
    kms_client: &aws_sdk_kms::Client,
    key_id: &str,
    plaintext: &str,
) -> Result<aws_smithy_types::Blob, Box<dyn std::error::Error>> {
    use aws_smithy_types::Blob;

    let plaintext_blob = Blob::new(plaintext.as_bytes());

    match kms_client
        .encrypt()
        .key_id(key_id)
        .plaintext(plaintext_blob)
        .send()
        .await
    {
        Ok(response) => {
            let ciphertext_blob = response
                .ciphertext_blob()
                .ok_or("KMS encrypt response missing ciphertext")?;

            // Return the binary ciphertext directly (no base64 encoding needed)
            Ok(ciphertext_blob.clone())
        }
        Err(e) => Err(format!(
            "Failed to encrypt with KMS key '{}': {}.\n\
                Please check your KMS permissions (kms:Encrypt).",
            key_id, e
        )
        .into()),
    }
}

async fn store_encrypted_secret(
    sm_client: &aws_sdk_secretsmanager::Client,
    path: &str,
    encrypted_value: aws_smithy_types::Blob,
    property_name: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    // Store the encrypted value as binary (raw KMS ciphertext)
    // We do NOT specify kms_key_id here because we've already encrypted the value ourselves
    match sm_client
        .create_secret()
        .name(path)
        .secret_binary(encrypted_value)
        .description(format!("Hyperlane Kaspa validator key: {}", property_name))
        .send()
        .await
    {
        Ok(response) => Ok(response.arn().unwrap_or("unknown").to_string()),
        Err(e) => {
            // Check if secret already exists
            let service_err = e.into_service_error();
            if service_err.is_resource_exists_exception() {
                Err(format!(
                    "Secret '{}' already exists. Please choose a different base path or delete existing secrets:\n\
                      aws secretsmanager delete-secret --secret-id {} --force-delete-without-recovery",
                    path, path
                ).into())
            } else {
                Err(format!(
                    "Failed to create secret '{}': {}. Please check your AWS credentials and permissions.",
                    path, service_err
                ).into())
            }
        }
    }
}
