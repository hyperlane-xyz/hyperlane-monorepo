//! Typed, owned configuration. Signer keys remain opaque bytes and are never formatted.
const std = @import("std");
pub const Role = enum { relayer, validator, scraper };
pub const Protocol = enum { ethereum, sealevel, cosmos, cosmosnative, starknet, radix, aleo, tron };
pub const TechnicalStack = enum { arbitrumnitro, starknet, opstack, polygoncdk, polkadotsubstrate, seismic, zksync, other };
pub const Reorg = union(enum) { blocks: u32, tag: []const u8 };
pub const Signer = union(enum) {
    node,
    hex_key: [32]u8,
    aws: struct { id: []const u8, region: []const u8 },
    gcp: struct { key_version_name: []const u8 },
    cosmos_key: struct { key: [32]u8, prefix: []const u8, account_address_type: []const u8 },
    stark_key: struct { key: [32]u8, address: [32]u8, legacy: bool },
    radix_key: struct { key: [32]u8, suffix: []const u8 },
};
pub const CheckpointSyncer = union(enum) {
    local_storage: []const u8,
    s3: struct { bucket: []const u8, region: []const u8, folder: ?[]const u8 },
    gcs: struct { bucket: []const u8, folder: ?[]const u8, service_account_key: ?[]const u8, user_secrets: ?[]const u8, use_application_default: bool },
};
pub const Contracts = struct { mailbox: [32]u8, interchain_gas_paymaster: [32]u8, validator_announce: [32]u8, merkle_tree_hook: [32]u8 };
pub const Index = struct { from: i64 = 0, chunk: u32 = 1999, mode: enum { block, sequence } = .block, interval: u64 = 5, configured_interval: ?u64 = null };
pub const Consensus = enum { single, fallback, quorum };
pub const Connection = union(Protocol) {
    ethereum: struct { consensus: Consensus, consider_null_transaction_receipt: bool, fallback_hedge_delay_ms: ?u64, fallback_hedge_timeout_ms: ?u64, transaction_overrides: TransactionOverrides, mev_submission: ?struct { rpc_urls: []const []const u8, ica_router: [32]u8, additional_ica_routers: []const [32]u8 } },
    sealevel: struct { max_supported_transaction_version: u8, transaction_submitter: enum { rpc, jito }, transaction_submitter_urls: []const []const u8, priority_fee: u64, priority_fee_oracle: union(enum) { constant: u64, helius: struct { url: []const u8, fee_level: []const u8 } }, mailbox_process_alts: []const [32]u8, process_alt_overrides: []const struct { matching_list: MatchingList, alt_addresses: []const [32]u8 }, ur_reveal: ?struct { ccs_url: []const u8, program_id: [32]u8 }, native_token_decimals: u32 },
    cosmos: Cosmos,
    cosmosnative: Cosmos,
    starknet: struct { native_token: [32]u8 },
    radix: struct { gateway_urls: []const []const u8, network_name: []const u8 },
    aleo: struct { mailbox_program: []const u8, hook_manager_program: []const u8, ism_manager_program: []const u8, validator_announce_program: []const u8, proving_service_urls: []const []const u8, priority_fee_multiplier: f64 },
    tron: struct { wallet_urls: []const []const u8, wallet_solidity_urls: []const []const u8, fee_multiplier: ?f64 },
};
pub const Cosmos = struct { chain_id: []const u8, bech32_prefix: []const u8, gas_price: struct { amount: []const u8, denom: []const u8 }, contract_address_bytes: u64, gas_multiplier: f64, compat_mode: ?[]const u8, canonical_asset: []const u8 };
pub const Chain = struct {
    name: []const u8,
    domain: u32,
    protocol: Protocol,
    chain_id: []const u8,
    technical_stack: TechnicalStack = .other,
    rpc_urls: []const []const u8,
    grpc_urls: []const []const u8,
    contracts: Contracts,
    index: Index,
    signer: ?Signer,
    identity: ?Signer,
    ccs_signer: ?Signer,
    reorg: Reorg,
    confirmations: u32,
    estimated_block_time: f64,
    native_token: struct { decimals: u32, symbol: []const u8, denom: []const u8 },
    connection: Connection,
    submitter: enum { classic, lander },
    max_batch_size: u32,
    batch_contract_address: ?[32]u8,
    bypass_batch_simulation: bool,
    max_submit_queue_length: ?u32,
    ignore_reorg_reports: bool,
};
pub const Rpc = struct { url: []const u8, public: bool };
pub const Validator = struct { rpcs: []const Rpc, origin_chain: []const u8, db: []const u8, signer: Signer, checkpoint_syncer: CheckpointSyncer, interval: u64, max_sign_concurrency: u64, lightweight: bool, allow_public_rpcs: bool, skip_announce: bool, websocket_url: ?[]const u8, checkpoint_consensus: ?enum { majority, quorum } };
pub const Relayer = struct {
    gas_payment_enforcement: []const GasEnforcement,
    whitelist: MatchingList,
    blacklist: MatchingList,
    address_blacklist: []const []const u8,
    metric_app_contexts: []const MetricContext,
    ism_cache_configs: []const IsmCache,
    relay_api_rate_limit_max_requests: ?u32,
    relay_api_rate_limit_window_secs: ?u64,
    relay_api_cors_origins: []const []const u8,
    relay_chains: []const []const u8,
    db: []const u8,
    transaction_gas_limit: ?u256,
    skip_transaction_gas_limit_for: []const u32,
    allow_local_checkpoint_syncers: bool,
    allow_contract_call_caching: bool,
    max_message_retries: u32,
    tx_id_indexing_enabled: bool,
    igp_indexing_enabled: bool,
    runtime_denylist_url: ?[]const u8,
    runtime_denylist_poll_interval_seconds: u64,
    websocket_url: ?[]const u8,
    websocket_authority_enabled: bool,
    relay_api_enabled: bool,
    relay_api_port: ?u16,
};
pub const Scraper = struct { ccr_routers: []const CcrRouter, chains_to_scrape: []const []const u8, db: []const u8, db_max_connections: u32, db_acquire_timeout_ms: u32 };
pub const Agent = union(Role) { relayer: Relayer, validator: Validator, scraper: Scraper };
pub fn Filter(comptime T: type) type {
    return union(enum) { wildcard, values: []const T };
}
pub const Rule = struct { message_id: Filter([32]u8) = .wildcard, origin_domain: Filter(u32) = .wildcard, sender_address: Filter([32]u8) = .wildcard, destination_domain: Filter(u32) = .wildcard, recipient_address: Filter([32]u8) = .wildcard, body_regex: ?[]const u8 = null };
pub const MatchingList = []const Rule;
pub const GasEnforcement = struct { matching_list: MatchingList, policy: union(enum) { none, minimum: u256, on_chain_fee_quoting: struct { numerator: u64, denominator: u64 } } };
pub const MetricContext = struct { name: []const u8, matching_list: MatchingList };
pub const IsmCache = struct { selector: union(enum) { default_ism, app_context: []const u8 }, module_types: []const u8, chains: ?[]const []const u8, cache_policy: enum { message_specific, ism_specific } };
pub const CcrRouter = struct { domain: u32, router: [20]u8, token: [20]u8 };
pub const TransactionOverrides = struct {
    gas_price: ?u256,
    gas_limit: ?u256,
    max_fee_per_gas: ?u256,
    max_priority_fee_per_gas: ?u256,
    priority_fee_cap: ?u256,
    min_gas_price: ?u256,
    min_fee_per_gas: ?u256,
    min_priority_fee_per_gas: ?u256,
    gas_price_multiplier_denominator: ?u256,
    gas_price_multiplier_numerator: ?u256,
    gas_price_cap_multiplier: ?u256,
    gas_price_cap: ?u256,
    gas_limit_cap: ?u256,
};
