use std::{fs::File, path::Path};

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
    accounts::{CompositeIsmAccount, DomainConfig, IsmNode},
    instruction::{
        initialize_instruction, transfer_ownership_instruction, update_config_instruction,
    },
};

/// A single entry in a routing ISM's route table.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RoutingEntry {
    pub domain: u32,
    pub ism: IsmNodeConfig,
}

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
        domain_configs: Vec<DomainConfigJson>,
    },
    Aggregation {
        threshold: u8,
        sub_isms: Vec<IsmNodeConfig>,
    },
    Routing {
        routes: Vec<RoutingEntry>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default_ism: Option<Box<IsmNodeConfig>>,
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

/// JSON-friendly mirror of [`DomainConfig`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DomainConfigJson {
    pub origin: u32,
    pub validators: Vec<H160>,
    pub threshold: u8,
}

impl From<DomainConfigJson> for DomainConfig {
    fn from(val: DomainConfigJson) -> Self {
        DomainConfig {
            origin: val.origin,
            validators: val.validators,
            threshold: val.threshold,
        }
    }
}

impl From<DomainConfig> for DomainConfigJson {
    fn from(val: DomainConfig) -> Self {
        DomainConfigJson {
            origin: val.origin,
            validators: val.validators,
            threshold: val.threshold,
        }
    }
}

impl From<IsmNodeConfig> for IsmNode {
    fn from(val: IsmNodeConfig) -> Self {
        match val {
            IsmNodeConfig::TrustedRelayer { relayer } => IsmNode::TrustedRelayer { relayer },
            IsmNodeConfig::MultisigMessageId { domain_configs } => IsmNode::MultisigMessageId {
                domain_configs: domain_configs.into_iter().map(Into::into).collect(),
            },
            IsmNodeConfig::Aggregation {
                threshold,
                sub_isms,
            } => IsmNode::Aggregation {
                threshold,
                sub_isms: sub_isms.into_iter().map(Into::into).collect(),
            },
            IsmNodeConfig::Routing {
                routes,
                default_ism,
            } => IsmNode::Routing {
                routes: routes
                    .into_iter()
                    .map(|e| (e.domain, e.ism.into()))
                    .collect(),
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
            IsmNode::MultisigMessageId { domain_configs } => IsmNodeConfig::MultisigMessageId {
                domain_configs: domain_configs.into_iter().map(Into::into).collect(),
            },
            IsmNode::Aggregation {
                threshold,
                sub_isms,
            } => IsmNodeConfig::Aggregation {
                threshold,
                sub_isms: sub_isms.into_iter().map(Into::into).collect(),
            },
            IsmNode::Routing {
                routes,
                default_ism,
            } => IsmNodeConfig::Routing {
                routes: routes
                    .into_iter()
                    .map(|(domain, ism)| RoutingEntry {
                        domain,
                        ism: ism.into(),
                    })
                    .collect(),
                default_ism: default_ism.map(|n| Box::new(IsmNodeConfig::from(*n))),
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
            let instruction =
                update_config_instruction(update.program_id, ctx.payer_pubkey, root.into())
                    .unwrap();
            ctx.new_txn()
                .add_with_description(instruction, "Update composite ISM config".to_string())
                .send_with_payer();
        }
        CompositeIsmSubCmd::Read(read) => {
            read_composite_ism(&ctx, read.program_id);
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

    program_id
}

fn read_composite_ism(ctx: &Context, program_id: Pubkey) {
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
            let config: IsmNodeConfig = root.into();
            println!(
                "{}",
                serde_json::to_string_pretty(&config).expect("Failed to serialize config")
            );
        }
        None => println!("root: null (uninitialized)"),
    }
}
