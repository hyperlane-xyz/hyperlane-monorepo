use std::{collections::BTreeMap, fs::File, path::Path};

use serde::{Deserialize, Serialize};
use solana_program::pubkey::Pubkey;

use crate::{
    artifacts::{write_json, SingularProgramIdArtifact},
    cmd_utils::{create_new_directory, deploy_program},
    core::adjust_gas_price_if_needed,
    CompositeIsmCmd, CompositeIsmSubCmd, Context,
};

use hyperlane_core::H160;
use hyperlane_sealevel_composite_ism::{
    accounts::{CompositeIsmAccount, IsmNode},
    instruction::{
        initialize_instruction, set_domain_ism_instruction, transfer_ownership_instruction,
        update_config_instruction,
    },
};

/// JSON-friendly mirror of [`IsmNode`].
///
/// Uses `"type"` as the discriminant tag with camelCase variant names,
/// matching the config file format described in `README.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum IsmNodeConfig {
    TrustedRelayer {
        #[serde(with = "crate::serde::serde_pubkey")]
        relayer: Pubkey,
    },
    MultisigMessageId {
        validators: Vec<H160>,
        threshold: u8,
    },
    Aggregation {
        threshold: u8,
        sub_isms: Vec<IsmNodeConfig>,
    },
    Routing {
        #[serde(skip_serializing_if = "Option::is_none")]
        default_ism: Option<Box<IsmNodeConfig>>,
        /// Per-domain ISM configs.  Keys are origin domain IDs.
        ///
        /// This field exists only in the CLI config file — it is not stored in
        /// the root ISM node on-chain.  During `deploy` and `update`, each entry
        /// is submitted as a separate `SetDomainIsm` transaction after the root
        /// `Initialize` / `UpdateConfig` transaction.
        /// JSON object keys must be strings, so domain IDs are stored as decimal
        /// strings (e.g. `"1399811149"`).  `collect_domain_isms` parses them to u32.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        domains: BTreeMap<String, IsmNodeConfig>,
    },
    Test {
        accept: bool,
    },
    Pausable {
        paused: bool,
    },
    AmountRouting {
        /// Big-endian u256 as a `"0x..."` hex string (64 hex chars = 32 bytes).
        #[serde(with = "serde_hex_bytes32")]
        threshold: [u8; 32],
        lower: Box<IsmNodeConfig>,
        upper: Box<IsmNodeConfig>,
    },
}

impl From<IsmNodeConfig> for IsmNode {
    fn from(val: IsmNodeConfig) -> Self {
        match val {
            IsmNodeConfig::TrustedRelayer { relayer } => IsmNode::TrustedRelayer { relayer },
            IsmNodeConfig::MultisigMessageId {
                validators,
                threshold,
            } => IsmNode::MultisigMessageId {
                validators,
                threshold,
            },
            IsmNodeConfig::Aggregation {
                threshold,
                sub_isms,
            } => IsmNode::Aggregation {
                threshold,
                sub_isms: sub_isms.into_iter().map(Into::into).collect(),
            },
            IsmNodeConfig::Routing {
                default_ism,
                domains: _, // domain ISMs are submitted via SetDomainIsm, not stored in the root node
            } => IsmNode::Routing {
                default_ism: default_ism.map(|n| Box::new(IsmNode::from(*n))),
            },
            IsmNodeConfig::Test { accept } => IsmNode::Test { accept },
            IsmNodeConfig::Pausable { paused } => IsmNode::Pausable { paused },
            IsmNodeConfig::AmountRouting {
                threshold,
                lower,
                upper,
            } => IsmNode::AmountRouting {
                threshold,
                lower: Box::new(IsmNode::from(*lower)),
                upper: Box::new(IsmNode::from(*upper)),
            },
        }
    }
}

impl From<IsmNode> for IsmNodeConfig {
    fn from(val: IsmNode) -> Self {
        match val {
            IsmNode::TrustedRelayer { relayer } => IsmNodeConfig::TrustedRelayer { relayer },
            IsmNode::MultisigMessageId {
                validators,
                threshold,
            } => IsmNodeConfig::MultisigMessageId {
                validators,
                threshold,
            },
            IsmNode::Aggregation {
                threshold,
                sub_isms,
            } => IsmNodeConfig::Aggregation {
                threshold,
                sub_isms: sub_isms.into_iter().map(Into::into).collect(),
            },
            IsmNode::Routing { default_ism } => IsmNodeConfig::Routing {
                default_ism: default_ism.map(|n| Box::new(IsmNodeConfig::from(*n))),
                domains: BTreeMap::new(), // on-chain node has no domain map; domain PDAs are separate
            },
            IsmNode::Test { accept } => IsmNodeConfig::Test { accept },
            IsmNode::Pausable { paused } => IsmNodeConfig::Pausable { paused },
            IsmNode::AmountRouting {
                threshold,
                lower,
                upper,
            } => IsmNodeConfig::AmountRouting {
                threshold,
                lower: Box::new(IsmNodeConfig::from(*lower)),
                upper: Box::new(IsmNodeConfig::from(*upper)),
            },
            IsmNode::RateLimited { .. } => {
                panic!("RateLimited ISM nodes have no JSON config representation")
            }
        }
    }
}

/// Serde helper: serializes `[u8; 32]` as `"0x<64 hex chars>"`.
mod serde_hex_bytes32 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 32], ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&format!("0x{}", hex::encode(bytes)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(de: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(de)?;
        let hex_str = s.strip_prefix("0x").unwrap_or(&s);
        let bytes = hex::decode(hex_str).map_err(serde::de::Error::custom)?;
        bytes
            .try_into()
            .map_err(|_| serde::de::Error::custom("amountRouting threshold must be 32 bytes"))
    }
}

/// Recursively walks an `IsmNodeConfig` tree and returns the domain ISM map
/// from the first `Routing` node found, as a `Vec<(domain, IsmNodeConfig)>`.
///
/// Returns an empty vec if there is no `Routing` node or its `domains` map is
/// empty.  Since the program enforces at most one `Routing` node per
/// deployment, this always collects at most one batch of domain ISMs.
fn collect_domain_isms(config: &IsmNodeConfig) -> Vec<(u32, IsmNodeConfig)> {
    match config {
        IsmNodeConfig::Routing { domains, .. } => domains
            .iter()
            .map(|(k, v)| {
                let domain = k
                    .parse::<u32>()
                    .unwrap_or_else(|_| panic!("domain key {k:?} is not a valid u32"));
                (domain, v.clone())
            })
            .collect(),
        IsmNodeConfig::Aggregation { sub_isms, .. } => {
            sub_isms.iter().flat_map(collect_domain_isms).collect()
        }
        IsmNodeConfig::AmountRouting { lower, upper, .. } => {
            let mut result = collect_domain_isms(lower);
            result.extend(collect_domain_isms(upper));
            result
        }
        _ => vec![],
    }
}

pub(crate) fn process_composite_ism_cmd(mut ctx: Context, cmd: CompositeIsmCmd) {
    match cmd.cmd {
        CompositeIsmSubCmd::Deploy(deploy) => {
            adjust_gas_price_if_needed(&deploy.chain, &mut ctx);

            let environments_dir = create_new_directory(
                &deploy.env_args.environments_dir,
                &deploy.env_args.environment,
            );
            let ism_dir = create_new_directory(&environments_dir, "composite-ism");
            let chain_dir = create_new_directory(&ism_dir, &deploy.chain);
            let key_dir = create_new_directory(&chain_dir, "keys");

            let root = load_config(&deploy.config_file);
            let program_id = deploy_composite_ism(
                &mut ctx,
                &deploy.built_so_dir,
                &key_dir,
                deploy.local_domain,
                root,
            );

            write_json::<SingularProgramIdArtifact>(
                &chain_dir.join("program-ids.json"),
                program_id.into(),
            );
        }
        CompositeIsmSubCmd::Update(update) => {
            let root = load_config(&update.config_file);
            let domain_isms = collect_domain_isms(&root);

            let instruction =
                update_config_instruction(update.program_id, ctx.payer_pubkey, root.into())
                    .unwrap();
            ctx.new_txn()
                .add_with_description(instruction, "Update composite ISM config".to_string())
                .send_with_payer();

            for (domain, ism_config) in domain_isms {
                let instruction = set_domain_ism_instruction(
                    update.program_id,
                    ctx.payer_pubkey,
                    domain,
                    ism_config.into(),
                )
                .unwrap();
                ctx.new_txn()
                    .add_with_description(
                        instruction,
                        format!("Set domain ISM for origin domain {domain}"),
                    )
                    .send_with_payer();
            }
        }
        CompositeIsmSubCmd::Read(read) => {
            read_composite_ism(&ctx, read.program_id);
        }
        CompositeIsmSubCmd::SetDomainIsm(set_domain) => {
            let ism_node: IsmNode = load_config(&set_domain.config_file).into();
            let instruction = set_domain_ism_instruction(
                set_domain.program_id,
                ctx.payer_pubkey,
                set_domain.domain,
                ism_node,
            )
            .unwrap();
            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!("Set domain ISM for origin domain {}", set_domain.domain),
                )
                .send_with_payer();
        }
        CompositeIsmSubCmd::TransferOwnership(transfer_ownership) => {
            let instruction = transfer_ownership_instruction(
                transfer_ownership.program_id,
                ctx.payer_pubkey,
                Some(transfer_ownership.new_owner),
            )
            .unwrap();
            ctx.new_txn()
                .add_with_description(
                    instruction,
                    format!("Transfer ownership to {}", transfer_ownership.new_owner),
                )
                .send_with_payer();
        }
    }
}

pub(crate) fn load_config(config_file: &Path) -> IsmNodeConfig {
    let file = File::open(config_file).expect("Failed to open config file");
    serde_json::from_reader(file).expect("Failed to parse config file as IsmNodeConfig")
}

pub(crate) fn deploy_composite_ism(
    ctx: &mut Context,
    built_so_dir: &Path,
    key_dir: &Path,
    local_domain: u32,
    root: IsmNodeConfig,
) -> Pubkey {
    let program_id = deploy_program(
        ctx.payer_keypair_path(),
        key_dir,
        "hyperlane_sealevel_composite_ism",
        built_so_dir
            .join("hyperlane_sealevel_composite_ism.so")
            .to_str()
            .unwrap(),
        &ctx.client.url(),
        local_domain,
    )
    .unwrap();

    println!("Deployed Composite ISM at program ID {}", program_id);

    let domain_isms = collect_domain_isms(&root);

    let instruction = initialize_instruction(program_id, ctx.payer_pubkey, root.into()).unwrap();
    ctx.new_txn()
        .add_with_description(
            instruction,
            format!(
                "Initializing Composite ISM with payer & owner {}",
                ctx.payer_pubkey
            ),
        )
        .send_with_payer();
    println!("Initialized Composite ISM at program ID {}", program_id);

    for (domain, ism_config) in domain_isms {
        let instruction =
            set_domain_ism_instruction(program_id, ctx.payer_pubkey, domain, ism_config.into())
                .unwrap();
        ctx.new_txn()
            .add_with_description(
                instruction,
                format!("Set domain ISM for origin domain {domain}"),
            )
            .send_with_payer();
    }

    program_id
}

fn read_composite_ism(ctx: &Context, program_id: Pubkey) {
    use hyperlane_sealevel_composite_ism::accounts::DomainIsmAccount;

    // Seeds match VERIFY_ACCOUNT_METAS_PDA_SEEDS from the ISM interface library,
    // which is what storage_pda_seeds!() expands to in the composite ISM crate.
    let storage_seeds: &[&[u8]] = &[b"hyperlane_ism", b"-", b"verify", b"-", b"account_metas"];
    let (storage_pda_key, _) = Pubkey::find_program_address(storage_seeds, &program_id);

    let account = ctx
        .client
        .get_account_with_commitment(&storage_pda_key, ctx.commitment)
        .expect("Failed to fetch storage PDA")
        .value
        .expect("Storage PDA not found — has the program been initialized?");

    let storage = CompositeIsmAccount::fetch(&mut &account.data[..])
        .expect("Failed to deserialize storage PDA")
        .into_inner();

    println!("owner: {:?}", storage.owner);

    match storage.root {
        Some(root) => {
            let mut config: IsmNodeConfig = root.into();

            // Enumerate all domain PDAs by fetching every account owned by the
            // program.  Each DomainIsmStorage stores its own domain ID inline,
            // so no config file is needed to recover which domain each PDA covers.
            let all_accounts = ctx
                .client
                .get_program_accounts(&program_id)
                .expect("Failed to enumerate program accounts");

            // Build a map of domain → IsmNodeConfig from domain PDAs.
            let mut domain_map: BTreeMap<String, IsmNodeConfig> = BTreeMap::new();
            for (pubkey, acct) in &all_accounts {
                if *pubkey == storage_pda_key {
                    continue; // skip root storage PDA
                }
                if let Ok(domain_storage) = DomainIsmAccount::fetch(&mut &acct.data[..]) {
                    let s = domain_storage.into_inner();
                    if let Some(ism) = s.ism {
                        domain_map.insert(s.domain.to_string(), IsmNodeConfig::from(ism));
                    }
                }
            }

            if !domain_map.is_empty() {
                inject_routing_domains(&mut config, &mut domain_map);
            }

            println!(
                "{}",
                serde_json::to_string_pretty(&config).expect("Failed to serialize config")
            );
        }
        None => println!("root: null (uninitialized)"),
    }
}

/// Recursively walks the config tree, and for the first `Routing` node found,
/// drains `domain_map` into its `domains` field.
fn inject_routing_domains(
    config: &mut IsmNodeConfig,
    domain_map: &mut BTreeMap<String, IsmNodeConfig>,
) {
    match config {
        IsmNodeConfig::Routing { domains, .. } => {
            domains.append(domain_map);
        }
        IsmNodeConfig::Aggregation { sub_isms, .. } => {
            for sub in sub_isms.iter_mut() {
                if domain_map.is_empty() {
                    break;
                }
                inject_routing_domains(sub, domain_map);
            }
        }
        IsmNodeConfig::AmountRouting { lower, upper, .. } => {
            inject_routing_domains(lower, domain_map);
            if !domain_map.is_empty() {
                inject_routing_domains(upper, domain_map);
            }
        }
        _ => {}
    }
}
