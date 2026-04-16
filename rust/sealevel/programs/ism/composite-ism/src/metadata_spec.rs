use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{HyperlaneMessage, H160};
use hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS;
use hyperlane_sealevel_mailbox::accounts::InboxAccount;
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use crate::{
    accounts::{
        derive_domain_pda, load_and_validate_domain_ism_storage, CompositeIsmAccount, IsmNode,
    },
    error::Error,
    metadata::parse_routing_amount,
};

/// Describes the metadata a relayer must supply for this composite ISM tree.
///
/// Routing and AmountRouting are transparent: the relayer-facing spec contains
/// only the resolved leaf, so the relayer never needs to know about routing.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone)]
pub enum MetadataSpec {
    /// No metadata needed (TrustedRelayer, Test, Pausable, RateLimited).
    Null,

    /// MultisigMessageId -- validator set is embedded so the relayer can build
    /// metadata without a second chain call.
    MultisigMessageId {
        validators: Vec<H160>,
        threshold: u8,
    },

    /// Aggregation -- recurse into sub-specs.
    Aggregation {
        threshold: u8,
        sub_specs: Vec<MetadataSpec>,
    },
}

/// Resolves the [`MetadataSpec`] for an ISM node given the message.
///
/// For each `Routing` encountered during depth-first traversal, the next
/// account from `accounts_iter` must be the domain PDA for `message.origin`
/// (or any PDA — the key is verified against the derived address).
pub(crate) fn spec_for_node_with_pdas<'a, 'info, I>(
    node: &IsmNode,
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    accounts_iter: &mut I,
) -> Result<MetadataSpec, Error>
where
    I: Iterator<Item = &'a AccountInfo<'info>>,
    'info: 'a,
{
    match node {
        IsmNode::Routing => {
            // Expect the domain PDA as the next account.
            let domain_pda_info = accounts_iter.next().ok_or(Error::InvalidDomainPda)?;

            // Verify correct account.
            let (expected_key, _) = derive_domain_pda(program_id, message.origin);
            if *domain_pda_info.key != expected_key {
                return Err(Error::InvalidDomainPda);
            }

            // Load sub-ISM.
            let loaded =
                load_and_validate_domain_ism_storage(program_id, message.origin, domain_pda_info)
                    .map_err(|_| Error::InvalidConfig)?;

            if let Some(ref storage) = loaded {
                if let Some(ref ism) = storage.ism {
                    return spec_for_node_with_pdas(ism, message, program_id, accounts_iter);
                }
            }

            Err(Error::NoRouteForDomain)
        }

        IsmNode::MultisigMessageId {
            validators,
            threshold,
        } => Ok(MetadataSpec::MultisigMessageId {
            validators: validators.clone(),
            threshold: *threshold,
        }),

        IsmNode::Aggregation {
            threshold,
            sub_isms,
        } => {
            let sub_specs = sub_isms
                .iter()
                .map(|sub| spec_for_node_with_pdas(sub, message, program_id, accounts_iter))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(MetadataSpec::Aggregation {
                threshold: *threshold,
                sub_specs,
            })
        }

        IsmNode::AmountRouting {
            threshold,
            lower,
            upper,
        } => {
            let amount = parse_routing_amount(&message.body).ok_or(Error::InvalidMessageBody)?;
            let sub_ism = if amount >= *threshold { upper } else { lower };
            spec_for_node_with_pdas(sub_ism, message, program_id, accounts_iter)
        }

        IsmNode::FallbackRouting { mailbox } => {
            // Expect the domain PDA as the next account.
            let domain_pda_info = accounts_iter.next().ok_or(Error::InvalidDomainPda)?;
            let (expected_key, _) = derive_domain_pda(program_id, message.origin);
            if *domain_pda_info.key != expected_key {
                return Err(Error::InvalidDomainPda);
            }

            // Try domain PDA first.
            let loaded =
                load_and_validate_domain_ism_storage(program_id, message.origin, domain_pda_info)
                    .map_err(|_| Error::InvalidConfig)?;

            if let Some(ref storage) = loaded {
                if let Some(ref ism) = storage.ism {
                    return spec_for_node_with_pdas(ism, message, program_id, accounts_iter);
                }
            }

            // Fallback path — expect inbox PDA, then fallback storage PDA.
            let inbox_pda_info = accounts_iter.next().ok_or(Error::InvalidMailboxAccount)?;
            let (expected_inbox_key, _) =
                Pubkey::find_program_address(&[b"hyperlane", b"-", b"inbox"], mailbox);
            if *inbox_pda_info.key != expected_inbox_key {
                return Err(Error::InvalidMailboxAccount);
            }

            let inbox = InboxAccount::fetch_data(&mut &inbox_pda_info.data.borrow()[..])
                .map_err(|_| Error::InvalidMailboxAccount)?
                .ok_or(Error::InvalidMailboxAccount)?;
            let fallback_program_id = inbox.default_ism;

            let fallback_storage_info = accounts_iter
                .next()
                .ok_or(Error::InvalidFallbackIsmAccount)?;
            let (expected_fallback_key, _) =
                Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &fallback_program_id);
            if *fallback_storage_info.key != expected_fallback_key {
                return Err(Error::InvalidFallbackIsmAccount);
            }

            let fallback_storage =
                CompositeIsmAccount::fetch_data(&mut &fallback_storage_info.data.borrow()[..])
                    .map_err(|_| Error::InvalidFallbackIsmAccount)?
                    .ok_or(Error::InvalidFallbackIsmAccount)?;
            let fallback_root = fallback_storage.root.ok_or(Error::ConfigNotSet)?;

            spec_for_node_with_pdas(&fallback_root, message, &fallback_program_id, accounts_iter)
        }

        IsmNode::TrustedRelayer { .. }
        | IsmNode::Test { .. }
        | IsmNode::Pausable { .. }
        | IsmNode::RateLimited { .. } => Ok(MetadataSpec::Null),
    }
}
