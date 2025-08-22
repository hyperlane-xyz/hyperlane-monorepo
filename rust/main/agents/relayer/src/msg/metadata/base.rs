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
use num_traits::cast::FromPrimitive;
use serde::{Deserialize, Deserializer};
use tokio::sync::{Mutex, RwLock};

use hyperlane_core::{
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, Mailbox, ModuleType, H256,
};

use crate::settings::matching_list::MatchingList;

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum MetadataBuildError {
    #[error("An external error causes the build to fail ({0})")]
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
    #[error("Exceeded max validator count when building metadata ({0})")]
    MaxValidatorCountReached(u32),
    #[error("Aggregation threshold not met ({0})")]
    AggregationThresholdNotMet(u32),
    #[error("Fast path error ({0})")]
    FastPathError(String),
    #[error("Merkle root mismatch ({root}, {canonical_root})")]
    MerkleRootMismatch { root: H256, canonical_root: H256 },
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

/// An ISM caching policy.
#[derive(Copy, Clone, Debug, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IsmCachePolicy {
    /// Default cache policy, includes the message in the cache key
    /// when querying config that may be message-specific.
    /// This is the default because it makes the fewest assumptions
    /// about the mutability of an ISM's config.
    #[default]
    MessageSpecific,
    /// Even if an ISM's config interface is message-specific, we
    /// ignore the message and use the same config for all messages.
    IsmSpecific,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IsmCacheSelector {
    #[default]
    DefaultIsm,
    AppContext {
        context: String,
    },
}

/// Configuration for ISM caching behavior.
/// Fields are renamed to be all lowercase / without underscores to match
/// the format expected by the settings parsing.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct IsmCacheConfig {
    selector: IsmCacheSelector,
    #[serde(deserialize_with = "deserialize_module_types", rename = "moduletypes")]
    module_types: HashSet<ModuleType>,
    chains: Option<HashSet<String>>,
    #[serde(default, rename = "cachepolicy")]
    cache_policy: IsmCachePolicy,
}

/// To deserialize the module types from a list of numbers
/// into a set of `ModuleType` enums.
fn deserialize_module_types<'de, D>(deserializer: D) -> Result<HashSet<ModuleType>, D::Error>
where
    D: Deserializer<'de>,
{
    let nums: Vec<u8> = Vec::deserialize(deserializer)?;
    let mut set = HashSet::new();
    for num in nums {
        let module = ModuleType::from_u8(num).ok_or_else(|| {
            serde::de::Error::custom(format!("Invalid module type value: {}", num))
        })?;
        set.insert(module);
    }
    Ok(set)
}

impl IsmCacheConfig {
    fn matches_chain(&self, domain_name: &str) -> bool {
        if let Some(chains) = &self.chains {
            chains.contains(domain_name)
        } else {
            // If no domains are specified, match all domains
            true
        }
    }

    fn matches_module_type(&self, module_type: ModuleType) -> bool {
        self.module_types.contains(&module_type)
    }
}

/// Classifies messages into an ISM cache policy based on the
/// default ISM and the configured cache policy.
#[derive(Debug, new)]
pub struct IsmCachePolicyClassifier {
    default_ism_getter: DefaultIsmCache,
    ism_cache_configs: Vec<IsmCacheConfig>,
}

impl IsmCachePolicyClassifier {
    /// Returns the cache policy for the given app context.
    pub async fn get_cache_policy(
        &self,
        root_ism: H256,
        domain: &HyperlaneDomain,
        ism_module_type: ModuleType,
        app_context: Option<&String>,
    ) -> IsmCachePolicy {
        for config in &self.ism_cache_configs {
            let matches_module = match &config.selector {
                IsmCacheSelector::DefaultIsm => {
                    let default_ism = match self.default_ism_getter.get().await {
                        Ok(default_ism) => default_ism,
                        Err(err) => {
                            tracing::warn!(?err, "Error fetching default ISM for ISM cache policy, attempting next config");
                            continue;
                        }
                    };
                    root_ism == default_ism
                }
                IsmCacheSelector::AppContext {
                    context: selector_app_context,
                } => app_context.map_or(false, |app_context| app_context == selector_app_context),
            };

            if matches_module
                && config.matches_chain(domain.name())
                && config.matches_module_type(ism_module_type)
            {
                tracing::trace!(
                    ?domain,
                    ism_cache_config =? config,
                    "Using configured default ISM cache policy"
                );
                return config.cache_policy;
            }
        }

        IsmCachePolicy::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_test::mocks::MockMailboxContract;

    #[test]
    fn test_ism_cache_config() {
        let config = IsmCacheConfig {
            selector: IsmCacheSelector::DefaultIsm,
            module_types: HashSet::from([ModuleType::Aggregation]),
            chains: Some(HashSet::from(["foochain".to_owned()])),
            cache_policy: IsmCachePolicy::IsmSpecific,
        };

        assert_eq!(config.matches_chain("foochain"), true);
        assert_eq!(config.matches_chain("barchain"), false);

        assert_eq!(config.matches_module_type(ModuleType::Aggregation), true);
        assert_eq!(config.matches_module_type(ModuleType::Routing), false);
    }

    #[test]
    fn test_ism_cache_config_deserialize() {
        // Module type 2 is the numeric version of ModuleType::Aggregation
        let json = r#"
        {
            "selector": {
                "type": "defaultIsm"
            },
            "moduletypes": [2],
            "chains": ["foochain"],
            "cachepolicy": "ismSpecific"
        }
        "#;
        let config: IsmCacheConfig = serde_json::from_str(json).unwrap();

        assert_eq!(config.selector, IsmCacheSelector::DefaultIsm);
        assert_eq!(
            config.module_types,
            HashSet::from([ModuleType::Aggregation])
        );
        assert_eq!(config.chains, Some(HashSet::from(["foochain".to_owned()])));
        assert_eq!(config.cache_policy, IsmCachePolicy::IsmSpecific);

        let json = r#"
        {
            "selector": {
                "type": "appContext",
                "context": "foo"
            },
            "moduletypes": [2],
            "chains": ["foochain"],
            "cachepolicy": "ismSpecific"
        }
        "#;
        let config: IsmCacheConfig = serde_json::from_str(json).unwrap();
        assert_eq!(
            config.selector,
            IsmCacheSelector::AppContext {
                context: "foo".to_string(),
            },
        );
    }

    #[tokio::test]
    async fn test_ism_cache_policy_classifier_default_ism() {
        let default_ism = H256::zero();

        let mock_mailbox = MockMailboxContract::new_with_default_ism(default_ism);
        let mailbox: Arc<dyn Mailbox> = Arc::new(mock_mailbox);

        let default_ism_getter = DefaultIsmCache::new(mailbox);
        let default_ism_cache_config = IsmCacheConfig {
            selector: IsmCacheSelector::DefaultIsm,
            module_types: HashSet::from([ModuleType::Aggregation]),
            chains: Some(HashSet::from(["foochain".to_owned()])),
            cache_policy: IsmCachePolicy::IsmSpecific,
        };

        let classifier =
            IsmCachePolicyClassifier::new(default_ism_getter, vec![default_ism_cache_config]);

        // We meet the criteria for the cache policy
        let domain = HyperlaneDomain::new_test_domain("foochain");
        let cache_policy = classifier
            .get_cache_policy(default_ism, &domain, ModuleType::Aggregation, None)
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::IsmSpecific);

        // Different ISM module type, should not match
        let cache_policy = classifier
            .get_cache_policy(default_ism, &domain, ModuleType::Routing, None)
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::MessageSpecific);

        // ISM not default ISM, should not match
        let cache_policy = classifier
            .get_cache_policy(H256::repeat_byte(0xfe), &domain, ModuleType::Routing, None)
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::MessageSpecific);

        // Different domain, should not match
        let domain = HyperlaneDomain::new_test_domain("barchain");
        let cache_policy = classifier
            .get_cache_policy(default_ism, &domain, ModuleType::Routing, None)
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::MessageSpecific);
    }

    #[tokio::test]
    async fn test_ism_cache_policy_classifier_app_context() {
        let default_ism = H256::zero();
        let mock_mailbox = MockMailboxContract::new_with_default_ism(default_ism);
        let mailbox: Arc<dyn Mailbox> = Arc::new(mock_mailbox);
        // Unused for this test
        let default_ism_getter = DefaultIsmCache::new(mailbox);

        let app_context_cache_config = IsmCacheConfig {
            selector: IsmCacheSelector::AppContext {
                context: "foo".to_string(),
            },
            module_types: HashSet::from([ModuleType::Aggregation]),
            chains: Some(HashSet::from(["foochain".to_owned()])),
            cache_policy: IsmCachePolicy::IsmSpecific,
        };

        let classifier =
            IsmCachePolicyClassifier::new(default_ism_getter, vec![app_context_cache_config]);

        // We meet the criteria for the cache policy
        let domain = HyperlaneDomain::new_test_domain("foochain");
        let cache_policy = classifier
            .get_cache_policy(
                // To make extra sure we're testing the app context match,
                // let's use a different ISM address
                H256::repeat_byte(0xfe),
                &domain,
                ModuleType::Aggregation,
                Some(&"foo".to_string()),
            )
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::IsmSpecific);

        // Different app context, should not match
        let cache_policy = classifier
            .get_cache_policy(
                default_ism,
                &domain,
                ModuleType::Routing,
                Some(&"bar".to_string()),
            )
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::MessageSpecific);

        // No app context, should not match
        let cache_policy = classifier
            .get_cache_policy(H256::repeat_byte(0xfe), &domain, ModuleType::Routing, None)
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::MessageSpecific);

        // Different domain, should not match
        let domain = HyperlaneDomain::new_test_domain("barchain");
        let cache_policy = classifier
            .get_cache_policy(
                default_ism,
                &domain,
                ModuleType::Routing,
                Some(&"foo".to_string()),
            )
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::MessageSpecific);
    }

    #[tokio::test]
    async fn test_ism_cache_policy_classifier_multiple_policies() {
        let default_ism = H256::zero();
        let mock_mailbox = MockMailboxContract::new_with_default_ism(default_ism);
        let mailbox: Arc<dyn Mailbox> = Arc::new(mock_mailbox);
        // Unused for this test
        let default_ism_getter = DefaultIsmCache::new(mailbox);

        let app_context_cache_config = IsmCacheConfig {
            selector: IsmCacheSelector::AppContext {
                context: "foo".to_string(),
            },
            module_types: HashSet::from([ModuleType::Aggregation]),
            chains: Some(HashSet::from(["foochain".to_owned()])),
            cache_policy: IsmCachePolicy::IsmSpecific,
        };

        let default_ism_cache_config = IsmCacheConfig {
            selector: IsmCacheSelector::DefaultIsm,
            module_types: HashSet::from([ModuleType::Routing]),
            chains: Some(HashSet::from(["foochain".to_owned()])),
            cache_policy: IsmCachePolicy::IsmSpecific,
        };

        let classifier = IsmCachePolicyClassifier::new(
            default_ism_getter,
            vec![app_context_cache_config, default_ism_cache_config],
        );

        // We meet the criteria for the app context cache policy
        let domain = HyperlaneDomain::new_test_domain("foochain");
        let cache_policy = classifier
            .get_cache_policy(
                // To make extra sure we're testing the app context match,
                // let's use a different ISM address
                H256::repeat_byte(0xfe),
                &domain,
                ModuleType::Aggregation,
                Some(&"foo".to_string()),
            )
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::IsmSpecific);

        // We meet the criteria for the default ISM cache policy
        let cache_policy = classifier
            .get_cache_policy(default_ism, &domain, ModuleType::Routing, None)
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::IsmSpecific);

        // Different app context and not default ISM, should not match
        let cache_policy = classifier
            .get_cache_policy(
                H256::repeat_byte(0xfe),
                &domain,
                ModuleType::Routing,
                Some(&"bar".to_string()),
            )
            .await;
        assert_eq!(cache_policy, IsmCachePolicy::MessageSpecific);
    }
}
