//! Owned concrete chain clients shared by scraper/relayer/validator factories.
//! One instance per retained worker/lane. No network during open; source() runs
//! lazy identity checks. Settings/env and optional injected exchange are borrowed.
const std = @import("std");
const settings = @import("../settings/root.zig");
const types = @import("../settings/types.zig");
const Curl = @import("../net/curl.zig");
const http = @import("../cloud/http.zig");
const rpc = @import("../evm/provider.zig");
const RpcPool = @import("../evm/pool.zig");
const endpoint = @import("../net/endpoint.zig");
const source_factory = @import("scraper/factory.zig");
const receipt_factory = @import("scraper/receipt_factory.zig");
const src = @import("scraper/source.zig");
const grpc = @import("../cosmos/grpc.zig");
const GrpcCurl = @import("../cosmos/curl_grpc.zig").CurlTransport;
const GrpcFallback = @import("../cosmos/fallback_grpc.zig");
const A = std.mem.Allocator;
pub const HttpReplay = @import("../net/http_replay.zig");
pub const HttpRuntime = @import("../net/http_runtime.zig");
pub const ReadReplay = @import("../net/read_replay.zig");
pub const RpcMetrics = @import("../ops/rpc_metrics.zig");
pub const Options = struct {
    curl_library: []const u8,
    request_timeout_ms: u32 = 20000,
    allow_insecure_loopback: bool = false,
    rpc_urls: ?[]const []const u8 = null,
    grpc_urls: ?[]const []const u8 = null,
    wallet_solidity_urls: ?[]const []const u8 = null,
    exchange: ?rpc.Exchange = null,
    /// Independent validator read-vote replay captures native sends directly.
    direct_native_transport: bool = false,
    /// Read-only chain lanes; caller brackets retained callback passes and
    /// commits explicit pure-read sections at durable controller boundaries.
    cooperative_reads: bool = false,
    read_attempt_timeout_ms: u32 = 120000,
    http_runtime: ?*HttpRuntime.Runtime = null,
    read_budget: ?*ReadReplay.ByteBudget = null,
    metrics: ?*@import("../ops/metrics.zig").Registry = null,
    rpc_role: RpcMetrics.Role = .primary,
    operation: RpcMetrics.Operation = .unattributed,
    indexer_tip_cache: bool = false,
    dynamic_tip_cache: ?*@import("../net/dynamic_tip_cache.zig").Cache = null,
    /// Total sessions, including cancelled native retirement; max128.
    rpc_parallelism: u16 = 2,
    borrowed_rpc_pool: ?*RpcPool.Pool = null,
    borrowed_grpc_health: ?*GrpcFallback.Health = null,
    rpc_max_response_bytes: usize = 8 * 1024 * 1024,
    rpc_max_reserved_bytes: ?usize = null,
};
pub const Resources = struct {
    allocator: A,
    arena: std.heap.ArenaAllocator,
    chain: types.Chain,
    options: Options,
    environment: *const std.process.EnvMap,
    owned_environment: ?*std.process.EnvMap = null,
    native: Curl.Client = undefined,
    native_ready: bool = false,
    rpc_metrics: ?*RpcMetrics.Recorder = null,
    http: http.HttpTransport,
    clients: source_factory.Clients = undefined,
    rpc_pool: ?*RpcPool.Pool = null,
    rpc_pool_owned: bool = false,
    /// Actual enclosing direct RPC owner deadline, bound and restored by its scope.
    /// A read-attempt configuration value alone does not establish this clock.
    rpc_deadline_ns: ?u64 = null,
    read_replay: ?*ReadReplay.Replay = null,
    http_replay: ?*HttpReplay.Replay = null,
    rpc_client: ?rpc.RpcClient = null,
    svm_client: ?@import("../sealevel/provider.zig").Client = null,
    tron_client: ?@import("../tron/provider.zig").Provider = null,
    starknet_factory: ?@import("scraper/starknet.zig").Factory = null,
    aleo_factory: ?@import("scraper/aleo.zig").Factory = null,
    aleo_crypto: ?@import("../aleo/crypto.zig").Crypto = null,
    grpc_clients: []GrpcCurl = &.{},
    grpc_initialized: usize = 0,
    grpc_health: ?*GrpcFallback.Health = null,
    grpc_health_owned: bool = false,
    grpc_fallback: ?GrpcFallback.Client = null,
    endpoints_owned: std.ArrayList(endpoint.OwnedEndpoint) = .empty,
    factory: ?*source_factory.Factory = null,
    receipt_binding: ?*receipt_factory.Factory = null,
    source_cache: ?src.Source = null,
    cancel: ?*const std.atomic.Value(bool) = null,
    receipt_identity_checked: bool = false,
    owned_provider_metrics: usize = 0,
    pub fn open(a: A, chain: *const types.Chain, env: *const std.process.EnvMap, options: Options) !*Resources {
        if (options.indexer_tip_cache and chain.protocol == .ethereum and options.dynamic_tip_cache == null) return error.SharedDynamicTipCacheRequired;
        if (options.borrowed_rpc_pool != null and (options.direct_native_transport or options.exchange != null)) return error.InvalidBorrowedRpcPool;
        if (options.cooperative_reads and (options.direct_native_transport or options.exchange != null)) return error.UnsupportedCooperativeSource;
        if (options.rpc_parallelism == 0 or options.rpc_parallelism > 128) return error.InvalidRpcParallelism;
        if (options.request_timeout_ms == 0 or options.request_timeout_ms > 300000) return error.InvalidChainSourceTimeout;
        const fallback_budget = !options.direct_native_transport and options.exchange == null and switch (chain.protocol) {
            .cosmos, .cosmosnative, .sealevel => true,
            .ethereum => chain.connection == .ethereum and chain.connection.ethereum.consensus == .fallback,
            else => false,
        };
        if (fallback_budget and (options.read_attempt_timeout_ms == 0 or options.read_attempt_timeout_ms > 300000)) return error.InvalidReadReplayLimit;
        const self = try a.create(Resources);
        self.* = .{ .allocator = a, .arena = std.heap.ArenaAllocator.init(a), .chain = chain.*, .options = options, .environment = env, .http = http.HttpTransport.init(a) };
        errdefer self.deinit();
        if (options.rpc_urls) |urls| self.chain.rpc_urls = urls;
        if (options.grpc_urls) |urls| self.chain.grpc_urls = urls;
        if (self.chain.rpc_urls.len == 0 or self.chain.rpc_urls.len > 256) return error.InvalidChainSourceEndpoints;
        if (options.metrics) |registry| {
            self.rpc_metrics = try RpcMetrics.Recorder.init(a, registry, .{ .chain = self.chain.name, .role = options.rpc_role, .operation = options.operation, .protocol = switch (self.chain.protocol) {
                .radix => .radix,
                .tron => .tron,
                .aleo => .aleo,
                .ethereum => .ethereum_json_rpc,
                else => .json_rpc,
            } });
            const recorder = self.rpc_metrics.?;
            try recorder.addEndpoints(self.chain.rpc_urls);
            try recorder.addEndpoints(self.chain.grpc_urls);
            switch (self.chain.connection) {
                .radix => |c| try recorder.addEndpoints(c.gateway_urls),
                .tron => |c| {
                    try recorder.addEndpoints(c.wallet_urls);
                    try recorder.addEndpoints(options.wallet_solidity_urls orelse c.wallet_solidity_urls);
                },
                else => {},
            }
        }
        self.native = try Curl.Client.init(a, options.curl_library);
        self.native_ready = true;
        if (options.cooperative_reads) {
            if (options.http_runtime) |owner| {
                const replay = try a.create(HttpReplay.Replay);
                errdefer a.destroy(replay);
                replay.* = try HttpReplay.Replay.init(a, owner, .{ .max_attempt_ms = options.read_attempt_timeout_ms, .shared_budget = options.read_budget, .recorder = self.rpc_metrics });
                self.http_replay = replay;
                self.native.send_override = replay.override();
            } else if (chain.protocol != .ethereum and chain.protocol != .sealevel) return error.SharedHttpRuntimeRequired;
        }
        if (self.rpc_metrics) |recorder| self.native.observer = recorder.nativeObserver();
        self.http.native_curl = &self.native;
        self.http.timeout_ms = options.request_timeout_ms;
        self.http.connect_timeout_ms = @min(5000, options.request_timeout_ms);
        self.http.allow_insecure_loopback = options.allow_insecure_loopback;
        var r_options: rpc.Options = .{ .indexer_tip_cache = options.indexer_tip_cache and self.chain.protocol == .ethereum, .dynamic_tip_cache = options.dynamic_tip_cache, .native_cache_observer = if (self.rpc_metrics) |recorder| recorder.nativeCacheObserver() else null, .pool_observer = if (self.rpc_metrics) |recorder| recorder.poolObserver() else null, .read_budget = options.read_budget, .native_transport = &self.native, .timeout_ms = options.request_timeout_ms, .max_response_bytes = options.rpc_max_response_bytes, .max_log_range = @max(2000, @as(u64, self.chain.index.chunk) + 1), .exchange = options.exchange };
        r_options.protocol = switch (self.chain.protocol) {
            .sealevel => .sealevel,
            .cosmos, .cosmosnative => .tendermint,
            else => .ethereum,
        };
        if (!options.direct_native_transport and options.exchange == null and (self.chain.protocol == .ethereum or self.chain.protocol == .sealevel or self.chain.protocol == .cosmos or self.chain.protocol == .cosmosnative)) {
            var strategy: RpcPool.Strategy = .{ .fallback = .{} };
            var urls = self.chain.rpc_urls;
            if (self.chain.protocol == .ethereum) {
                if (self.chain.connection != .ethereum) return error.WrongChainConnection;
                const ec = self.chain.connection.ethereum;
                strategy = switch (ec.consensus) {
                    .single => .{ .single = .{} },
                    .fallback => .{ .fallback = .{ .consider_null_transaction_receipt = ec.consider_null_transaction_receipt, .hedge = if (ec.fallback_hedge_delay_ms) |delay| .{ .delay_ms = std.math.cast(u32, delay) orelse return error.InvalidHedgeTimeout, .attempt_timeout_ms = std.math.cast(u32, ec.fallback_hedge_timeout_ms orelse options.request_timeout_ms) orelse return error.InvalidHedgeTimeout } else null } },
                    .quorum => .{ .quorum = .{} },
                };
                if (ec.consensus == .single) urls = urls[0..1];
            }
            const owner_fallback = strategy == .fallback;
            if (owner_fallback) strategy.fallback.attempt_timeout_ms = options.request_timeout_ms;
            const per_request = try (@import("../net/curl_multi.zig").Config{ .library_path = options.curl_library, .max_response_bytes = options.rpc_max_response_bytes, .max_request_bytes = 1024 * 1024 }).maxReservationPerRequest();
            // Every configured peer remains in the denominator. Session slots
            // include cancelled native retirement; probes share bounded slots.
            const physical = try std.math.mul(usize, urls.len, options.rpc_parallelism);
            const pending = @max(32, try std.math.mul(usize, urls.len, @as(usize, options.rpc_parallelism) + 1));
            if (pending > 4096) return error.RpcParallelFanoutLimit;
            const budget = options.rpc_max_reserved_bytes orelse try std.math.mul(usize, per_request, physical);
            if (self.rpc_metrics) |recorder| try recorder.configurePool(urls);
            const height_protocol: RpcPool.HeightProtocol = switch (self.chain.protocol) {
                .sealevel => .sealevel,
                .cosmos, .cosmosnative => .tendermint,
                else => .ethereum,
            };
            if (options.borrowed_rpc_pool) |borrowed| {
                if (borrowed.config.height_protocol != height_protocol) return error.BorrowedRpcProtocolMismatch;
                if (owner_fallback and (borrowed.config.strategy != .fallback or borrowed.config.strategy.fallback.attempt_timeout_ms != options.request_timeout_ms)) return error.BorrowedRpcTimeoutMismatch;
                if (options.indexer_tip_cache and borrowed.config.dynamic_tip_cache != options.dynamic_tip_cache) return error.BorrowedTipCacheMismatch;
                if (!try borrowed.matchesEndpoints(a, urls)) return error.BorrowedRpcEndpointMismatch;
                self.rpc_pool = borrowed;
            } else {
                self.rpc_pool = try RpcPool.Pool.start(a, .{ .library_path = options.curl_library, .urls = urls, .strategy = strategy, .height_protocol = height_protocol, .dynamic_tip_cache = options.dynamic_tip_cache, .observer = if (self.rpc_metrics) |recorder| recorder.poolObserver() else null, .max_response_bytes = options.rpc_max_response_bytes, .max_reserved_bytes = budget, .max_sessions = options.rpc_parallelism, .max_concurrent = @intCast(@max(1, physical)), .max_pending = @intCast(pending) });
                self.rpc_pool_owned = true;
            }
            r_options.async_pool = self.rpc_pool;
            if (options.cooperative_reads) {
                const replay = try a.create(ReadReplay.Replay);
                errdefer a.destroy(replay);
                replay.* = try ReadReplay.Replay.init(a, self.rpc_pool.?, .{ .max_attempt_ms = options.read_attempt_timeout_ms, .shared_budget = options.read_budget, .use_owner_timeout = owner_fallback });
                self.read_replay = replay;
                r_options.exchange = replay.interface();
            } else r_options.exchange = if (owner_fallback) .{ .context = self, .fetch_fn = fallbackExchange } else .{ .context = self.rpc_pool.?, .fetch_fn = exchange };
        }
        self.clients = switch (self.chain.protocol) {
            .ethereum => blk: {
                if (self.chain.connection != .ethereum) return error.WrongChainConnection;
                self.rpc_client = try rpc.RpcClient.init(a, self.chain.rpc_urls[0], r_options);
                break :blk .{ .ethereum = &self.rpc_client.? };
            },
            .sealevel => blk: {
                self.svm_client = try @import("../sealevel/provider.zig").Client.init(a, self.chain.rpc_urls[0], r_options);
                break :blk .{ .sealevel = &self.svm_client.? };
            },
            .cosmos, .cosmosnative => blk: {
                const cc = switch (self.chain.connection) {
                    .cosmos => |c| c,
                    .cosmosnative => |c| c,
                    else => return error.WrongChainConnection,
                };
                self.rpc_client = try rpc.RpcClient.init(a, self.chain.rpc_urls[0], r_options);
                if (self.chain.grpc_urls.len == 0 or self.chain.grpc_urls.len > 64) return error.InvalidGrpcEndpoints;
                self.grpc_clients = try self.arena.allocator().alloc(GrpcCurl, self.chain.grpc_urls.len);
                for (self.chain.grpc_urls, self.grpc_clients) |url, *client| {
                    const normalized = (try self.endpoints(&.{url}))[0];
                    client.* = try GrpcCurl.init(a, normalized.url, options.curl_library);
                    self.grpc_initialized += 1;
                    if (self.http_replay) |replay| client.client.send_override = replay.override();
                    if (self.rpc_metrics) |recorder| client.client.observer = recorder.nativeObserver();
                    const headers = try self.arena.allocator().alloc(Curl.Header, normalized.headers.len);
                    for (normalized.headers, headers) |from, *to| to.* = .{ .name = from.name, .value = from.value };
                    client.headers = headers;
                }
                if (options.borrowed_grpc_health) |health| {
                    if (health.priorities.len != self.grpc_clients.len) return error.BorrowedGrpcEndpointsMismatch;
                    self.grpc_health = health;
                } else {
                    const health = try a.create(GrpcFallback.Health);
                    errdefer a.destroy(health);
                    health.* = try GrpcFallback.Health.init(a, self.grpc_clients.len, null);
                    self.grpc_health = health;
                    self.grpc_health_owned = true;
                }
                self.grpc_fallback = try GrpcFallback.Client.init(a, self.grpc_health.?, .{ .context = self, .call_fn = grpcRaw }, .{ .cooperative = options.cooperative_reads, .runtime = options.http_runtime, .budget = options.read_budget, .recorder = self.rpc_metrics, .max_attempt_ms = options.read_attempt_timeout_ms });
                const conf: @import("../cosmos/config.zig").Config = .{ .chain_id = cc.chain_id, .bech32_prefix = cc.bech32_prefix, .canonical_asset = cc.canonical_asset, .contract_address_bytes = std.math.cast(u8, cc.contract_address_bytes) orelse return error.InvalidContractAddressBytes, .gas_price = try @import("../cosmos/config.zig").Decimal.parse(cc.gas_price.amount), .gas_multiplier = cc.gas_multiplier, .confirmations = self.chain.confirmations };
                try conf.validate();
                const compat: @import("../cosmos/tendermint.zig").Compat = if (cc.compat_mode) |mode| if (std.mem.eql(u8, mode, "0.34")) .v034 else if (std.mem.eql(u8, mode, "0.37")) .v037 else if (std.mem.eql(u8, mode, "0.38")) .v038 else return error.InvalidCosmosCompatMode else .v037;
                break :blk .{ .cosmos = .{ .tendermint = .{ .rpc_client = &self.rpc_client.?, .chain_id = cc.chain_id, .compat = compat }, .queries = .{ .allocator = a, .transport = .{ .context = self, .call_fn = grpcCall }, .config = conf, .domain = self.chain.domain, .timeout_ms = options.request_timeout_ms } } };
            },
            .radix => blk: {
                if (self.chain.connection != .radix) return error.WrongChainConnection;
                const conf = self.chain.connection.radix;
                if (conf.gateway_urls.len == 0) return error.EmptyRadixGateway;
                const network: @import("../radix/address.zig").Network = if (std.mem.eql(u8, conf.network_name, "mainnet")) .mainnet else if (std.mem.eql(u8, conf.network_name, "stokenet")) .stokenet else if (std.mem.eql(u8, conf.network_name, "localnet")) .localnet else if (std.mem.eql(u8, conf.network_name, "simulator")) .simulator else return error.UnsupportedRadixNetwork;
                const normalized_core = try self.endpoints(self.chain.rpc_urls);
                const normalized_gateway = try self.endpoints(conf.gateway_urls);
                const REndpoint = @import("../radix/provider.zig").Endpoint;
                const cores = try self.arena.allocator().alloc(REndpoint, normalized_core.len);
                const gateways = try self.arena.allocator().alloc(REndpoint, normalized_gateway.len);
                for (cores, normalized_core) |*to, from| to.* = .{ .url = from.url, .headers = from.headers };
                for (gateways, normalized_gateway) |*to, from| to.* = .{ .url = from.url, .headers = from.headers };
                const core = cores[0];
                const gateway = gateways[0];
                break :blk .{ .radix = .{ .allocator = a, .transport = self.http.configuredRpcInterface(), .core = .{ .url = core.url, .headers = core.headers }, .gateway = .{ .url = gateway.url, .headers = gateway.headers }, .network = network, .confirmations = self.chain.confirmations, .core_endpoints = cores, .gateway_endpoints = gateways } };
            },
            .tron => blk: {
                if (self.chain.connection != .tron) return error.WrongChainConnection;
                const conf = self.chain.connection.tron;
                self.tron_client = try @import("../tron/provider.zig").Provider.init(a, self.http.configuredRpcInterface(), .{ .rpc_urls = try self.endpoints(self.chain.rpc_urls), .wallet_urls = try self.endpoints(conf.wallet_urls), .wallet_solidity_urls = try self.endpoints(options.wallet_solidity_urls orelse conf.wallet_solidity_urls) });
                break :blk .{ .tron = &self.tron_client.? };
            },
            .starknet => blk: {
                self.starknet_factory = try @import("scraper/starknet.zig").Factory.init(a, self.http.configuredRpcInterface(), &self.chain);
                break :blk .{ .starknet = &self.starknet_factory.? };
            },
            .aleo => blk: {
                const library = env.get("HYPERLANE_ALEO_CRYPTO_LIBRARY") orelse return error.MissingAleoCryptoLibrary;
                const vm = env.get("HYPERLANE_ALEO_VM_LIBRARY") orelse return error.MissingAleoVmLibrary;
                const worker = env.get("HYPERLANE_ALEO_VM_WORKER") orelse return error.MissingAleoVmWorker;
                self.aleo_crypto = try @import("../aleo/crypto.zig").Crypto.init(library);
                self.aleo_factory = try @import("scraper/aleo.zig").Factory.init(a, self.http.configuredRpcInterface(), &self.aleo_crypto.?, &self.chain, .{ .executable = worker, .library = vm });
                break :blk .{ .aleo = &self.aleo_factory.? };
            },
        };
        // Counters follow actual owned endpoint wrappers. Borrowed Pool forks
        // do not fabricate transports/Clone counts; Radix has no Source producer.
        self.owned_provider_metrics = switch (self.chain.protocol) {
            .ethereum, .sealevel => if (self.rpc_pool == null) 1 else 0,
            .cosmos, .cosmosnative => self.grpc_initialized + @as(usize, if (self.rpc_pool == null) 1 else 0),
            .tron => self.chain.rpc_urls.len + self.chain.connection.tron.wallet_urls.len + (options.wallet_solidity_urls orelse self.chain.connection.tron.wallet_solidity_urls).len,
            .starknet, .aleo => self.chain.rpc_urls.len,
            .radix => 0,
        };
        if (self.rpc_metrics) |recorder| recorder.providerCreated(self.owned_provider_metrics);
        return self;
    }
    /// Metadata-only read fork. Parent/global Runtime and parent RPC Pool must
    /// outlive all forks. Owns typed clients/IDs, headers, replay journals and
    /// operation attribution; no new RPC Pool, I/O thread, signer or key read.
    pub fn forkRead(self: *Resources, a: A) !*Resources {
        return self.forkReadFor(a, .relayer_metadata);
    }
    pub fn forkReadFor(self: *Resources, a: A, operation: RpcMetrics.Operation) !*Resources {
        const rpc_protocol = self.chain.protocol == .ethereum or self.chain.protocol == .sealevel or self.chain.protocol == .cosmos or self.chain.protocol == .cosmosnative;
        if (rpc_protocol and self.rpc_pool == null) return error.SharedRpcPoolRequired;
        if (self.options.http_runtime == null and self.chain.protocol != .ethereum and self.chain.protocol != .sealevel) return error.SharedHttpRuntimeRequired;
        const env = try a.create(std.process.EnvMap);
        errdefer a.destroy(env);
        env.* = std.process.EnvMap.init(a);
        errdefer env.deinit();
        inline for (.{ "HYPERLANE_ALEO_CRYPTO_LIBRARY", "HYPERLANE_ALEO_VM_LIBRARY", "HYPERLANE_ALEO_VM_WORKER" }) |key| if (self.environment.get(key)) |value| try env.put(key, value);
        var chain = self.chain;
        chain.signer = null;
        chain.identity = null;
        chain.ccs_signer = null;
        var options = self.options;
        options.borrowed_rpc_pool = self.rpc_pool;
        options.borrowed_grpc_health = self.grpc_health;
        options.direct_native_transport = false;
        options.cooperative_reads = true;
        options.exchange = null;
        options.operation = operation;
        options.indexer_tip_cache = false;
        options.rpc_urls = null;
        options.grpc_urls = null;
        // Pool accepts metadata's normal32KiB cap and separately scoped larger
        // CCIP responses; its own configured upper wire bound remains unchanged.
        const child = try Resources.open(a, &chain, env, options);
        child.owned_environment = env;
        if (operation == .relayer_metadata and child.chain.protocol == .ethereum) if (child.rpc_client) |*client| {
            client.options.max_response_bytes = @min(32768, client.options.max_response_bytes);
        };
        return child;
    }
    fn exchange(context: *anyopaque, a: A, body: []const u8, options: rpc.Options) !rpc.WireResponse {
        const pool: *RpcPool.Pool = @ptrCast(@alignCast(context));
        const result = try pool.fetchObservedCached(a, body, options.timeout_ms, options.connect_timeout_ms, options.cancel, options.max_response_bytes, options.pool_observer, options.indexer_tip_cache);
        return .{ .bytes = result.bytes, .len = result.len };
    }
    /// One bounded session spans endpoint attempts; the Pool separately caps
    /// each physical request. Explicit caller clocks can only reduce this budget.
    fn fallbackRpcBudget(self: *const Resources, caller_deadline_ns: ?u64) !u32 {
        if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        var timeout = self.options.read_attempt_timeout_ms;
        if (timeout == 0 or timeout > 300000) return error.InvalidReadReplayLimit;
        for ([_]?u64{ self.rpc_deadline_ns, caller_deadline_ns }) |optional| if (optional) |deadline| {
            const remaining = try (http.RpcReadOwner{ .deadline_ns = deadline }).remaining(self.cancel);
            timeout = @min(timeout, @as(u32, @intCast(@min(std.math.maxInt(u32), (remaining +| (std.time.ns_per_ms - 1)) / std.time.ns_per_ms))));
        };
        if (self.http.rpc_read_owner) |owner| {
            const remaining = try owner.remaining(self.cancel);
            timeout = @min(timeout, @as(u32, @intCast(@min(std.math.maxInt(u32), (remaining +| (std.time.ns_per_ms - 1)) / std.time.ns_per_ms))));
        }
        return timeout;
    }
    fn fallbackExchange(context: *anyopaque, a: A, body: []const u8, options: rpc.Options) !rpc.WireResponse {
        const self: *Resources = @ptrCast(@alignCast(context));
        if (options.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        const result = try self.rpc_pool.?.fetchObservedCached(a, body, try self.fallbackRpcBudget(options.owner_deadline_ns), options.connect_timeout_ms, options.cancel, options.max_response_bytes, options.pool_observer, options.indexer_tip_cache);
        errdefer a.free(result.bytes);
        _ = try self.fallbackRpcBudget(options.owner_deadline_ns);
        if (options.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        return .{ .bytes = result.bytes, .len = result.len };
    }
    fn endpoints(self: *Resources, urls: []const []const u8) ![]endpoint.Endpoint {
        if (urls.len == 0 or urls.len > 256) return error.InvalidChainSourceEndpoints;
        const list = try self.arena.allocator().alloc(endpoint.Endpoint, urls.len);
        for (urls, list) |url, *out| {
            var owned = try endpoint.OwnedEndpoint.parse(self.allocator, url);
            errdefer owned.deinit();
            try self.endpoints_owned.append(self.allocator, owned);
            out.* = owned.endpoint;
        }
        return list;
    }
    fn grpcCall(context: *anyopaque, a: A, requested: grpc.Request) !grpc.Response {
        const self: *Resources = @ptrCast(@alignCast(context));
        var request = requested;
        if (request.cancel == null) request.cancel = self.cancel;
        return self.grpc_fallback.?.call(a, request);
    }
    fn grpcRaw(context: *anyopaque, a: A, index: usize, request: grpc.Request, journal: ?*HttpReplay.Replay) !grpc.Response {
        const self: *Resources = @ptrCast(@alignCast(context));
        const client = &self.grpc_clients[index];
        const saved = client.client.send_override;
        defer client.client.send_override = saved;
        if (journal) |replay| client.client.send_override = replay.override();
        return client.interface().call(a, request);
    }
    pub fn source(self: *Resources) !src.Source {
        if (self.factory == null) self.factory = try source_factory.Factory.init(self.allocator, self.clients, &self.chain);
        if (self.source_cache == null) {
            self.source_cache = try self.factory.?.interface();
            if (self.options.cooperative_reads) self.source_cache.?.read_section = .{ .context = self, .commit_fn = sourceCommit, .reservation = if (self.options.read_budget) |budget| .{ .context = budget, .reserve_fn = sourceReserve, .release_fn = sourceRelease } else null };
        }
        self.source_cache.?.bindCancellation(self.cancel);
        return self.source_cache.?;
    }
    pub fn receipts(self: *Resources) !@import("scraper/enrichment.zig").Fetcher {
        if (!self.receipt_identity_checked) {
            if (self.clients == .ethereum) try self.clients.ethereum.checkChain(try std.fmt.parseInt(u256, self.chain.chain_id, if (std.mem.startsWith(u8, self.chain.chain_id, "0x")) 0 else 10));
            self.receipt_identity_checked = true;
        }
        if (self.receipt_binding == null) {
            const clients: receipt_factory.Clients = switch (self.clients) {
                .ethereum => |client| .{ .ethereum = client },
                .sealevel => |client| .{ .sealevel = client },
                .cosmos => |client| .{ .cosmos = client.tendermint },
                .radix => |client| .{ .radix = .{ .client = client, .http_owner = &self.http } },
                .tron => |client| .{ .tron = .{ .provider = client, .http_owner = &self.http } },
                .starknet => |client| .{ .starknet = .{ .provider = &client.provider, .http_owner = &self.http } },
                .aleo => |client| .{ .aleo = .{ .provider = &client.provider, .decoder = client.decoder, .http_owner = &self.http } },
            };
            self.receipt_binding = try receipt_factory.Factory.init(self.allocator, clients, &self.chain, .{});
        }
        return self.receipt_binding.?.interface();
    }
    /// Validator vote replay only: route every concrete reader through the
    /// independently owned cache while Multi fetches misses concurrently.
    /// Never attach this resource to signing, submission, or CCIP jobs.
    pub fn setReadOnlyOverride(self: *Resources, override: ?Curl.SendOverride) void {
        self.native.send_override = override;
        for (self.grpc_clients) |*client| client.client.send_override = override;
        const exchange_ = if (override != null) null else if (self.rpc_pool) |owned| rpc.Exchange{ .context = owned, .fetch_fn = exchange } else self.options.exchange;
        if (self.rpc_client) |*client| client.options.exchange = exchange_;
        if (self.svm_client) |*client| client.rpc_client.options.exchange = exchange_;
    }
    fn sourceCommit(context: *anyopaque) !void {
        const self: *Resources = @ptrCast(@alignCast(context));
        try self.commitReadSection();
    }
    fn sourceReserve(context: *anyopaque, bytes: usize) !void {
        const budget: *ReadReplay.ByteBudget = @ptrCast(@alignCast(context));
        try budget.reserve(bytes);
    }
    fn sourceRelease(context: *anyopaque, bytes: usize) void {
        const budget: *ReadReplay.ByteBudget = @ptrCast(@alignCast(context));
        budget.release(bytes);
    }
    pub fn beginReadPass(self: *Resources, cancel: ?*const std.atomic.Value(bool)) !void {
        if (self.read_replay) |replay| replay.beginPass(cancel) catch |err| {
            if (self.http_replay) |http_replay| http_replay.reset();
            if (self.grpc_fallback) |*fallback| fallback.endPass(err);
            return err;
        };
        if (self.http_replay) |replay| replay.beginPass(cancel, if (self.read_replay) |rpc_replay| rpc_replay.started else null) catch |err| {
            if (self.read_replay) |rpc_replay| rpc_replay.reset();
            if (self.grpc_fallback) |*fallback| fallback.endPass(err);
            return err;
        };
        if (self.grpc_fallback) |*fallback| if (self.options.cooperative_reads) fallback.beginPass(cancel, if (self.http_replay) |replay| replay.started else null) catch |err| {
            if (self.read_replay) |replay| replay.reset();
            if (self.http_replay) |replay| replay.reset();
            return err;
        };
        self.setCancellation(cancel);
    }
    pub fn endReadPass(self: *Resources, failure: ?anyerror) void {
        self.setCancellation(null);
        if (self.grpc_fallback) |*fallback| if (self.options.cooperative_reads) fallback.endPass(failure);
        if (self.read_replay) |replay| replay.endPass(failure);
        if (self.http_replay) |replay| replay.endPass(failure);
    }
    pub fn commitReadSection(self: *Resources) !void {
        if (self.grpc_fallback) |*fallback| if (fallback.hasPending()) return error.PendingReadSection;
        if (self.read_replay) |replay| if (replay.hasPending()) return error.PendingReadSection;
        if (self.http_replay) |replay| if (replay.hasPending()) return error.PendingReadSection;
        if (self.grpc_fallback) |*fallback| try fallback.commitReadSection();
        if (self.read_replay) |replay| try replay.commitReadSection();
        if (self.http_replay) |replay| try replay.commitReadSection();
    }
    pub fn setCancellation(self: *Resources, cancel: ?*const std.atomic.Value(bool)) void {
        self.cancel = cancel;
        self.http.cancel = cancel;
        if (self.rpc_client) |*client| client.options.cancel = cancel;
        if (self.svm_client) |*client| client.rpc_client.options.cancel = cancel;
        if (self.source_cache) |source_| source_.bindCancellation(cancel);
        if (self.aleo_factory) |*factory| factory.decoder.limits.cancel = cancel;
        if (self.receipt_binding) |factory| if (factory.implementation == .aleo) {
            factory.implementation.aleo.decoder.limits.cancel = cancel;
        };
    }
    pub fn deinit(self: *Resources) void {
        if (self.factory) |factory| factory.deinit();
        if (self.receipt_binding) |factory| factory.deinit();
        if (self.starknet_factory) |*factory| factory.deinit();
        if (self.aleo_factory) |*factory| factory.deinit();
        if (self.aleo_crypto) |*crypto| crypto.deinit();
        if (self.grpc_fallback) |*fallback| fallback.deinit();
        if (self.grpc_health_owned) if (self.grpc_health) |health| {
            health.deinit();
            self.allocator.destroy(health);
        };
        for (self.grpc_clients[0..self.grpc_initialized]) |*client| client.deinit();
        if (self.rpc_client) |*client| client.deinit();
        if (self.svm_client) |*client| client.deinit();
        if (self.http_replay) |replay| {
            replay.deinit();
            self.allocator.destroy(replay);
        }
        if (self.read_replay) |replay| {
            replay.deinit();
            self.allocator.destroy(replay);
        }
        if (self.rpc_pool_owned) if (self.rpc_pool) |pool| pool.deinit();
        for (self.endpoints_owned.items) |*owner| owner.deinit();
        self.endpoints_owned.deinit(self.allocator);
        self.http.deinit();
        if (self.native_ready) self.native.deinit();
        if (self.rpc_metrics) |recorder| {
            recorder.providerDropped(self.owned_provider_metrics);
            recorder.deinit();
        }
        self.arena.deinit();
        if (self.owned_environment) |env| {
            env.deinit();
            self.allocator.destroy(env);
        }
        self.allocator.destroy(self);
    }
};

test "chain source resources validate constructor bounds before loading native dependencies" {
    var env = std.process.EnvMap.init(std.testing.allocator);
    defer env.deinit();
    const chain: types.Chain = undefined;
    try std.testing.expectError(error.InvalidChainSourceTimeout, Resources.open(std.testing.allocator, &chain, &env, .{ .curl_library = "missing", .request_timeout_ms = 0 }));
    _ = Resources.source;
    _ = Resources.receipts;
}

test {
    _ = @import("chain_source_testing.zig");
}

test "Cosmos RPC direct budget stays finite and intersects both actual owner clocks" {
    const a = std.testing.allocator;
    var resources: Resources = .{ .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .environment = undefined, .http = http.HttpTransport.init(a) };
    defer resources.arena.deinit();
    defer resources.http.deinit();
    try std.testing.expectEqual(@as(u32, 120000), try resources.fallbackRpcBudget(null));
    const now = try http.rpcNowNs();
    resources.rpc_deadline_ns = now + 10 * std.time.ns_per_s;
    const parent_budget = try resources.fallbackRpcBudget(null);
    try std.testing.expect(parent_budget > 0 and parent_budget <= 10000);
    resources.http.rpc_read_owner = .{ .deadline_ns = now + std.time.ns_per_s };
    const nested_budget = try resources.fallbackRpcBudget(null);
    try std.testing.expect(nested_budget > 0 and nested_budget <= 1000);
    resources.rpc_deadline_ns = now + 30 * std.time.ns_per_s;
    try std.testing.expect(try resources.fallbackRpcBudget(null) <= nested_budget);
    const shorter_caller = try resources.fallbackRpcBudget(now + 500 * std.time.ns_per_ms);
    try std.testing.expect(shorter_caller > 0 and shorter_caller <= 500);
}

test "Cosmos RPC direct budget preserves expiration cancellation halt and invalid bounds" {
    const a = std.testing.allocator;
    var resources: Resources = .{ .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .environment = undefined, .http = http.HttpTransport.init(a) };
    defer resources.arena.deinit();
    defer resources.http.deinit();
    resources.rpc_deadline_ns = 1;
    try std.testing.expectError(error.RequestDeadlineExceeded, resources.fallbackRpcBudget(null));
    resources.rpc_deadline_ns = null;
    try std.testing.expectError(error.RequestDeadlineExceeded, resources.fallbackRpcBudget(1));
    var cancel = std.atomic.Value(bool).init(true);
    resources.cancel = &cancel;
    try std.testing.expectError(error.RequestCancelled, resources.fallbackRpcBudget(null));
    cancel.store(false, .release);
    var halt = std.atomic.Value(bool).init(true);
    resources.http.rpc_read_owner = .{ .deadline_ns = (try http.rpcNowNs()) + std.time.ns_per_s, .halt = &halt };
    try std.testing.expectError(error.CheckpointEffectsHalted, resources.fallbackRpcBudget(null));
    halt.store(false, .release);
    resources.http.rpc_read_owner = .{ .deadline_ns = 1 };
    try std.testing.expectError(error.RequestDeadlineExceeded, resources.fallbackRpcBudget(null));
    resources.http.rpc_read_owner = null;
    resources.options.read_attempt_timeout_ms = 0;
    try std.testing.expectError(error.InvalidReadReplayLimit, resources.fallbackRpcBudget(null));
    resources.options.read_attempt_timeout_ms = 300001;
    try std.testing.expectError(error.InvalidReadReplayLimit, resources.fallbackRpcBudget(null));
}
