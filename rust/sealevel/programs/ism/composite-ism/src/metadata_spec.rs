use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{HyperlaneMessage, H160};

use crate::{accounts::IsmNode, error::Error};

/// Describes the metadata a relayer must supply for this composite ISM tree.
///
/// Routing and AmountRouting are transparent: the relayer-facing spec contains
/// only the resolved leaf, so the relayer never needs to know about routing.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone)]
pub enum MetadataSpec {
    /// No metadata needed (TrustedRelayer, Test, Pausable, RateLimited).
    Null,

    /// MultisigMessageId — validator set is embedded so the relayer can build
    /// metadata without a second chain call.
    MultisigMessageId {
        validators: Vec<H160>,
        threshold: u8,
    },

    /// Aggregation — recurse into sub-specs.
    Aggregation {
        threshold: u8,
        sub_specs: Vec<MetadataSpec>,
    },
}

/// Resolves the [`MetadataSpec`] for an ISM node given the message.
///
/// Routing/AmountRouting are resolved here: the function follows the correct
/// branch for `message` and returns the spec of the resolved sub-node.
pub(crate) fn spec_for_node(
    node: &IsmNode,
    message: &HyperlaneMessage,
) -> Result<MetadataSpec, Error> {
    match node {
        IsmNode::MultisigMessageId { domain_configs } => {
            let config = domain_configs
                .iter()
                .find(|c| c.origin == message.origin)
                .ok_or(Error::NoDomainConfig)?;
            Ok(MetadataSpec::MultisigMessageId {
                validators: config.validators.clone(),
                threshold: config.threshold,
            })
        }

        IsmNode::Aggregation {
            threshold,
            sub_isms,
        } => {
            let sub_specs = sub_isms
                .iter()
                .map(|sub| spec_for_node(sub, message))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(MetadataSpec::Aggregation {
                threshold: *threshold,
                sub_specs,
            })
        }

        IsmNode::Routing {
            routes,
            default_ism,
        } => {
            let sub_ism = if let Some((_, ism)) =
                routes.iter().find(|(domain, _)| *domain == message.origin)
            {
                ism
            } else if let Some(d) = default_ism {
                d.as_ref()
            } else {
                return Err(Error::NoRouteForDomain);
            };
            spec_for_node(sub_ism, message)
        }

        IsmNode::AmountRouting {
            threshold,
            lower,
            upper,
        } => {
            const AMOUNT_OFFSET: usize = 32;
            const AMOUNT_END: usize = 64;
            if message.body.len() < AMOUNT_END {
                return Err(Error::InvalidMessageBody);
            }
            let amount: [u8; 32] = message.body[AMOUNT_OFFSET..AMOUNT_END]
                .try_into()
                .map_err(|_| Error::InvalidMessageBody)?;
            let sub_ism = if amount >= *threshold { upper } else { lower };
            spec_for_node(sub_ism, message)
        }

        // Leaf nodes that need no metadata from the relayer.
        IsmNode::TrustedRelayer { .. }
        | IsmNode::Test { .. }
        | IsmNode::Pausable { .. }
        | IsmNode::RateLimited { .. } => Ok(MetadataSpec::Null),
    }
}
