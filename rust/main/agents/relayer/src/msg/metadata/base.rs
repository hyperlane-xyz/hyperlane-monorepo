#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue

use std::{
    fmt::Debug,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::settings::matching_list::MatchingList;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{HyperlaneMessage, InterchainSecurityModule, Mailbox, ModuleType, H256};

use tokio::sync::RwLock;

#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum MetadataBuildError {
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
    MaxDepthExceeded(u32),
    #[error("Exceeded max depth when building metadata ({0})")]
    MaxIsmCountReached(u32),
}

#[derive(Clone, Debug)]
pub enum Metadata {
    /// Able to fetch metadata
    Found(Vec<u8>),
    Failed(MetadataBuildError),
}

impl Metadata {
    pub fn ok(&self) -> bool {
        match self {
            Self::Found(_) => true,
            Self::Failed(_) => false,
        }
    }
}

#[derive(Debug)]
pub struct IsmWithMetadataAndType {
    pub ism: Box<dyn InterchainSecurityModule>,
    pub metadata: Metadata,
    pub module_type: ModuleType,
}

/// Allows fetching the default ISM, caching the value for a period of time
/// to avoid fetching it all the time.
/// TODO: make this generic
#[derive(Debug)]
pub struct DefaultIsmCache {
    value: RwLock<Option<(H256, Instant)>>,
    mailbox: Arc<dyn Mailbox>,
}

impl DefaultIsmCache {
    /// Time to live for the cached default ISM. 10 mins.
    const TTL: Duration = Duration::from_secs(60 * 10);

    pub fn new(mailbox: Arc<dyn Mailbox>) -> Self {
        Self {
            value: RwLock::new(None),
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
    default_ism: DefaultIsmCache,
    app_context_classifier: AppContextClassifier,
}

impl IsmAwareAppContextClassifier {
    pub fn new(
        destination_mailbox: Arc<dyn Mailbox>,
        app_matching_lists: Vec<(MatchingList, String)>,
    ) -> Self {
        Self {
            default_ism: DefaultIsmCache::new(destination_mailbox),
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

        if root_ism == self.default_ism.get().await? {
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
