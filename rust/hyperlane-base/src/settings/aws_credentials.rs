use async_trait::async_trait;
use rusoto_core::credential::{
    AutoRefreshingProvider, AwsCredentials, CredentialsError, EnvironmentProvider,
    ProvideAwsCredentials,
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
pub(crate) struct AwsChainCredentialsProvider {
    environment_provider: EnvironmentProvider,
    web_identity_provider: AutoRefreshingProvider<WebIdentityProvider>,
}

impl AwsChainCredentialsProvider {
    pub fn new() -> Self {
        // Wrap the `WebIdentityProvider` to a caching `AutoRefreshingProvider`.
        // By default, the `WebIdentityProvider` requests AWS Credentials on each call to `credentials()`
        // To save the CPU/network and AWS bills, the `AutoRefreshingProvider` allows to cache the credentials until the expire.
        let auto_refreshing_provider =
            AutoRefreshingProvider::new(WebIdentityProvider::from_k8s_env())
                .expect("Always returns Ok(...)");
        AwsChainCredentialsProvider {
            environment_provider: EnvironmentProvider::default(),
            web_identity_provider: auto_refreshing_provider,
        }
    }
}

#[async_trait]
impl ProvideAwsCredentials for AwsChainCredentialsProvider {
    async fn credentials(&self) -> Result<AwsCredentials, CredentialsError> {
        if let Ok(creds) = self.environment_provider.credentials().await {
            Ok(creds)
        } else {
            // Propagate errors from the 'WebIdentityProvider'.
            self.web_identity_provider.credentials().await
        }
    }
}
