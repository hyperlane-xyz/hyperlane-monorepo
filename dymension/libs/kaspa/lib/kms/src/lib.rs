use aws_config::BehaviorVersion;
use aws_sdk_kms::Client as KmsClient;
use aws_sdk_secretsmanager::Client as SecretsManagerClient;
use dym_kas_validator::KaspaSecpKeypair;
use eyre::{eyre, Result};

#[derive(Debug, Clone)]
pub struct AwsKeyConfig {
    pub secret_id: String,
    pub kms_key_id: String,
    pub region: String,
}

pub async fn load_kaspa_keypair_from_aws(config: &AwsKeyConfig) -> Result<KaspaSecpKeypair> {
    let aws_config = aws_config::defaults(BehaviorVersion::latest())
        .region(aws_config::Region::new(config.region.clone()))
        .load()
        .await;

    let secrets_client = SecretsManagerClient::new(&aws_config);

    let secret_value = secrets_client
        .get_secret_value()
        .secret_id(&config.secret_id)
        .send()
        .await
        .map_err(|_| eyre!("get secret value from AWS Secrets Manager"))?;

    tracing::info!(
        secret_id = %config.secret_id,
        "fetched secret from AWS Secrets Manager"
    );

    let encrypted_key_material = secret_value
        .secret_binary()
        .ok_or_else(|| eyre!("secret binary data not found in AWS secret - ensure the secret was created with binary storage, not string"))?;

    let mut key_bytes = encrypted_key_material.as_ref().to_vec();

    let kms_client = KmsClient::new(&aws_config);

    let decrypt_output = kms_client
        .decrypt()
        .key_id(&config.kms_key_id)
        .ciphertext_blob(aws_sdk_kms::primitives::Blob::new(key_bytes.clone()))
        .send()
        .await
        .map_err(|_| eyre!("decrypt key material using AWS KMS"))?;

    let decrypted_key_material = decrypt_output
        .plaintext()
        .ok_or_else(|| eyre!("plaintext not found in KMS decrypt response"))?;

    tracing::info!(
        kms_key_id = %config.kms_key_id,
        "decrypted key material using AWS KMS"
    );

    let decrypted_str = String::from_utf8(decrypted_key_material.as_ref().to_vec())
        .map_err(|_| eyre!("decrypted key material is not valid UTF-8"))?;

    let keypair: KaspaSecpKeypair = serde_json::from_str(&decrypted_str)
        .map_err(|_| eyre!("parse decrypted key material as KaspaSecpKeypair JSON"))?;

    key_bytes.iter_mut().for_each(|b| *b = 0);

    tracing::info!("loaded Kaspa keypair from AWS");

    Ok(keypair)
}
