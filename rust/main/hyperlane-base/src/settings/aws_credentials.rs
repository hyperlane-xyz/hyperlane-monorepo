#![allow(clippy::doc_markdown)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::doc_lazy_continuation)] // TODO: `rustc` 1.80.1 clippy issue

use async_trait::async_trait;
use rusoto_core::credential::{
    AutoRefreshingProvider, AwsCredentials, CredentialsError, EnvironmentProvider,
    InstanceMetadataProvider, ProvideAwsCredentials,
};
use rusoto_sts::WebIdentityProvider;

/// Provides AWS credentials from multiple possible sources using a priority order.
/// The following sources are checked in order for credentials when calling credentials. More sources may be supported in future if a need be.
/// 1) Environment variables: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
/// 2) `WebIdentityProvider`: by default, configured from environment variables `AWS_WEB_IDENTITY_TOKEN_FILE`,
/// `AWS_ROLE_ARN` and `AWS_ROLE_SESSION_NAME`. Uses OpenID Connect bearer token to retrieve AWS IAM credentials
/// from [AssumeRoleWithWebIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html).
/// The primary use case is running Hyperlane agents in AWS Kubernetes cluster (EKS) configured
/// with [IAM Roles for Service Accounts (IRSA)](https://aws.amazon.com/blogs/containers/diving-into-iam-roles-for-service-accounts/).
/// The IRSA approach follows security best practices and allows for key rotation.
/// 3) `InstanceMetadataProvider`: retrieves credentials from EC2 instance metadata service (IMDSv2).
/// This allows EC2 instances with attached IAM instance profiles to authenticate without static credentials.
pub(crate) struct AwsChainCredentialsProvider {
    environment_provider: EnvironmentProvider,
    web_identity_provider: AutoRefreshingProvider<WebIdentityProvider>,
    instance_metadata_provider: AutoRefreshingProvider<InstanceMetadataProvider>,
}

impl AwsChainCredentialsProvider {
    pub fn new() -> Self {
        // Wrap the `WebIdentityProvider` to a caching `AutoRefreshingProvider`.
        // By default, the `WebIdentityProvider` requests AWS Credentials on each call to `credentials()`
        // To save the CPU/network and AWS bills, the `AutoRefreshingProvider` allows to cache the credentials until the expire.
        let auto_refreshing_provider =
            AutoRefreshingProvider::new(WebIdentityProvider::from_k8s_env())
                .expect("Always returns Ok(...)");

        // Wrap the `InstanceMetadataProvider` to a caching `AutoRefreshingProvider`.
        // This enables automatic credential refresh for EC2 instance profiles.
        let instance_metadata_auto_refreshing =
            AutoRefreshingProvider::new(InstanceMetadataProvider::new())
                .expect("Always returns Ok(...)");

        AwsChainCredentialsProvider {
            environment_provider: EnvironmentProvider::default(),
            web_identity_provider: auto_refreshing_provider,
            instance_metadata_provider: instance_metadata_auto_refreshing,
        }
    }
}

#[async_trait]
impl ProvideAwsCredentials for AwsChainCredentialsProvider {
    async fn credentials(&self) -> Result<AwsCredentials, CredentialsError> {
        if let Ok(creds) = self.environment_provider.credentials().await {
            Ok(creds)
        } else {
            match self.web_identity_provider.credentials().await {
                Ok(creds) => {
                    tracing::debug!("Using AWS credentials from web identity provider (K8s IRSA)");
                    return Ok(creds);
                }
                Err(e) => {
                    tracing::debug!("Web identity provider failed: {:?}", e);
                }
            }

            // 3. EC2 Instance Metadata (for EC2 instances with IAM instance profiles)
            match self.instance_metadata_provider.credentials().await {
                Ok(creds) => {
                    tracing::info!(
                        "Using AWS credentials from EC2 instance metadata (IAM instance profile)"
                    );
                    Ok(creds)
                }
                Err(e) => {
                    tracing::error!(
                        "All AWS credential providers failed. Instance metadata error: {:?}",
                        e
                    );
                    Err(e)
                }
            }
        }
    }
}
