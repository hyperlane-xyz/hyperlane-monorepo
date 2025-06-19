use crate::msg::{pending_message::PendingMessage, metadata::Metadata};
use hyperlane_core::{HyperlaneMessage, traits::PendingOperationResult};

// TODO: needs to concretely impl https://github.com/dymensionxyz/hyperlane-monorepo/blob/bb9df82a19c0583b994adbb40436168a55b8442e/rust/main/agents/relayer/src/msg/processor.rs#L254
struct PendingMessageMedataConstructor {
    // TODO: use https://github.com/dymensionxyz/hyperlane-monorepo/blob/9b3c6eb6101681f90ec1a1a1c631961f451d7b6b/rust/main/agents/relayer/src/msg/pending_message.rs#L582
    // then do  build_metadata

}

impl PendingMessageMedataConstructor {
    pub fn metadata(
       &self, 
        message: HyperlaneMessage,
    ) ->Result<Metadata, PendingOperationResult> {
        Self::metadata_impl(message, ctx, app_context)
    }

    fn metadata_impl(
        message: HyperlaneMessage
        ctx: Arc<MessageContext>,
        app_context: Option<String>,
    ) ->Result<Metadata, PendingOperationResult> {
    let m = PendingMessage::direct(
        message,
        ctx, 
        app_context,
    }
    m.build_metadata() // TODO: it's not going to work directly because this function actually gathers sigs etc
}