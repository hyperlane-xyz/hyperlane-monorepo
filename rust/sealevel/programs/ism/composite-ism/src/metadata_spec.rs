use account_utils::DiscriminatorEncode;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Encode, HyperlaneMessage, H160};
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program::{get_return_data, invoke},
    pubkey::Pubkey,
};

use crate::{
    accounts::{derive_domain_pda, load_and_validate_domain_ism_storage, IsmNode},
    error::Error,
    instruction::Instruction as CompositeInstruction,
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

/// Loads the domain ISM from `domain_pda_info` and resolves its spec.
/// Returns `Ok(Some(spec))` if a domain ISM is configured, `Ok(None)` to fall through.
fn try_spec_via_domain_ism<'a, 'info, I>(
    program_id: &Pubkey,
    message: &HyperlaneMessage,
    domain_pda_info: &AccountInfo<'info>,
    accounts_iter: &mut I,
) -> Result<Option<MetadataSpec>, Error>
where
    I: Iterator<Item = &'a AccountInfo<'info>>,
    'info: 'a,
{
    let loaded = load_and_validate_domain_ism_storage(program_id, message.origin, domain_pda_info)
        .map_err(|_| Error::InvalidConfig)?;

    if let Some(ref storage) = loaded {
        if let Some(ref ism) = storage.ism {
            return spec_for_node_with_pdas(ism, message, program_id, accounts_iter).map(Some);
        }
    }

    Ok(None)
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
            let domain_pda_info = accounts_iter.next().ok_or(Error::InvalidDomainPda)?;
            let (expected_key, _) = derive_domain_pda(program_id, message.origin);
            if *domain_pda_info.key != expected_key {
                return Err(Error::InvalidDomainPda);
            }
            try_spec_via_domain_ism(program_id, message, domain_pda_info, accounts_iter)?
                .ok_or(Error::NoRouteForDomain)
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

        IsmNode::FallbackRouting { fallback_ism } => {
            let domain_pda_info = accounts_iter.next().ok_or(Error::InvalidDomainPda)?;
            let (expected_key, _) = derive_domain_pda(program_id, message.origin);
            if *domain_pda_info.key != expected_key {
                return Err(Error::InvalidDomainPda);
            }

            if let Some(spec) =
                try_spec_via_domain_ism(program_id, message, domain_pda_info, accounts_iter)?
            {
                return Ok(spec);
            }

            // Fallback path — CPI to the fallback ISM's GetMetadataSpec instruction.
            // The fallback program can be any ISM; if it does not implement
            // GetMetadataSpec (e.g. a standalone MultisigIsm), return Null so the
            // relayer can supply empty metadata and let on-chain Verify decide.
            let remaining_accounts: Vec<AccountInfo> = accounts_iter.cloned().collect();
            let remaining_metas: Vec<AccountMeta> = remaining_accounts
                .iter()
                .map(|ai| {
                    if ai.is_writable {
                        AccountMeta::new(*ai.key, ai.is_signer)
                    } else {
                        AccountMeta::new_readonly(*ai.key, ai.is_signer)
                    }
                })
                .collect();
            let Ok(ixn_data) = CompositeInstruction::GetMetadataSpec(message.to_vec()).encode()
            else {
                return Ok(MetadataSpec::Null);
            };
            let ixn = SolanaInstruction {
                program_id: *fallback_ism,
                accounts: remaining_metas,
                data: ixn_data,
            };
            if invoke(&ixn, &remaining_accounts).is_err() {
                return Ok(MetadataSpec::Null);
            }
            let Some((_, cpi_bytes)) = get_return_data() else {
                return Ok(MetadataSpec::Null);
            };
            match borsh::from_slice::<SimulationReturnData<MetadataSpec>>(&cpi_bytes) {
                Ok(s) => Ok(s.return_data),
                Err(_) => Ok(MetadataSpec::Null),
            }
        }

        IsmNode::TrustedRelayer { .. }
        | IsmNode::Test { .. }
        | IsmNode::Pausable { .. }
        | IsmNode::RateLimited { .. } => Ok(MetadataSpec::Null),
    }
}
