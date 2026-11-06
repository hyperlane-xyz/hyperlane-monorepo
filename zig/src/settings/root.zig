//! Rust agent settings parser. Explicit sources make parsing secret-agnostic and testable.
const std = @import("std");
const config = @import("../config.zig");
const types = @import("types.zig");
const View = @import("value.zig").View;
const csv = @import("value.zig").csv;
pub const Role = types.Role;
pub const Chain = types.Chain;
pub const Protocol = types.Protocol;
pub const Signer = types.Signer;
pub const CheckpointSyncer = types.CheckpointSyncer;
pub const LoadOptions = struct { defaults_dir: []const u8 = "./config", environment: []const config.EnvironmentEntry = &.{}, arguments: []const []const u8 = &.{} };
pub const Settings = struct {
    config: config.Config,
    chains: []Chain,
    metrics_port: u16,
    role: types.Agent,
    pub fn load(backing: std.mem.Allocator, role: Role, options: LoadOptions) !Settings {
        var scratch = std.heap.ArenaAllocator.init(backing);
        defer scratch.deinit();
        const a = scratch.allocator();
        var defaults: std.array_list.Managed([]const u8) = .init(a);
        var dir = try std.fs.cwd().openDir(options.defaults_dir, .{ .iterate = true });
        defer dir.close();
        var it = dir.iterate();
        while (try it.next()) |entry| {
            if (entry.kind == .file and std.mem.endsWith(u8, entry.name, ".json")) try defaults.append(try std.fs.path.join(a, &.{ options.defaults_dir, entry.name }));
        }
        var files: []const []const u8 = &.{};
        for (options.environment) |entry| {
            if (std.mem.eql(u8, entry.key, "CONFIG_FILES")) files = try csv(a, entry.value);
        }
        const cfg = try config.Config.load(backing, .{ .defaults = defaults.items, .files = files, .environment = options.environment, .arguments = options.arguments });
        return fromConfig(cfg, role);
    }
    /// Consumes cfg on success and failure.
    pub fn fromConfig(cfg: config.Config, role: Role) !Settings {
        var result: Settings = .{ .config = cfg, .chains = undefined, .metrics_port = 9090, .role = undefined };
        errdefer result.config.deinit();
        const a = result.config.arena.allocator();
        const v: View = .{ .value = result.config.root };
        result.metrics_port = try v.num(u16, "metricsport", 9090);
        const selector = switch (role) {
            .relayer => "relaychains",
            .validator => "originchainname",
            .scraper => "chainstoscrape",
        };
        const selected = try (try v.need(selector)).text();
        var names_list: std.array_list.Managed([]const u8) = .init(a);
        if (role == .validator) try names_list.append(selected) else {
            for (try csv(a, selected)) |name| {
                var seen = false;
                for (names_list.items) |existing| {
                    if (std.mem.eql(u8, name, existing)) seen = true;
                }
                if (!seen) try names_list.append(name);
            }
        }
        const names = try names_list.toOwnedSlice();
        _ = try optSigner(a, v.get("defaultsigner"));
        const chains = try v.need("chains");
        result.chains = try a.alloc(Chain, names.len);
        for (names, 0..) |name, i| {
            result.chains[i] = try parseChain(a, name, try chains.need(name), v.get("defaultsigner"), role);
        }
        result.role = switch (role) {
            .validator => .{ .validator = try parseValidator(a, v, &result.chains[0]) },
            .relayer => .{ .relayer = try parseRelayer(a, v, names, result.chains) },
            .scraper => .{ .scraper = .{ .ccr_routers = try parseCcr(a, v), .chains_to_scrape = names, .db = try (try v.need("db")).text(), .db_max_connections = try v.num(u32, "dbmaxconnections", 10), .db_acquire_timeout_ms = try v.num(u32, "dbacquiretimeoutmillis", 15000) } },
        };
        return result;
    }
    pub fn loadProcess(backing: std.mem.Allocator, role: Role, defaults_dir: []const u8) !Settings {
        var env = try std.process.getEnvMap(backing);
        defer env.deinit();
        var entries: std.array_list.Managed(config.EnvironmentEntry) = .init(backing);
        defer entries.deinit();
        var it = env.iterator();
        while (it.next()) |entry| try entries.append(.{ .key = entry.key_ptr.*, .value = entry.value_ptr.* });
        const args = try std.process.argsAlloc(backing);
        defer std.process.argsFree(backing, args);
        return load(backing, role, .{ .defaults_dir = defaults_dir, .environment = entries.items, .arguments = args[1..] });
    }
    pub fn deinit(self: *Settings) void {
        self.config.deinit();
        self.* = undefined;
    }
    pub fn chainByName(self: *const Settings, name: []const u8) ?*const Chain {
        for (self.chains) |*c| {
            if (std.mem.eql(u8, c.name, name)) return c;
        }
        return null;
    }
};
fn empty() View {
    return .{ .value = .null };
}
fn nonzero(comptime T: type, n: T) !T {
    if (n == 0) return error.ZeroConfigurationValue;
    return n;
}
fn uri(text: []const u8, websocket: bool) !void {
    const u = try std.Uri.parse(text);
    if (u.scheme.len == 0) return error.InvalidConfigUrl;
    if (websocket and !std.ascii.eqlIgnoreCase(u.scheme, "ws") and !std.ascii.eqlIgnoreCase(u.scheme, "wss")) return error.InvalidConfigUrl;
}
pub fn address(a: std.mem.Allocator, text: []const u8) ![32]u8 {
    var out: [32]u8 = @splat(0);
    if (std.mem.startsWith(u8, text, "0x")) {
        const h = text[2..];
        if (h.len != 40 and h.len != 64) return error.InvalidConfigAddress;
        _ = std.fmt.hexToBytes(out[32 - h.len / 2 ..], h) catch return error.InvalidConfigAddress;
        return out;
    }
    var buf: [128]u8 = undefined;
    if (@import("../altvm/bech32.zig").decodeAny(text, &buf)) |decoded| {
        if (decoded.bytes.len > 32) return error.InvalidConfigAddress;
        @memcpy(out[32 - decoded.bytes.len ..], decoded.bytes);
        return out;
    } else |_| {}
    const bytes = @import("../altvm/base58.zig").decode(a, text) catch return error.InvalidConfigAddress;
    if (bytes.len == 32) @memcpy(&out, bytes) else if (bytes.len == 25) @memcpy(out[12..], bytes[1..21]) else return error.InvalidConfigAddress;
    return out;
}
fn addr(a: std.mem.Allocator, v: View, key: []const u8) ![32]u8 {
    return address(a, try (try v.need(key)).text());
}
fn optionalAddr(a: std.mem.Allocator, v: View, key: []const u8) !?[32]u8 {
    return if (v.get(key)) |x| try address(a, try x.text()) else null;
}
pub fn parseSigner(a: std.mem.Allocator, v: View) !Signer {
    if (v.value != .object) return error.InvalidSignerObject;
    const kind = try v.optional("type") orelse if (v.get("key") != null) "hexKey" else if (v.get("id") != null or v.get("region") != null) "aws" else return .node;
    if (std.mem.eql(u8, kind, "hexKey")) return .{ .hex_key = try addr(a, v, "key") };
    if (std.mem.eql(u8, kind, "aws")) return .{ .aws = .{ .id = try (try v.need("id")).text(), .region = try (try v.need("region")).text() } };
    if (std.mem.eql(u8, kind, "gcp")) return .{ .gcp = .{ .key_version_name = try (try v.need("keyversionname")).text() } };
    if (std.mem.eql(u8, kind, "cosmosKey")) {
        const at = try v.str("accountaddresstype", "Bitcoin");
        if (!std.mem.eql(u8, at, "Bitcoin") and !std.mem.eql(u8, at, "Ethereum")) return error.InvalidAccountAddressType;
    }
    if (std.mem.eql(u8, kind, "cosmosKey")) return .{ .cosmos_key = .{ .key = try addr(a, v, "key"), .prefix = try (try v.need("prefix")).text(), .account_address_type = try v.str("accountaddresstype", "Bitcoin") } };
    if (std.mem.eql(u8, kind, "starkKey")) return .{ .stark_key = .{ .key = try optionalAddr(a, v, "key") orelse @splat(0), .address = try optionalAddr(a, v, "address") orelse @splat(0), .legacy = try v.flag("legacy", false) } };
    if (std.mem.eql(u8, kind, "radixKey")) return .{ .radix_key = .{ .key = try optionalAddr(a, v, "key") orelse @splat(0), .suffix = try v.str("suffix", "") } };
    return error.UnknownSignerType;
}
fn optSigner(a: std.mem.Allocator, v: ?View) !?Signer {
    return if (v) |x| try parseSigner(a, x) else null;
}
fn urls(a: std.mem.Allocator, v: View, key: []const u8, custom: []const u8, required: bool) ![]const []const u8 {
    var list: std.array_list.Managed([]const u8) = .init(a);
    if (v.get(key)) |raw| {
        for (try raw.array(a)) |entry| {
            const url = try (try (View{ .value = entry }).need("http")).text();
            try uri(url, false);
            try list.append(url);
        }
    } else if (required) return error.MissingConfiguration;
    if (try v.optional(custom)) |override| {
        list.clearRetainingCapacity();
        for (try csv(a, override)) |url| {
            try uri(url, false);
            try list.append(url);
        }
    }
    if (required and list.items.len == 0) return error.EmptyRpcUrls;
    return list.toOwnedSlice();
}
fn parseReorg(v: View) !types.Reorg {
    if (v.value == .string) {
        if (std.fmt.parseInt(u32, v.value.string, 10)) |n| return .{ .blocks = n } else |_| return .{ .tag = v.value.string };
    }
    return .{ .blocks = try v.int(u32) };
}
fn parseChain(a: std.mem.Allocator, name: []const u8, v: View, default_signer: ?View, role: Role) !Chain {
    if (!std.mem.eql(u8, name, try (try v.need("name")).text())) return error.ChainNameMismatch;
    const protocol_text = try (try v.need("protocol")).text();
    var p: ?Protocol = null;
    inline for (@typeInfo(Protocol).@"enum".fields) |field| {
        if (std.ascii.eqlIgnoreCase(protocol_text, field.name)) p = @enumFromInt(field.value);
    }
    var protocol = p orelse return error.UnsupportedProtocol;
    const blocks = try optionalObject(v, "blocks");
    const index = try optionalObject(v, "index");
    const token = try optionalObject(v, "nativetoken");
    const domain = if (v.get("domainid")) |d| try d.int(u32) else try (try v.need("chainid")).int(u32);
    for (@import("known_domains.zig").entries) |known| {
        if (domain == known.id) {
            if (!std.ascii.eqlIgnoreCase(name, known.name)) return error.KnownDomainNameMismatch;
            protocol = known.protocol;
        } else if (std.ascii.eqlIgnoreCase(name, known.name)) return error.KnownDomainIdMismatch;
    }
    const stack = try v.str("technicalstack", "other");
    var technical_stack: types.TechnicalStack = .other;
    var stack_ok = false;
    for ([_][]const u8{ "arbitrumnitro", "starknet", "opstack", "polygoncdk", "polkadotsubstrate", "seismic", "zksync", "other" }) |allowed| {
        if (std.ascii.eqlIgnoreCase(stack, allowed)) {
            stack_ok = true;
            technical_stack = std.meta.stringToEnum(types.TechnicalStack, allowed).?;
        }
    }
    if (!stack_ok) return error.InvalidTechnicalStack;
    for (@import("known_domains.zig").entries) |known| if (domain == known.id) {
        technical_stack = known.technical_stack;
    };
    if (protocol != .sealevel and v.get("identity") != null) return error.IdentityRequiresSealevel;
    const id = if (v.get("chainid")) |idv| if (idv.value == .string) idv.value.string else try std.json.Stringify.valueAlloc(a, idv.value, .{}) else "";
    const mode_text = try index.str("mode", if (protocol == .sealevel) "sequence" else "block");
    const mode: @FieldType(types.Index, "mode") = if (std.mem.eql(u8, mode_text, "block")) .block else if (std.mem.eql(u8, mode_text, "sequence")) .sequence else return error.InvalidIndexMode;
    const interval = try index.optNum(u64, "interval");
    if (interval) |n| _ = try nonzero(u64, n);
    const estimated = try blocks.decimal("estimateblocktime", 1);
    if (blocks.get("estimateblocktime")) |x| {
        if (x.value == .string) return error.InvalidConfigFloat;
    }
    var c: Chain = .{ .name = name, .domain = domain, .protocol = protocol, .chain_id = id, .technical_stack = technical_stack, .rpc_urls = try urls(a, v, "rpcurls", "customrpcurls", true), .grpc_urls = &.{}, .contracts = .{ .mailbox = try addr(a, v, "mailbox"), .interchain_gas_paymaster = try addr(a, v, "interchaingaspaymaster"), .validator_announce = try addr(a, v, "validatorannounce"), .merkle_tree_hook = try addr(a, v, "merkletreehook") }, .index = .{ .from = try index.num(i64, "from", 0), .chunk = try index.num(u32, "chunk", 1999), .mode = mode, .interval = interval orelse 5, .configured_interval = interval }, .signer = try optSigner(a, v.get("signer") orelse default_signer), .identity = if (protocol == .sealevel) try optSigner(a, v.get("identity")) else null, .ccs_signer = try optSigner(a, v.get("ccssigner")), .reorg = if (blocks.get("reorgperiod")) |r| try parseReorg(r) else .{ .blocks = 1 }, .confirmations = try blocks.num(u32, "confirmations", 1), .estimated_block_time = estimated, .native_token = .{ .decimals = try token.num(u32, "decimals", 18), .symbol = try token.str("symbol", ""), .denom = try token.str("denom", "") }, .connection = undefined, .submitter = if (protocol == .ethereum or protocol == .aleo or protocol == .radix or protocol == .sealevel or protocol == .tron) .lander else .classic, .max_batch_size = try nonzero(u32, try v.num(u32, "maxbatchsize", 1)), .batch_contract_address = try optionalAddr(a, v, "batchcontractaddress"), .bypass_batch_simulation = try v.flag("bypassbatchsimulation", false), .max_submit_queue_length = try v.optNum(u32, "maxsubmitqueuelength"), .ignore_reorg_reports = try v.flag("ignorereorgreports", false) };
    if (try v.optional("submitter")) |s| {
        c.submitter = if (std.mem.eql(u8, s, "Classic")) .classic else if (std.mem.eql(u8, s, "Lander")) .lander else return error.InvalidSubmitter;
    }
    c.connection = switch (protocol) {
        .ethereum => blk: {
            var consensus = try v.str("rpcconsensustype", if (role == .validator) "quorum" else "fallback");
            if (role == .validator and (std.mem.eql(u8, consensus, "quorum") or std.mem.eql(u8, consensus, "majority"))) consensus = "fallback";
            const ct: types.Consensus = if (std.mem.eql(u8, consensus, "single")) .single else if (std.mem.eql(u8, consensus, "fallback")) .fallback else if (std.mem.eql(u8, consensus, "quorum")) .quorum else return error.InvalidRpcConsensus;
            const delay = try v.optNum(u64, "fallbackhedgedelaymillis");
            const timeout = try v.optNum(u64, "fallbackhedgetimeoutmillis");
            if (delay) |d| {
                _ = try nonzero(u64, d);
                if (ct != .fallback) return error.InvalidHedgeConfiguration;
            }
            if (timeout) |t| {
                _ = try nonzero(u64, t);
                if (delay == null) return error.InvalidHedgeConfiguration;
            }
            break :blk .{ .ethereum = .{ .consensus = ct, .consider_null_transaction_receipt = try v.flag("considernulltransactionreceipt", false), .transaction_overrides = try parseOverrides(v.get("transactionoverrides") orelse empty()), .mev_submission = try parseMev(a, v.get("mevsubmission"), c.submitter == .lander), .fallback_hedge_delay_ms = delay, .fallback_hedge_timeout_ms = if (delay != null) timeout orelse 30000 else null } };
        },
        .cosmos, .cosmosnative => blk: {
            c.grpc_urls = try urls(a, v, "grpcurls", "customgrpcurls", true);
            const gas = try v.need("gasprice");
            const prefix = try (try v.need("bech32prefix")).text();
            const cc: types.Cosmos = .{ .chain_id = try (try v.need("chainid")).text(), .bech32_prefix = prefix, .gas_price = .{ .amount = try (try gas.need("amount")).text(), .denom = try (try gas.need("denom")).text() }, .contract_address_bytes = try (try v.need("contractaddressbytes")).int(u64), .gas_multiplier = try v.decimal("gasmultiplier", 1.35), .compat_mode = try v.optional("compatmode"), .canonical_asset = try v.str("canonicalasset", try std.fmt.allocPrint(a, "u{s}", .{prefix})) };
            break :blk if (protocol == .cosmos) .{ .cosmos = cc } else .{ .cosmosnative = cc };
        },
        .starknet => .{ .starknet = .{ .native_token = try addr(a, token, "denom") } },
        .radix => .{ .radix = .{ .gateway_urls = try urls(a, v, "gatewayurls", "customgatewayurls", true), .network_name = try (try v.need("networkname")).text() } },
        .tron => .{ .tron = .{ .wallet_urls = try urls(a, v, "walleturls", "customwalleturls", true), .wallet_solidity_urls = try urls(a, v, "walletsolidityurls", "customwalletsolidityurls", true), .fee_multiplier = if (v.get("feemultiplier")) |f| try f.float() else null } },
        .aleo => .{ .aleo = .{ .mailbox_program = try (try v.need("mailboxprogram")).text(), .hook_manager_program = try (try v.need("hookmanagerprogram")).text(), .ism_manager_program = try (try v.need("ismmanagerprogram")).text(), .validator_announce_program = try (try v.need("validatorannounceprogram")).text(), .proving_service_urls = try urls(a, v, "provingserviceurls", "customprovingserviceurls", false), .priority_fee_multiplier = try v.decimal("priorityfeemultiplier", 0) } },
        .sealevel => .{ .sealevel = try parseSealevel(a, v, token) },
    };
    return c;
}
fn parseCheckpoint(v: View) !CheckpointSyncer {
    if (v.value != .object) return error.InvalidCheckpointSyncer;
    const kind = try (try v.need("type")).text();
    if (std.mem.eql(u8, kind, "localStorage")) return .{ .local_storage = try (try v.need("path")).text() };
    if (std.mem.eql(u8, kind, "s3")) return .{ .s3 = .{ .bucket = try (try v.need("bucket")).text(), .region = try (try v.need("region")).text(), .folder = try v.optional("folder") } };
    if (std.mem.eql(u8, kind, "gcs")) return .{ .gcs = .{ .bucket = try (try v.need("bucket")).text(), .folder = try v.optional("folder"), .service_account_key = try v.optional("serviceaccountkey"), .user_secrets = try v.optional("usersecrets"), .use_application_default = try v.flag("useapplicationdefault", false) } };
    return error.InvalidCheckpointSyncer;
}
fn parseValidator(a: std.mem.Allocator, v: View, c: *Chain) !types.Validator {
    const light = v.get("lightweight");
    const typo = v.get("leightweigt");
    const l = if (light) |x| if (x.value == .string and x.value.string.len == 0) true else try x.boolean() else false;
    const t = if (typo) |x| if (x.value == .string and x.value.string.len == 0) true else try x.boolean() else false;
    if (light != null and typo != null and l != t) return error.ConflictingLightweight;
    const lightweight = l or t;
    const ws = try v.optional("websocketurl");
    if (ws) |u| try uri(u, true);
    if (lightweight and ws == null) return error.MissingWebsocketUrl;
    const signer = try parseSigner(a, try v.need("validator"));
    if (c.signer == null and (c.protocol == .ethereum or c.protocol == .tron)) c.signer = signer;
    const all = try v.need("chains");
    const original = try all.need(c.name);
    const consensus = try original.str("rpcconsensustype", "majority");
    const cc: @FieldType(types.Validator, "checkpoint_consensus") = if (lightweight) .majority else if (std.mem.eql(u8, consensus, "quorum")) .quorum else if (std.mem.eql(u8, consensus, "majority")) .majority else if (std.mem.eql(u8, consensus, "single") or std.mem.eql(u8, consensus, "fallback")) null else return error.InvalidRpcConsensus;
    const concurrency = try v.num(u64, "maxsignconcurrency", 50);
    if (concurrency == 0 or concurrency > 1000) return error.InvalidConcurrency;
    return .{ .rpcs = try validatorRpcs(a, original), .origin_chain = c.name, .db = try v.str("db", try std.fs.path.join(a, &.{ try std.process.getCwdAlloc(a), try std.fmt.allocPrint(a, "validator_db_{s}", .{c.name}) })), .signer = signer, .checkpoint_syncer = try parseCheckpoint(try v.need("checkpointsyncer")), .interval = try nonzero(u64, try v.num(u64, "interval", c.index.configured_interval orelse 2)), .max_sign_concurrency = concurrency, .lightweight = lightweight, .allow_public_rpcs = lightweight or try v.flag("allowpublicrpcs", false), .skip_announce = try v.flag("skipannounce", false), .websocket_url = ws, .checkpoint_consensus = cc };
}
fn parseRelayer(a: std.mem.Allocator, v: View, names: []const []const u8, chains: []Chain) !types.Relayer {
    const local = try v.flag("allowlocalcheckpointsyncers", false);
    const caching = try v.flag("allowlocalcheckpointsyncers", true);
    var skip: std.array_list.Managed(u32) = .init(a);
    if (try v.optional("skiptransactiongaslimitfor")) |text| {
        for (try csv(a, text)) |name| {
            var found = false;
            for (chains) |c| {
                if (std.mem.eql(u8, name, c.name)) {
                    try skip.append(c.domain);
                    found = true;
                    break;
                }
            }
            if (!found) return error.UnknownChain;
        }
    }
    const ws = try v.optional("websocketurl");
    if (ws) |u| try uri(u, true);
    const authority = try v.flag("websocketauthorityenabled", false);
    if (authority and ws == null) return error.MissingWebsocketUrl;
    const deny = try v.optional("runtimedenylisturl");
    if (deny) |u| {
        try uri(u, false);
        const parsed = try std.Uri.parse(u);
        if (!std.mem.eql(u8, parsed.scheme, "http") and !std.mem.eql(u8, parsed.scheme, "https") and !std.mem.eql(u8, parsed.scheme, "file")) return error.InvalidDenylistUrl;
        if (std.mem.eql(u8, parsed.scheme, "file") and parsed.host != null) {
            if (!std.mem.eql(u8, parsed.host.?.percent_encoded, "localhost")) return error.NonlocalDenylistFile;
        }
    }
    return .{ .gas_payment_enforcement = try parseGas(a, v.get("gaspaymentenforcement")), .whitelist = try parseMatching(a, v.get("whitelist")), .blacklist = try parseMatching(a, v.get("blacklist")), .address_blacklist = try parseBlacklist(a, try v.optional("addressblacklist")), .metric_app_contexts = try parseContexts(a, v.get("metricappcontexts")), .ism_cache_configs = try parseCaches(a, v.get("ismcacheconfigs")), .relay_api_rate_limit_max_requests = try optNonzero(u32, try v.optNum(u32, "relayapiratelimitmaxrequests")), .relay_api_rate_limit_window_secs = try optNonzero(u64, try v.optNum(u64, "relayapiratelimitwindowsecs")), .relay_api_cors_origins = try trimCsv(a, try v.str("relayapicorsorigins", "https://nexus.hyperlane.xyz")), .relay_chains = names, .db = try v.str("db", try std.fs.path.join(a, &.{ try std.process.getCwdAlloc(a), "hyperlane_db" })), .transaction_gas_limit = try v.optNum(u256, "transactiongaslimit"), .skip_transaction_gas_limit_for = try skip.toOwnedSlice(), .allow_local_checkpoint_syncers = local, .allow_contract_call_caching = caching, .max_message_retries = try v.num(u32, "maxmessageretries", 66), .tx_id_indexing_enabled = try v.flag("txidindexingenabled", true), .igp_indexing_enabled = try v.flag("igpindexingenabled", true), .runtime_denylist_url = deny, .runtime_denylist_poll_interval_seconds = try nonzero(u64, try v.num(u64, "runtimedenylistpollintervalsecs", 60)), .websocket_url = ws, .websocket_authority_enabled = authority, .relay_api_enabled = try v.flag("relayapienabled", false), .relay_api_port = try v.optNum(u16, "relayapiport") };
}
fn optNonzero(comptime T: type, n: ?T) !?T {
    return if (n) |x| try nonzero(T, x) else null;
}
fn trimCsv(a: std.mem.Allocator, s: []const u8) ![]const []const u8 {
    var list: std.array_list.Managed([]const u8) = .init(a);
    for (try csv(a, s)) |part| {
        const t = std.mem.trim(u8, part, " \t\r\n");
        if (t.len != 0) try list.append(t);
    }
    return list.toOwnedSlice();
}
fn jsonArray(a: std.mem.Allocator, v: View) ![]const std.json.Value {
    if (v.value == .string) {
        const parsed = try std.json.parseFromSlice(std.json.Value, a, v.value.string, .{ .allocate = .alloc_always });
        return (View{ .value = try config.normalizedValue(a, parsed.value) }).array(a);
    }
    return v.array(a);
}
fn filter(a: std.mem.Allocator, comptime T: type, v: ?View) !types.Filter(T) {
    const raw = v orelse return .wildcard;
    if (raw.value == .string and std.mem.eql(u8, raw.value.string, "*")) return .wildcard;
    const values = if (raw.value == .array) raw.value.array.items else &[_]std.json.Value{raw.value};
    const out = try a.alloc(T, values.len);
    for (values, 0..) |entry, i| {
        const item: View = .{ .value = entry };
        out[i] = if (T == u32) try item.int(u32) else try address(a, try item.text());
    }
    return .{ .values = out };
}
pub fn parseMatching(a: std.mem.Allocator, raw: ?View) !types.MatchingList {
    const v = raw orelse return &.{};
    if (v.value == .null) return &.{};
    var value = v.value;
    if (value == .string) {
        const parsed = std.json.parseFromSlice(std.json.Value, a, value.string, .{ .allocate = .alloc_always }) catch return &.{};
        value = try config.normalizedValue(a, parsed.value);
    } else if (value != .array) return &.{};
    if (value == .null) return &.{};
    if (value != .array) return error.InvalidMatchingList;
    const entries = value.array.items;
    const rules = try a.alloc(types.Rule, entries.len);
    for (entries, 0..) |entry, i| {
        const item: View = .{ .value = entry };
        if (entry != .object) return error.InvalidMatchingList;
        var keys = entry.object.iterator();
        while (keys.next()) |key| {
            var allowed = false;
            for ([_][]const u8{ "messageid", "origindomain", "senderaddress", "destinationdomain", "recipientaddress", "bodyregex", "messageId", "originDomain", "senderAddress", "destinationDomain", "recipientAddress", "bodyRegex" }) |field| {
                if (std.mem.eql(u8, key.key_ptr.*, field)) allowed = true;
            }
            if (!allowed) return error.UnknownMatchingField;
        }
        rules[i] = .{ .message_id = try filter(a, [32]u8, item.get("messageid") orelse item.get("messageId")), .origin_domain = try filter(a, u32, item.get("origindomain") orelse item.get("originDomain")), .sender_address = try filter(a, [32]u8, item.get("senderaddress") orelse item.get("senderAddress")), .destination_domain = try filter(a, u32, item.get("destinationdomain") orelse item.get("destinationDomain")), .recipient_address = try filter(a, [32]u8, item.get("recipientaddress") orelse item.get("recipientAddress")), .body_regex = if (item.get("bodyregex") orelse item.get("bodyRegex")) |r| if (r.value == .null) null else try r.text() else null };
    }
    return rules;
}
fn parseGas(a: std.mem.Allocator, raw: ?View) ![]const types.GasEnforcement {
    var list: std.array_list.Managed(types.GasEnforcement) = .init(a);
    if (raw) |v| {
        const entries = try jsonArray(a, v);
        if (entries.len == 0) return error.EmptyGasEnforcement;
        for (entries) |entry| {
            const p: View = .{ .value = entry };
            const kind = try p.str("type", if (p.get("minimum") != null) "minimum" else "none");
            if (try p.optional("feetoken")) |token| {
                const h = try address(a, token);
                if (!std.mem.allEqual(u8, &h, 0) or token.len != 42) return error.UnsupportedFeeToken;
            }
            const Policy = @FieldType(types.GasEnforcement, "policy");
            var policy: Policy = undefined;
            if (std.mem.eql(u8, kind, "none")) policy = .none else if (std.mem.eql(u8, kind, "minimum")) {
                if (p.get("payment")) |payment| policy = .{ .minimum = try payment.int(u256) } else continue;
            } else if (std.mem.eql(u8, kind, "onChainFeeQuoting")) {
                const fraction = try p.str("gasfraction", "1/2");
                var clean: std.array_list.Managed(u8) = .init(a);
                for (fraction) |c| {
                    if (c != ' ') try clean.append(c);
                }
                const slash = std.mem.indexOfScalar(u8, clean.items, '/') orelse return error.InvalidGasFraction;
                policy = .{ .on_chain_fee_quoting = .{ .numerator = try std.fmt.parseInt(u64, clean.items[0..slash], 10), .denominator = try nonzero(u64, try std.fmt.parseInt(u64, clean.items[slash + 1 ..], 10)) } };
            } else return error.InvalidGasPolicy;
            try list.append(.{ .policy = policy, .matching_list = try parseMatching(a, p.get("matchinglist")) });
        }
    }
    if (list.items.len == 0) try list.append(.{ .policy = .none, .matching_list = &.{} });
    return list.toOwnedSlice();
}
fn parseBlacklist(a: std.mem.Allocator, text: ?[]const u8) ![]const []const u8 {
    var list: std.array_list.Managed([]const u8) = .init(a);
    if (text) |t| {
        for (try trimCsv(a, t)) |part| {
            const h = if (std.mem.startsWith(u8, part, "0x")) part[2..] else part;
            if (h.len == 0) continue;
            if (h.len % 2 != 0) return error.InvalidBlacklistAddress;
            const bytes = try a.alloc(u8, h.len / 2);
            _ = try std.fmt.hexToBytes(bytes, h);
            try list.append(bytes);
        }
    }
    return list.toOwnedSlice();
}
fn parseContexts(a: std.mem.Allocator, raw: ?View) ![]const types.MetricContext {
    const v = raw orelse return &.{};
    const entries = try jsonArray(a, v);
    const out = try a.alloc(types.MetricContext, entries.len);
    for (entries, 0..) |entry, i| {
        const p: View = .{ .value = entry };
        out[i] = .{ .name = try (try p.need("name")).text(), .matching_list = try parseMatching(a, try p.need("matchinglist")) };
    }
    return out;
}
fn parseCaches(a: std.mem.Allocator, raw: ?View) ![]const types.IsmCache {
    const v = raw orelse return &.{};
    const entries = try jsonArray(a, v);
    const out = try a.alloc(types.IsmCache, entries.len);
    for (entries, 0..) |entry, i| {
        const p: View = .{ .value = entry };
        const selector = try p.need("selector");
        const kind = try (try selector.need("type")).text();
        const mt = try (try p.need("moduletypes")).array(a);
        const mods = try a.alloc(u8, mt.len);
        for (mt, 0..) |m, j| {
            mods[j] = try (View{ .value = m }).int(u8);
            if (mods[j] > 13) return error.InvalidModuleType;
        }
        var names: ?[]const []const u8 = null;
        if (p.get("chains")) |ch| {
            const ca = try ch.array(a);
            const ns = try a.alloc([]const u8, ca.len);
            for (ca, 0..) |n, j| ns[j] = try (View{ .value = n }).text();
            names = ns;
        }
        const cp = try p.str("cachepolicy", "messageSpecific");
        out[i] = .{ .selector = if (std.mem.eql(u8, kind, "defaultIsm")) .default_ism else if (std.mem.eql(u8, kind, "appContext")) .{ .app_context = try (try selector.need("context")).text() } else return error.InvalidCacheSelector, .module_types = mods, .chains = names, .cache_policy = if (std.mem.eql(u8, cp, "messageSpecific")) .message_specific else if (std.mem.eql(u8, cp, "ismSpecific")) .ism_specific else return error.InvalidCachePolicy };
    }
    return out;
}
fn parseCcr(a: std.mem.Allocator, v: View) ![]const types.CcrRouter {
    const raw = v.get("ccrrouters") orelse return &.{};
    if (raw.value != .object) return error.InvalidCcrRouters;
    var list: std.array_list.Managed(types.CcrRouter) = .init(a);
    var domains = raw.value.object.iterator();
    while (domains.next()) |e| {
        const domain = try std.fmt.parseInt(u32, e.key_ptr.*, 10);
        if (e.value_ptr.* != .object) return error.InvalidCcrRouters;
        var rs = e.value_ptr.object.iterator();
        while (rs.next()) |pair| {
            if (pair.key_ptr.*.len != 42) return error.InvalidConfigAddress;
            const token = try (View{ .value = pair.value_ptr.* }).text();
            if (token.len != 42) return error.InvalidConfigAddress;
            const router_h = try address(a, pair.key_ptr.*);
            const token_h = try address(a, token);
            try list.append(.{ .domain = domain, .router = router_h[12..].*, .token = token_h[12..].* });
        }
    }
    return list.toOwnedSlice();
}
fn parseOverrides(v: View) !types.TransactionOverrides {
    var result: types.TransactionOverrides = undefined;
    inline for (@typeInfo(types.TransactionOverrides).@"struct".fields) |field| {
        var buf: [128]u8 = undefined;
        var n: usize = 0;
        for (field.name) |c| {
            if (c != '_') {
                buf[n] = c;
                n += 1;
            }
        }
        @field(result, field.name) = try v.optNum(u256, buf[0..n]);
    }
    return result;
}
fn parseMev(a: std.mem.Allocator, raw: ?View, lander: bool) !@FieldType(@FieldType(types.Connection, "ethereum"), "mev_submission") {
    const v = raw orelse return null;
    if (!lander) return error.MevRequiresLander;
    const entries = try jsonArray(a, try v.need("rpcurls"));
    if (entries.len == 0) return error.EmptyRpcUrls;
    const us = try a.alloc([]const u8, entries.len);
    for (entries, 0..) |e, i| {
        us[i] = try (View{ .value = e }).text();
        const u = try std.Uri.parse(us[i]);
        if (!std.mem.eql(u8, u.scheme, "https")) return error.InvalidConfigUrl;
    }
    var additional: []const [32]u8 = &.{};
    if (v.get("additionalicarouters")) |r| {
        const es = try jsonArray(a, r);
        const routers = try a.alloc([32]u8, es.len);
        for (es, 0..) |e, i| routers[i] = try address(a, try (View{ .value = e }).text());
        additional = routers;
    }
    return .{ .rpc_urls = us, .ica_router = try addr(a, v, "icarouter"), .additional_ica_routers = additional };
}
fn optionalObject(v: View, key: []const u8) !View {
    if (v.get(key)) |x| {
        if (x.value != .object) return error.InvalidConfigObject;
        return x;
    }
    return empty();
}
fn validatorRpcs(a: std.mem.Allocator, v: View) ![]const types.Rpc {
    if (v.get("additionalquorumrpcurls") != null or v.get("customadditionalquorumrpcurls") != null) return error.RemovedQuorumRpcOption;
    var list: std.array_list.Managed(types.Rpc) = .init(a);
    for ([_]struct { base: []const u8, custom: []const u8 }{ .{ .base = "rpcurls", .custom = "customrpcurls" }, .{ .base = "grpcurls", .custom = "customgrpcurls" }, .{ .base = "walleturls", .custom = "customwalleturls" }, .{ .base = "walletsolidityurls", .custom = "customwalletsolidityurls" } }) |keys| {
        if (try v.optional(keys.custom)) |text| {
            for (try trimCsv(a, text)) |u| try list.append(.{ .url = u, .public = false });
        } else if (v.get(keys.base)) |raw| {
            for (try raw.array(a)) |entry| {
                const p: View = .{ .value = entry };
                try list.append(.{ .url = try (try p.need("http")).text(), .public = try p.flag("public", false) });
            }
        }
    }
    return list.toOwnedSlice();
}
fn pubkey(a: std.mem.Allocator, s: []const u8) ![32]u8 {
    const bytes = try @import("../altvm/base58.zig").decode(a, s);
    if (bytes.len != 32) return error.InvalidConfigPubkey;
    return bytes[0..32].*;
}
fn alts(a: std.mem.Allocator, v: View, plural: []const u8, singular: []const u8) ![]const [32]u8 {
    if (v.get(plural)) |raw| {
        if (raw.value != .array and raw.value != .string) return error.InvalidConfigArray;
        const entries = try jsonArray(a, raw);
        if (entries.len == 0) return error.EmptyLookupTables;
        const out = try a.alloc([32]u8, entries.len);
        for (entries, 0..) |e, i| out[i] = try pubkey(a, try (View{ .value = e }).text());
        return out;
    }
    if (try v.optional(singular)) |s| {
        const out = try a.alloc([32]u8, 1);
        out[0] = try pubkey(a, s);
        return out;
    }
    return &.{};
}
fn parseSealevel(a: std.mem.Allocator, v: View, token: View) !@FieldType(types.Connection, "sealevel") {
    const version = try v.num(u8, "maxsupportedtransactionversion", 0);
    if (version > 1) return error.InvalidTransactionVersion;
    const tx = try optionalObject(v, "transactionsubmitter");
    const kind = try tx.str("type", "rpc");
    const S = @FieldType(types.Connection, "sealevel");
    const Oracle = @FieldType(S, "priority_fee_oracle");
    var oracle: Oracle = .{ .constant = 0 };
    if (v.get("priorityfeeoracle")) |o| {
        const ot = try (try o.need("type")).text();
        if (std.mem.eql(u8, ot, "constant")) oracle = .{ .constant = try (try o.need("fee")).int(u64) } else if (std.mem.eql(u8, ot, "helius")) {
            const url = try (try o.need("url")).text();
            try uri(url, false);
            const level = try o.str("feelevel", "recommended");
            var found = false;
            for ([_][]const u8{ "recommended", "min", "low", "medium", "high", "veryhigh", "unsafemax" }) |l| {
                if (std.ascii.eqlIgnoreCase(level, l)) found = true;
            }
            if (!found) return error.InvalidPriorityFeeLevel;
            oracle = .{ .helius = .{ .url = url, .fee_level = try std.ascii.allocLowerString(a, level) } };
        } else return error.InvalidPriorityFeeOracle;
    }
    const Override = std.meta.Child(@FieldType(S, "process_alt_overrides"));
    var overrides: std.array_list.Managed(Override) = .init(a);
    if (v.get("processaltoverrides")) |raw| {
        for (try jsonArray(a, raw)) |e| {
            const p: View = .{ .value = e };
            const addresses = try alts(a, p, "altaddresses", "altaddress");
            if (addresses.len == 0) return error.EmptyLookupTables;
            try overrides.append(.{ .matching_list = try parseMatching(a, p.get("matchinglist")), .alt_addresses = addresses });
        }
    }
    var reveal: @FieldType(S, "ur_reveal") = null;
    if (v.get("urreveal")) |r| {
        const ccs = try r.optional("ccsurl");
        const program = try r.optional("programid");
        if (ccs != null and program != null) {
            const u = try std.Uri.parse(ccs.?);
            if (!std.mem.eql(u8, u.scheme, "https") or u.user != null or u.password != null or u.query != null or u.fragment != null) return error.InvalidCcsUrl;
            reveal = .{ .ccs_url = ccs.?, .program_id = try pubkey(a, program.?) };
        } else if (ccs != null or program != null) return error.IncompleteReveal;
    }
    return .{ .max_supported_transaction_version = version, .transaction_submitter = if (std.ascii.eqlIgnoreCase(kind, "rpc")) .rpc else if (std.ascii.eqlIgnoreCase(kind, "jito")) .jito else return error.InvalidTransactionSubmitter, .transaction_submitter_urls = if (try tx.optional("urls")) |s| try csv(a, s) else &.{}, .priority_fee = if (oracle == .constant) oracle.constant else 0, .priority_fee_oracle = oracle, .mailbox_process_alts = try alts(a, v, "mailboxprocessalts", "mailboxprocessalt"), .process_alt_overrides = try overrides.toOwnedSlice(), .ur_reveal = reveal, .native_token_decimals = try token.num(u32, "decimals", 9) };
}
