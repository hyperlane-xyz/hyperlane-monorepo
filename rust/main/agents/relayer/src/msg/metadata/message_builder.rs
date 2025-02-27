#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue

use std::{fmt::Debug, sync::Arc};

use async_trait::async_trait;
use eyre::{Context, Result};
use hyperlane_core::{HyperlaneMessage, InterchainSecurityModule, ModuleType, H256};

use tokio::sync::Mutex;
use tracing::instrument;

use crate::msg::metadata::base_builder::BaseMetadataBuilderTrait;

use super::{
    aggregation::AggregationIsmMetadataBuilder,
    base::{IsmWithMetadataAndType, MetadataBuildError},
    ccip_read::CcipReadIsmMetadataBuilder,
    metadata_builder::MessageMetadataBuildParams,
    multisig::{MerkleRootMultisigMetadataBuilder, MessageIdMultisigMetadataBuilder},
    routing::RoutingIsmMetadataBuilder,
    Metadata, MetadataBuilder,
};

/// Builds metadata for a message.
#[derive(Debug, Clone)]
pub struct MessageMetadataBuilder {
    pub base: Arc<Box<dyn BaseMetadataBuilderTrait>>,
    pub app_context: Option<String>,
    /// current ISM depth.
    /// ISMs can be structured recursively. We keep track of the depth
    /// of the recursion to avoid infinite loops.
    pub depth: u32,
    /// current ISM count
    pub ism_count: Arc<Mutex<u32>>,
}

#[async_trait]
impl MetadataBuilder for MessageMetadataBuilder {
    #[instrument(err, skip(self, message), fields(destination_domain=self.base_builder().destination_domain().name()))]
    async fn build(
        &self,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> eyre::Result<Metadata> {
        build_message_metadata(self, message, params)
            .await
            .map(|res| res.metadata)
    }
}

impl MessageMetadataBuilder {
    pub async fn new(
        base: Arc<Box<dyn BaseMetadataBuilderTrait>>,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<Self> {
        let app_context = base
            .app_context_classifier()
            .get_app_context(message, ism_address)
            .await?;
        Ok(Self {
            base,
            app_context,
            depth: 0,
            ism_count: Arc::new(Mutex::new(0)),
        })
    }

    pub fn base_builder(&self) -> &Arc<Box<dyn BaseMetadataBuilderTrait>> {
        &self.base
    }
}

/// Builds metadata for a message.
pub async fn build_message_metadata(
    message_builder: &MessageMetadataBuilder,
    message: &HyperlaneMessage,
    params: MessageMetadataBuildParams,
) -> eyre::Result<IsmWithMetadataAndType> {
    let ism: Box<dyn InterchainSecurityModule> = message_builder
        .base_builder()
        .build_ism(params.ism_address)
        .await
        .context("When building ISM")?;

    let module_type = ism
        .module_type()
        .await
        .context("When fetching module type")?;

    // throw error if we've reached max depth or max ism count
    {
        let options = &params.options;
        if message_builder.depth >= options.max_depth {
            return Ok(IsmWithMetadataAndType {
                ism,
                metadata: Metadata::Failed(MetadataBuildError::MaxIsmDepthExceeded(
                    options.max_depth,
                )),
                module_type,
            });
        }
        let mut ism_count = message_builder.ism_count.lock().await;
        if *ism_count >= options.max_ism_count {
            return Ok(IsmWithMetadataAndType {
                ism,
                metadata: Metadata::Failed(MetadataBuildError::MaxIsmCountReached(
                    options.max_ism_count,
                )),
                module_type,
            });
        }

        // update depth and ism count
        message_builder.depth = message_builder.depth.saturating_add(1);
        *ism_count = ism_count.saturating_add(1);
    }

    let metadata: Metadata = match module_type {
        ModuleType::MerkleRootMultisig => MerkleRootMultisigMetadataBuilder::new(message_builder)
            .build(message, params)
            .await
            .context("When building metadata")?,
        ModuleType::MessageIdMultisig => MessageIdMultisigMetadataBuilder::new(message_builder)
            .build(message, params)
            .await
            .context("When building metadata")?,
        ModuleType::Routing => RoutingIsmMetadataBuilder::new(message_builder)
            .build(message, params)
            .await
            .context("When building metadata")?,
        ModuleType::Aggregation => AggregationIsmMetadataBuilder::new(message_builder)
            .build(message, params)
            .await
            .context("When building metadata")?,
        ModuleType::CcipRead => CcipReadIsmMetadataBuilder::new(message_builder)
            .build(message, params)
            .await
            .context("When building metadata")?,
        ModuleType::Null => Metadata::Found(vec![]),
        _ => return Err(MetadataBuildError::UnsupportedModuleType(module_type).into()),
    };

    Ok(IsmWithMetadataAndType {
        ism,
        metadata,
        module_type,
    })
}

#[cfg(test)]
mod test {
    use std::sync::Arc;

    use hyperlane_core::{
        HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, Mailbox, ModuleType, H256,
    };
    use hyperlane_test::mocks::MockMailboxContract;

    use crate::{
        msg::metadata::{
            base::MetadataBuildError, message_builder::build_message_metadata,
            IsmAwareAppContextClassifier, MessageMetadataBuildParams, Metadata,
        },
        settings::matching_list::{Filter, ListElement, MatchingList},
        test_utils::{
            mock_aggregation_ism::MockAggregationIsm, mock_base_builder::MockBaseMetadataBuilder,
            mock_ism::MockInterchainSecurityModule, mock_routing_ism::MockRoutingIsm,
        },
    };

    use super::MessageMetadataBuilder;

    fn build_mock_base_builder() -> MockBaseMetadataBuilder {
        let origin_domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism);
        let destination_domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);

        let mut base_builder = MockBaseMetadataBuilder::new();
        base_builder.responses.origin_domain = Some(origin_domain.clone());
        base_builder.responses.destination_domain = Some(destination_domain);

        let mock_mailbox = MockMailboxContract::new();
        let mailbox: Arc<dyn Mailbox> = Arc::new(mock_mailbox);
        let app_context_classifier = IsmAwareAppContextClassifier::new(
            mailbox,
            vec![(
                MatchingList(Some(vec![ListElement::new(
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                )])),
                "abcd".to_string(),
            )],
        );
        base_builder.responses.app_context_classifier = Some(app_context_classifier);
        base_builder
    }

    fn insert_mock_routing_ism(base_builder: &MockBaseMetadataBuilder) {
        let mock_ism = MockInterchainSecurityModule::default();
        mock_ism
            .responses
            .module_type
            .lock()
            .unwrap()
            .push_back(Ok(ModuleType::Routing));
        base_builder
            .responses
            .build_ism
            .lock()
            .unwrap()
            .push_back(Ok(Box::new(mock_ism)));

        let routing_ism = MockRoutingIsm::default();
        routing_ism
            .responses
            .route
            .lock()
            .unwrap()
            .push_back(Ok(H256::zero()));
        base_builder
            .responses
            .build_routing_ism
            .lock()
            .unwrap()
            .push_back(Ok(Box::new(routing_ism)));
    }

    #[tokio::test]
    async fn zero_depth() {
        let base_builder = build_mock_base_builder();
        insert_mock_routing_ism(&base_builder);

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();

        let message_builder =
            MessageMetadataBuilder::new(Arc::new(Box::new(base_builder)), ism_address, &message)
                .await
                .expect("Failed to build MessageMetadataBuilder");

        let params = MessageMetadataBuildParams::new(ism_address, 0, 10);
        let res = build_message_metadata(&message_builder, &message, params)
            .await
            .expect("Metadata building failed");

        match res.metadata {
            Metadata::Found(_) => {
                panic!("Metadata found when it should have failed");
            }
            Metadata::Failed(err) => {
                assert_eq!(err, MetadataBuildError::MaxIsmDepthExceeded(0));
            }
        }
    }

    #[tokio::test]
    async fn zero_ism_count() {
        let base_builder = build_mock_base_builder();
        insert_mock_routing_ism(&base_builder);

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();

        let message_builder =
            MessageMetadataBuilder::new(Arc::new(Box::new(base_builder)), ism_address, &message)
                .await
                .expect("Failed to build MessageMetadataBuilder");

        let params = MessageMetadataBuildParams::new(ism_address, 1, 0);
        let res = build_message_metadata(&message_builder, &message, params)
            .await
            .expect("Metadata building failed");

        match res.metadata {
            Metadata::Found(_) => {
                panic!("Metadata found when it should have failed");
            }
            Metadata::Failed(err) => {
                assert_eq!(err, MetadataBuildError::MaxIsmCountReached(0));
            }
        }
    }

    #[tokio::test]
    async fn max_depth_reached() {
        let base_builder = build_mock_base_builder();

        for _ in 0..3 {
            insert_mock_routing_ism(&base_builder);
        }

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();

        let message_builder =
            MessageMetadataBuilder::new(Arc::new(Box::new(base_builder)), ism_address, &message)
                .await
                .expect("Failed to build MessageMetadataBuilder");

        let params = MessageMetadataBuildParams::new(ism_address, 2, 10);
        let res = build_message_metadata(&message_builder, &message, params)
            .await
            .expect("Metadata building failed");

        match res.metadata {
            Metadata::Found(_) => {
                panic!("Metadata found when it should have failed");
            }
            Metadata::Failed(err) => {
                assert_eq!(err, MetadataBuildError::MaxIsmDepthExceeded(2));
            }
        }
    }

    #[tokio::test]
    async fn max_ism_count_reached() {
        let base_builder = build_mock_base_builder();

        for _ in 0..11 {
            insert_mock_routing_ism(&base_builder);
        }

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();

        let message_builder =
            MessageMetadataBuilder::new(Arc::new(Box::new(base_builder)), ism_address, &message)
                .await
                .expect("Failed to build MessageMetadataBuilder");

        let params = MessageMetadataBuildParams::new(ism_address, 20, 10);
        let res = build_message_metadata(&message_builder, &message, params)
            .await
            .expect("Metadata building failed");

        match res.metadata {
            Metadata::Found(_) => {
                panic!("Metadata found when it should have failed");
            }
            Metadata::Failed(err) => {
                assert_eq!(err, MetadataBuildError::MaxIsmCountReached(10));
            }
        }
    }

    #[tokio::test]
    async fn max_ism_count_reached_with_aggregate() {
        let base_builder = build_mock_base_builder();

        // push aggregation ISMs
        //
        // R = Routing (9)
        // Agg = Aggregation
        //
        //           Agg
        //     /      |      \
        //    R       R       R
        //    |       |       |
        //    R       R       R
        //
        {
            let mock_ism = MockInterchainSecurityModule::default();
            mock_ism
                .responses
                .module_type
                .lock()
                .unwrap()
                .push_back(Ok(ModuleType::Aggregation));
            base_builder
                .responses
                .build_ism
                .lock()
                .unwrap()
                .push_back(Ok(Box::new(mock_ism)));

            let aggregation_ism = MockAggregationIsm::default();
            aggregation_ism
                .responses
                .modules_and_threshold
                .lock()
                .unwrap()
                .push_back(Ok((vec![H256::zero(), H256::zero(), H256::zero()], 2)));
            base_builder
                .responses
                .build_aggregation_ism
                .lock()
                .unwrap()
                .push_back(Ok(Box::new(aggregation_ism)));
        }
        for _ in 0..6 {
            insert_mock_routing_ism(&base_builder);
        }

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();

        let message_builder =
            MessageMetadataBuilder::new(Arc::new(Box::new(base_builder)), ism_address, &message)
                .await
                .expect("Failed to build MessageMetadataBuilder");

        let params = MessageMetadataBuildParams::new(ism_address, 20, 4);
        let res = build_message_metadata(&message_builder, &message, params)
            .await
            .expect("Metadata building failed");

        match res.metadata {
            Metadata::Found(_) => {
                panic!("Metadata found when it should have failed");
            }
            Metadata::Failed(err) => {
                assert_eq!(err, MetadataBuildError::MaxIsmCountReached(4));
            }
        }
    }
}
