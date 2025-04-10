#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue

use std::{
    collections::HashSet,
    fmt::Debug,
    sync::Arc,
    time::{Duration, Instant},
};

use derive_new::new;
use eyre::Result;
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use hyperlane_core::{
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, Mailbox, ModuleType, H256,
};

use crate::settings::matching_list::MatchingList;

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum MetadataBuildError {
    #[error("Some external error causing the build to fail")]
    FailedToBuild(String),
    /// While building metadata, encountered something that should
    /// prohibit all metadata for the message from being built.
    /// Provides the reason for the refusal.
    #[error("Refused")]
    Refused(String),
    /// Unable to fetch metadata, but no error occurred
    #[error("Could not fetch metadata")]
    CouldNotFetch,
    #[error("Unknown or invalid module type ({0})")]
    UnsupportedModuleType(ModuleType),
    #[error("Exceeded max depth when building metadata ({0})")]
    MaxIsmDepthExceeded(u32),
    #[error("Exceeded max count when building metadata ({0})")]
    MaxIsmCountReached(u32),
    #[error("Aggregation threshold not met ({0})")]
    AggregationThresholdNotMet(u32),
}

#[derive(Clone, Debug, new)]
pub struct Metadata(Vec<u8>);

impl Metadata {
    pub fn to_vec(&self) -> Vec<u8> {
        self.0.clone()
    }
}

#[async_trait::async_trait]
pub trait MetadataBuilder: Send + Sync {
    /// Given a message, build it's ISM metadata
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError>;
}

#[derive(Clone, Debug, Default)]
pub struct MessageMetadataBuildParams {
    /// current ISM depth.
    /// ISMs can be structured recursively. We keep track of the depth
    /// of the recursion to avoid infinite loops.
    /// This value is local to each recursion when doing a .clone()
    pub ism_depth: u32,
    /// current ISM count.
    /// This value is global and is shared when doing a .clone()
    /// in order to track all recursion branches
    pub ism_count: Arc<Mutex<u32>>,
}

#[derive(Debug)]
pub struct IsmWithMetadataAndType {
    pub ism: Box<dyn InterchainSecurityModule>,
    pub metadata: Metadata,
}

/// Allows fetching the default ISM, caching the value for a period of time
/// to avoid fetching it all the time.
/// TODO: make this generic
#[derive(Clone, Debug)]
pub struct DefaultIsmCache {
    value: Arc<RwLock<Option<(H256, Instant)>>>,
    mailbox: Arc<dyn Mailbox>,
}

impl DefaultIsmCache {
    /// Time to live for the cached default ISM. 10 mins.
    const TTL: Duration = Duration::from_secs(60 * 10);

    pub fn new(mailbox: Arc<dyn Mailbox>) -> Self {
        Self {
            value: Arc::new(RwLock::new(None)),
            mailbox,
        }
    }

    /// Gets the default ISM, fetching it from onchain if the cached value
    /// is stale.
    /// TODO: this can and should be made generic eventually
    pub async fn get(&self) -> Result<H256> {
        // If the duration since the value was last updated does not
        // exceed the TTL, return the cached value.
        // This is in its own block to avoid holding the lock during the
        // async operation to fetch the on-chain default ISM if
        // the cached value is stale.
        {
            let value = self.value.read().await;

            if let Some(value) = *value {
                if value.1.elapsed() < Self::TTL {
                    return Ok(value.0);
                }
            }
        }

        let default_ism = self.mailbox.default_ism().await?;
        // Update the cached value.
        {
            let mut value = self.value.write().await;
            *value = Some((default_ism, Instant::now()));
        }

        Ok(default_ism)
    }
}

#[derive(Debug)]
pub struct IsmAwareAppContextClassifier {
    default_ism_getter: DefaultIsmCache,
    app_context_classifier: AppContextClassifier,
}

impl IsmAwareAppContextClassifier {
    pub fn new(
        default_ism_getter: DefaultIsmCache,
        app_matching_lists: Vec<(MatchingList, String)>,
    ) -> Self {
        Self {
            default_ism_getter,
            app_context_classifier: AppContextClassifier::new(app_matching_lists),
        }
    }

    pub async fn get_app_context(
        &self,
        message: &HyperlaneMessage,
        root_ism: H256,
    ) -> Result<Option<String>> {
        if let Some(app_context) = self.app_context_classifier.get_app_context(message).await? {
            return Ok(Some(app_context));
        }

        if root_ism == self.default_ism_getter.get().await? {
            return Ok(Some("default_ism".to_string()));
        }

        Ok(None)
    }
}

/// Classifies messages into an app context if they have one.
#[derive(Debug, new)]
pub struct AppContextClassifier {
    app_matching_lists: Vec<(MatchingList, String)>,
}

impl AppContextClassifier {
    /// Classifies messages into an app context if they have one, or None
    /// if they don't.
    /// An app context is a string that identifies the app that sent the message
    /// and exists just for metrics.
    /// An app context is chosen based on:
    /// - the first element in `app_matching_lists` that matches the message
    /// - if the message's ISM is the default ISM, the app context is "default_ism"
    pub async fn get_app_context(&self, message: &HyperlaneMessage) -> Result<Option<String>> {
        // Give priority to the matching list. If the app from the matching list happens
        // to use the default ISM, it's preferable to use the app context from the matching
        // list.
        for (matching_list, app_context) in self.app_matching_lists.iter() {
            if matching_list.msg_matches(message, false) {
                return Ok(Some(app_context.clone()));
            }
        }

        Ok(None)
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Default, Deserialize)]
pub enum IsmCachePolicy {
    #[default]
    MessageSpecific,
    IsmSpecific,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsmCacheConfig {
    module_types: HashSet<ModuleType>,
    domains: Option<HashSet<u32>>,
    cache_policy: IsmCachePolicy,
}

impl IsmCacheConfig {
    fn matches_domain(&self, domain: u32) -> bool {
        if let Some(domains) = &self.domains {
            domains.contains(&domain)
        } else {
            // If no domains are specified, match all domains
            true
        }
    }

    fn matches_module_type(&self, module_type: ModuleType) -> bool {
        self.module_types.contains(&module_type)
    }
}

#[derive(Debug, new)]
pub struct IsmCachePolicyClassifier {
    default_ism_getter: DefaultIsmCache,
    default_ism_cache_policy: IsmCacheConfig,
}

impl IsmCachePolicyClassifier {
    /// Returns the cache policy for the given app context.
    pub async fn get_cache_policy(
        &self,
        root_ism: H256,
        domain: &HyperlaneDomain,
        ism_module_type: ModuleType,
    ) -> IsmCachePolicy {
        let default_ism = match self.default_ism_getter.get().await {
            Ok(default_ism) => default_ism,
            Err(err) => {
                tracing::warn!(?err, "Error fetching default ISM for ISM cache policy, falling back to default cache policy");
                return IsmCachePolicy::default();
            }
        };

        if root_ism == default_ism
            && self.default_ism_cache_policy.matches_domain(domain.id())
            && self
                .default_ism_cache_policy
                .matches_module_type(ism_module_type)
        {
            tracing::trace!(
                ?default_ism,
                ?domain,
                cache_policy =? self.default_ism_cache_policy.cache_policy,
                "Using configured default ISM cache policy"
            );
            return self.default_ism_cache_policy.cache_policy;
        }

        IsmCachePolicy::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ism_cache_config() {
        let config = IsmCacheConfig {
            module_types: HashSet::from([ModuleType::Aggregation]),
            domains: Some(HashSet::from([1])),
            cache_policy: IsmCachePolicy::IsmSpecific,
        };

        assert_eq!(config.matches_domain(1), true);
        assert_eq!(config.matches_domain(2), false);

        assert_eq!(config.matches_module_type(ModuleType::Aggregation), true);
        assert_eq!(config.matches_module_type(ModuleType::Routing), false);
    }

    #[test]
    fn test_ism_cache_config_deserialize() {
        // Module type 2 is the numeric version of ModuleType::Aggregation
        let json = r#"
        {
            "moduleTypes": [2],
            "domains": [1],
            "cachePolicy": "IsmSpecific"
        }
        "#;

        let config: IsmCacheConfig = serde_json::from_str(json).unwrap();

        assert_eq!(
            config.module_types,
            HashSet::from([ModuleType::Aggregation])
        );
        assert_eq!(config.domains, Some(HashSet::from([1])));
        assert_eq!(config.cache_policy, IsmCachePolicy::IsmSpecific);
    }
}
