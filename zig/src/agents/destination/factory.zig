//! Heap-owned native dispatcher; concrete chain clients/transports are borrowed.
//! EVM remains on the single durable Lander nonce allocator owned by the role.
const std = @import("std");
const types = @import("types.zig");
const settings = @import("../../settings/types.zig");
const sources = @import("../chain_source.zig");
const signing = @import("../signer.zig");
const svm = @import("sealevel.zig");
const cosmos = @import("cosmos.zig");
const radix = @import("radix.zig");
const tron = @import("tron.zig");
const starknet = @import("starknet.zig");
const aleo = @import("aleo.zig");
const protocol = @import("../../protocol/root.zig");
const objects = @import("../../storage/objects.zig");
const common = @import("../scraper/receipts_common.zig");
const contract_cache = @import("../../relayer/contract_cache.zig");
const cached = @import("../../relayer/cached_source.zig");
const matching = @import("../../ops/matching.zig");
const A = std.mem.Allocator;
const Hash = [32]u8;
pub const OriginBinding = struct { domain: u32, hook: Hash };
pub const Clock = struct { unix_ms: u64, deadline_ns: u64, cancel: ?*const std.atomic.Value(bool) = null, halt: ?*const std.atomic.Value(bool) = null };
pub const Options = struct {
    metadata_cache: ?*contract_cache.CacheFor([32]u8).Cache = null,
    default_ism_cache: ?*contract_cache.CacheFor([32]u8).Cache = null,
    ism_cache_configs: []const settings.IsmCache = &.{},
    metric_app_contexts: []const settings.MetricContext = &.{},
    concurrent_svm_estimates: bool = false,
    metadata_executor: ?*@import("../../relayer/metadata_parallel.zig").Executor = null,
    maximum_fee: ?u256 = null,
    maximum_gas: ?u64 = null,
    starknet_crypto_library: ?[]const u8 = null,
    aleo_parameter_home: ?[]const u8 = null,
    aleo_worker_timeout_ms: u32 = 120000,
    origin_bindings: []const OriginBinding = &.{},
    regex_engine: ?*@import("../../ops/regex.zig").Engine = null,
    allow_fixture_transport: bool = false,
    enable_reveals: bool = false,
    reveal_boot: ?Hash = null,
    metadata_observer: ?@import("../../ops/relayer_metrics.zig").MetadataObserver = null,
    observation: ?@import("../../relayer/metadata.zig").Observation = null,
    initialization_observer: ?@import("../../ops/init_metrics.zig").Observer = null,
};
pub const Backend = union(enum) { sealevel: svm.Sealevel, cosmos: cosmos.Cosmos, radix: radix.Radix, tron: tron.Tron, starknet: starknet.Starknet, aleo: aleo.Aleo };
pub const Factory = struct {
    allocator: A,
    arena: std.heap.ArenaAllocator,
    resources: *sources.Resources,
    options: Options,
    backend: Backend = undefined,
    backend_ready: bool = false,
    chain_checked: bool = false,
    digest: ?*signing.DigestSigner = null,
    ccs_digest: ?*signing.DigestSigner = null,
    signer_http: ?*@import("../../cloud/http.zig").HttpTransport = null,
    remote_signer: bool = false,
    active_halt: ?*const std.atomic.Value(bool) = null,
    active_cache_ms: u64 = 0,
    metric_contexts: []Metric = &.{},
    metric_initialized: usize = 0,
    /// Borrowed only for the serialized metadata job; forks retain independent handlers.
    ccip_handler: ?@import("../../relayer/ccip.zig").Handler = null,
    key: ?Hash = null,
    identity_key: ?Hash = null,
    stark_crypto: ?@import("../../starknet/crypto.zig").Crypto = null,
    stark_signer: ?@import("../../starknet/transaction.zig").LocalSigner = null,
    prover: ?*@import("../../aleo/prover.zig").Prover = null,
    submission_svm: []@import("../../sealevel/provider.zig").Client = &.{},
    submission_initialized: usize = 0,
    svm_oracle_http: ?@import("../../cloud/http.zig").HttpTransport = null,
    svm_witness: @import("reveal.zig").SimulationWitness = .{},
    reveal_boot: Hash = .{0} ** 32,
    const Metric = struct { name: []const u8, matcher: matching.Matcher };
    pub fn open(a: A, resources: *sources.Resources, transaction_signer: settings.Signer, credentials: signing.Credentials, options: Options) !*Factory {
        if (resources.chain.protocol == .ethereum) return error.UseEvmLander;
        const self = try a.create(Factory);
        self.* = .{ .allocator = a, .arena = .init(a), .resources = resources, .options = options };
        errdefer self.deinit();
        self.remote_signer = transaction_signer == .aws or transaction_signer == .gcp;
        try self.bindSignerOwner(credentials);
        var signer_scope = NonRpcScope.init(self.signer_http);
        defer signer_scope.finish();
        if (options.reveal_boot) |boot| self.reveal_boot = boot else std.crypto.random.bytes(&self.reveal_boot);
        const temporary = self.arena.allocator();
        self.metric_contexts = try temporary.alloc(Metric, options.metric_app_contexts.len);
        for (self.metric_contexts, options.metric_app_contexts) |*target, configured| {
            target.* = .{ .name = configured.name, .matcher = try matching.Matcher.init(a, configured.matching_list, options.regex_engine) };
            self.metric_initialized += 1;
        }
        self.options.origin_bindings = try temporary.dupe(OriginBinding, options.origin_bindings);
        for (self.options.origin_bindings, 0..) |binding, i| for (self.options.origin_bindings[0..i]) |old| if (binding.domain == old.domain) return error.DuplicateOriginAuthority;
        if (options.aleo_parameter_home) |path| self.options.aleo_parameter_home = try temporary.dupe(u8, path);
        self.backend = switch (resources.clients) {
            .ethereum => return error.UseEvmLander,
            .tron => |client| blk: {
                self.digest = signer_init: {
                    var timer = if (options.initialization_observer != null) std.time.Timer.start() catch null else null;
                    defer if (timer) |*value| options.initialization_observer.?.completed(.ccip_signers, value.read());
                    break :signer_init try signing.DigestSigner.open(a, transaction_signer, credentials);
                };
                break :blk .{ .tron = .{ .chain = .{ .provider = client, .mailbox = try evmAddress(resources.chain.contracts.mailbox), .hook = try evmAddress(resources.chain.contracts.merkle_tree_hook), .domain = resources.chain.domain }, .announce = try evmAddress(resources.chain.contracts.validator_announce), .signer = .{ .context = self, .address = @import("../../altvm/tron.zig").fromEthereumAddress(self.digest.?.address), .sign_fn = digestSign }, .chain_id = resources.chain.chain_id, .fee_policy = .{ .max_fee_sun = try self.cap(u64, std.math.maxInt(i64)), .multiplier = resources.chain.connection.tron.fee_multiplier } } };
            },
            .cosmos => |*clients| blk: {
                const spec = switch (transaction_signer) {
                    .cosmos_key => |value| value,
                    else => return error.CosmosSignerRequired,
                };
                if (!std.mem.eql(u8, spec.prefix, clients.queries.config.bech32_prefix)) return error.WrongCosmosSignerPrefix;
                self.digest = try signing.DigestSigner.open(a, .{ .hex_key = spec.key }, credentials);
                const account_type: @import("../../altvm/cosmos.zig").AccountAddressType = if (std.ascii.eqlIgnoreCase(spec.account_address_type, "bitcoin")) .bitcoin else if (std.ascii.eqlIgnoreCase(spec.account_address_type, "ethereum")) .ethereum else return error.UnsupportedCosmosAccountAddressType;
                const account = try @import("../../altvm/cosmos.zig").publicKeyAddress(self.digest.?.public_key, account_type);
                var output: [128]u8 = undefined;
                const signer_address = try temporary.dupe(u8, try @import("../../altvm/bech32.zig").encode(spec.prefix, &account, &output));
                break :blk .{ .cosmos = .{ .queries = clients.queries, .transactions = .{ .allocator = a, .rpc = &clients.tendermint, .config = clients.queries.config, .signer_address = signer_address, .public_key = self.digest.?.public_key, .address_type = account_type }, .mailbox = resources.chain.contracts.mailbox, .announce = resources.chain.contracts.validator_announce, .native = resources.chain.protocol == .cosmosnative, .signer = .{ .context = self, .public_key = self.digest.?.public_key, .sign_fn = digestSign }, .maximum_fee = try self.cap(u128, std.math.maxInt(u128)), .maximum_gas = options.maximum_gas orelse std.math.maxInt(u64) } };
            },
            .radix => |client| blk: {
                const spec = switch (transaction_signer) {
                    .radix_key => |value| value,
                    else => return error.RadixSignerRequired,
                };
                if (!std.mem.eql(u8, spec.suffix, client.network.suffix)) return error.WrongRadixSignerNetwork;
                self.key = spec.key;
                break :blk .{ .radix = .{ .chain = .{ .provider = client, .mailbox = try @import("../../radix/address.zig").node(resources.chain.contracts.mailbox), .domain = resources.chain.domain }, .chain_id = resources.chain.chain_id, .announce = try @import("../../radix/address.zig").node(resources.chain.contracts.validator_announce), .signer = .{ .context = self, .public_key = try @import("../../radix/crypto.zig").publicKey(spec.key), .key_fn = readKey }, .maximum_fee = try self.cap(u256, @intCast(std.math.maxInt(i192))) } };
            },
            .starknet => |factory| blk: {
                const spec = switch (transaction_signer) {
                    .stark_key => |value| value,
                    else => return error.StarknetSignerRequired,
                };
                const path = options.starknet_crypto_library orelse return error.MissingStarknetCryptoLibrary;
                self.stark_crypto = try @import("../../starknet/crypto.zig").Crypto.init(a, path);
                self.stark_signer = .{ .crypto = &self.stark_crypto.?, .secret = spec.key };
                const felt = @import("../../starknet/codec.zig").Felt;
                break :blk .{ .starknet = .{ .chain = .{ .provider = &factory.provider, .mailbox = try felt.fromBytes(resources.chain.contracts.mailbox), .hook = try felt.fromBytes(resources.chain.contracts.merkle_tree_hook), .domain = resources.chain.domain }, .announce = try felt.fromBytes(resources.chain.contracts.validator_announce), .native = &self.stark_crypto.?, .signer = .{ .context = self, .public_key = (try self.stark_signer.?.interface()).public_key, .sign_fn = starkSign }, .account = try felt.fromBytes(spec.address), .chain_id = try felt.fromHex(resources.chain.chain_id), .encoding = if (spec.legacy) .legacy else .modern, .reorg = switch (resources.chain.reorg) {
                    .blocks => |value| .{ .blocks = value },
                    .tag => |value| .{ .tag = value },
                }, .maximum_fee = try self.cap(u256, std.math.maxInt(u256)) } };
            },
            .aleo => |factory| blk: {
                self.key = switch (transaction_signer) {
                    .hex_key => |value| value,
                    else => return error.AleoSignerRequired,
                };
                const config = resources.chain.connection.aleo;
                if (!std.math.isFinite(config.priority_fee_multiplier) or config.priority_fee_multiplier < 0) return error.InvalidAleoPriorityFee;
                const owner = try self.aleoAddress(factory.decoder);
                if (config.proving_service_urls.len != 0) {
                    self.prover = try @import("../../aleo/prover.zig").Prover.init(a, resources.http.interface(), config.proving_service_urls, factory.provider.client.network);
                    self.prover.?.http_owner = &resources.http;
                    self.prover.?.allow_fixture_transport = options.allow_fixture_transport;
                }
                break :blk .{ .aleo = .{ .chain = try @import("../../aleo/contracts.zig").Contracts.init(&factory.provider, factory.configuration), .signer = .{ .context = self, .address = owner, .key_fn = readKey }, .executable = factory.decoder.executable, .library = factory.decoder.library, .limits = .{ .timeout_ms = options.aleo_worker_timeout_ms, .parameter_home = self.options.aleo_parameter_home }, .maximum_fee = try self.cap(u64, std.math.maxInt(u64)), .priority_fee_multiplier = config.priority_fee_multiplier, .http_owner = &resources.http, .allow_fixture_transport = options.allow_fixture_transport, .delegated_prover = self.prover } };
            },
            .sealevel => |client| blk: {
                self.key = switch (transaction_signer) {
                    .hex_key => |value| value,
                    else => return error.SealevelSignerRequired,
                };
                const config = resources.chain.connection.sealevel;
                if (config.ur_reveal) |configured| if (options.enable_reveals) {
                    try @import("reveal.zig").validateUrl(configured.ccs_url, options.allow_fixture_transport);
                    const ccs_signer = resources.chain.ccs_signer orelse return error.MissingCcsSigner;
                    self.remote_signer = self.remote_signer or ccs_signer == .aws or ccs_signer == .gcp;
                    try self.bindSignerOwner(credentials);
                    self.ccs_digest = try signing.DigestSigner.open(a, ccs_signer, credentials);
                };
                const payer = (try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(self.key.?)).public_key.toBytes();
                var identity: ?Hash = null;
                if (resources.chain.identity) |identity_signer| {
                    self.identity_key = switch (identity_signer) {
                        .hex_key => |value| value,
                        else => return error.SealevelIdentitySignerRequired,
                    };
                    identity = (try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(self.identity_key.?)).public_key.toBytes();
                    if (std.mem.eql(u8, &payer, &identity.?)) return error.IdentityIsPayer;
                }
                if (config.transaction_submitter_urls.len > 64) return error.TooManySvmSubmissionEndpoints;
                self.submission_svm = try a.alloc(@import("../../sealevel/provider.zig").Client, config.transaction_submitter_urls.len);
                for (self.submission_svm, config.transaction_submitter_urls) |*submission, url| {
                    submission.* = try @import("../../sealevel/provider.zig").Client.init(a, url, .{ .native_transport = &resources.native, .timeout_ms = resources.options.request_timeout_ms, .max_response_bytes = resources.options.rpc_max_response_bytes });
                    self.submission_initialized += 1;
                }
                if (config.priority_fee_oracle == .helius) {
                    self.svm_oracle_http = @import("../../cloud/http.zig").HttpTransport.init(a);
                    self.svm_oracle_http.?.native_curl = &resources.native;
                    self.svm_oracle_http.?.timeout_ms = resources.http.timeout_ms;
                    self.svm_oracle_http.?.connect_timeout_ms = resources.http.connect_timeout_ms;
                    self.svm_oracle_http.?.allow_insecure_loopback = resources.http.allow_insecure_loopback;
                }
                const oracle: @import("../../sealevel/transaction.zig").Oracle = switch (config.priority_fee_oracle) {
                    .constant => |value| .{ .constant = value },
                    .helius => |value| .{ .helius = .{ .transport = self.svm_oracle_http.?.interface(), .url = value.url, .level = try feeLevel(value.fee_level) } },
                };
                const decoded_noop = try @import("../../altvm/base58.zig").decode(a, "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
                defer a.free(decoded_noop);
                if (decoded_noop.len != 32) return error.InvalidNoopProgram;
                break :blk .{ .sealevel = .{ .chain = .{ .client = client, .program = resources.chain.contracts.mailbox, .domain = resources.chain.domain, .payer = payer }, .chain_id = resources.chain.chain_id, .announce = resources.chain.contracts.validator_announce, .reveal_target = if (config.ur_reveal) |configured| configured.program_id else null, .simulation_observer = if (config.ur_reveal != null and options.enable_reveals) self.svm_witness.observer() else null, .signer = .{ .context = self, .payer = payer, .sign_fn = edSign }, .identity = identity, .noop = decoded_noop[0..32].*, .alt_addresses = config.mailbox_process_alts, .submitter = switch (config.transaction_submitter) {
                    .rpc => .rpc,
                    .jito => .jito,
                }, .oracle = oracle, .oracle_http = if (self.svm_oracle_http) |*owner| owner else null, .concurrent_estimate_reads = options.concurrent_svm_estimates, .fee_cap = null, .maximum_fee = try self.cap(u64, std.math.maxInt(u64)), .submit_clients = self.submission_svm } };
            },
        };
        self.backend_ready = true;
        return self;
    }
    /// Already initialized backend identity only; no signing/key resolution/I/O.
    pub fn publicWalletInto(self: *Factory, out: []u8) ![]const u8 {
        if (!self.backend_ready) return error.NativeDestinationNotInitialized;
        var scratch: [1024]u8 = undefined;
        var fixed = std.heap.FixedBufferAllocator.init(&scratch);
        const temporary = fixed.allocator();
        const text = switch (self.backend) {
            .sealevel => |value| try @import("../../altvm/base58.zig").encode(temporary, &value.signer.payer),
            .cosmos => |value| value.transactions.signer_address,
            .radix => |value| try @import("../../radix/address.zig").encode(value.chain.provider.network, "account", &@import("../../radix/crypto.zig").account(value.signer.public_key), &scratch),
            .tron => |value| try @import("../../altvm/tron.zig").encodeAddress(temporary, value.signer.address),
            .starknet => |value| try std.fmt.bufPrint(&scratch, "0x{x}", .{value.account.value}),
            .aleo => |value| try value.chain.provider.native.addressText(temporary, value.signer.address),
        };
        if (text.len > out.len) return error.InvalidHealthWalletBuffer;
        @memcpy(out[0..text.len], text);
        return out[0..text.len];
    }
    pub fn mailbox(self: *Factory) !Hash {
        return switch (self.backend) {
            .aleo => |*value| value.chain.provider.native.programAddress(value.chain.config.mailbox),
            else => self.resources.chain.contracts.mailbox,
        };
    }
    pub fn announcementTarget(self: *Factory) !Hash {
        return switch (self.backend) {
            .sealevel => |value| value.announce,
            .cosmos => |value| if (value.native) value.mailbox else value.announce,
            .radix => |value| @import("../../radix/address.zig").h256(value.announce),
            .tron => |value| padded(value.announce orelse return error.MissingTronAnnounceContract),
            .starknet => |value| (value.announce orelse return error.MissingStarknetAnnounceContract).toBytes(),
            .aleo => |*value| value.chain.provider.native.programAddress(value.chain.config.validator_announce),
        };
    }
    fn originHook(self: *Factory, domain: u32) !Hash {
        for (self.options.origin_bindings) |binding| if (binding.domain == domain) return binding.hook;
        return error.MissingOriginAuthorityBinding;
    }
    pub fn authorityFor(self: *Factory, origin: u32, operation_id: Hash, generation: u64, kind: types.Kind) !types.Authority {
        return .{ .protocol = self.resources.chain.protocol, .origin = origin, .destination = self.resources.chain.domain, .mailbox = try self.mailbox(), .chain_id = self.resources.chain.chain_id, .origin_hook = if (kind != .announcement) try self.originHook(origin) else null, .operation_id = operation_id, .generation = generation, .kind = kind, .target = switch (kind) {
            .process => null,
            .announcement => try self.announcementTarget(),
            .reveal => try self.revealTarget(),
        } };
    }
    fn revealTarget(self: *Factory) !Hash {
        if (self.resources.chain.protocol != .sealevel) return error.UnsupportedRevealProtocol;
        return (self.resources.chain.connection.sealevel.ur_reveal orelse return error.MissingRevealConfiguration).program_id;
    }
    fn checkAuthority(self: *Factory, context: types.Authority) !void {
        if (context.protocol != self.resources.chain.protocol or context.destination != self.resources.chain.domain or !std.mem.eql(u8, context.chain_id, self.resources.chain.chain_id) or !std.mem.eql(u8, &context.mailbox, &try self.mailbox())) return error.DestinationAuthorityMismatch;
        if (context.kind == .announcement) {
            if (context.origin != context.destination) return error.DestinationAuthorityMismatch;
            try context.expectTarget(try self.announcementTarget());
        } else {
            const hook = try self.originHook(context.origin);
            if (context.origin_hook == null or !std.mem.eql(u8, &hook, &context.origin_hook.?)) return error.OriginAuthorityMismatch;
            if (context.kind == .reveal) try context.expectTarget(try self.revealTarget()) else if (self.backend != .aleo) try context.expectTarget(try self.mailbox());
        }
    }
    const Scope = struct {
        owner: *Factory,
        halt: ?*const std.atomic.Value(bool) = null,
        cache_ms: u64 = 0,
        cancel: ?*const std.atomic.Value(bool),
        timeout_ms: u32,
        connect_ms: u32,
        rpc_deadline_ns: ?u64,
        rpc_read_owner: ?@import("../../cloud/http.zig").RpcReadOwner,
        svm_deadline: ?u64 = null,
        backend_cancel: ?*const std.atomic.Value(bool) = null,
        backend_timeout_ms: u32 = 0,
        signer_http: ?*@import("../../cloud/http.zig").HttpTransport = null,
        signer_cancel: ?*const std.atomic.Value(bool) = null,
        signer_timeout_ms: u32 = 0,
        signer_connect_ms: u32 = 0,
        signer_read_owner: ?@import("../../cloud/http.zig").RpcReadOwner = null,
        fn finish(self: *Scope) void {
            self.owner.active_halt = self.halt;
            self.owner.active_cache_ms = self.cache_ms;
            self.owner.resources.setCancellation(self.cancel);
            self.owner.resources.http.timeout_ms = self.timeout_ms;
            self.owner.resources.http.connect_timeout_ms = self.connect_ms;
            self.owner.resources.rpc_deadline_ns = self.rpc_deadline_ns;
            self.owner.resources.http.rpc_read_owner = self.rpc_read_owner;
            if (self.signer_http) |owner| {
                owner.cancel = self.signer_cancel;
                owner.timeout_ms = self.signer_timeout_ms;
                owner.connect_timeout_ms = self.signer_connect_ms;
                owner.rpc_read_owner = self.signer_read_owner;
            }
            switch (self.owner.backend) {
                .sealevel => |*value| {
                    value.chain.client.deadline_ns = self.svm_deadline;
                    for (self.owner.submission_svm) |*client| {
                        client.deadline_ns = null;
                        client.rpc_client.options.cancel = null;
                    }
                },
                .cosmos => |*value| {
                    value.queries.cancel = self.backend_cancel;
                    value.queries.timeout_ms = self.backend_timeout_ms;
                },
                .aleo => |*value| {
                    value.limits.cancel = self.backend_cancel;
                    value.limits.timeout_ms = self.backend_timeout_ms;
                },
                else => {},
            }
        }
    };
    /// The role's retained supervisor owns cancel and sets it at deadline. All
    /// native transports observe that token; no retiring job loses its owner.
    fn begin(self: *Factory, clock: Clock) !Scope {
        try checkHalt(clock.halt);
        const remaining = try common.milliseconds(clock.deadline_ns);
        const cache_now_ms = (try @import("../scraper/receipts_evm.zig").nowNs()) / std.time.ns_per_ms;
        if (clock.cancel) |cancel| {
            if (cancel.load(.acquire)) return error.RequestCancelled;
        } else if (!self.options.allow_fixture_transport) return error.DestinationCancellationRequired;
        if (self.resources.http.native_curl == null and !self.options.allow_fixture_transport) return error.NativeDestinationTransportRequired;
        var scope: Scope = .{ .owner = self, .halt = self.active_halt, .cache_ms = self.active_cache_ms, .cancel = self.resources.cancel, .timeout_ms = self.resources.http.timeout_ms, .connect_ms = self.resources.http.connect_timeout_ms, .rpc_deadline_ns = self.resources.rpc_deadline_ns, .rpc_read_owner = self.resources.http.rpc_read_owner };
        self.active_halt = clock.halt;
        self.active_cache_ms = cache_now_ms;
        self.resources.setCancellation(clock.cancel);
        self.resources.http.timeout_ms = @min(scope.timeout_ms, remaining);
        self.resources.http.connect_timeout_ms = @min(scope.connect_ms, remaining);
        const rpc_deadline = @min(clock.deadline_ns, @min(scope.rpc_deadline_ns orelse clock.deadline_ns, if (scope.rpc_read_owner) |owner| owner.deadline_ns else clock.deadline_ns));
        self.resources.rpc_deadline_ns = rpc_deadline;
        self.resources.http.rpc_read_owner = .{ .deadline_ns = rpc_deadline, .halt = if (scope.rpc_read_owner) |owner| owner.halt orelse clock.halt else clock.halt, .retry_physical_timeout = if (scope.rpc_read_owner) |owner| owner.retry_physical_timeout else true };
        if (self.signer_http) |owner| if (owner != &self.resources.http) {
            scope.signer_http = owner;
            scope.signer_cancel = owner.cancel;
            scope.signer_timeout_ms = owner.timeout_ms;
            scope.signer_connect_ms = owner.connect_timeout_ms;
            scope.signer_read_owner = owner.rpc_read_owner;
            owner.cancel = clock.cancel;
            owner.timeout_ms = @min(owner.timeout_ms, remaining);
            owner.connect_timeout_ms = @min(owner.connect_timeout_ms, remaining);
            owner.rpc_read_owner = .{ .deadline_ns = @min(clock.deadline_ns, if (scope.signer_read_owner) |saved| saved.deadline_ns else clock.deadline_ns), .halt = if (scope.signer_read_owner) |saved| saved.halt orelse clock.halt else clock.halt };
        };
        switch (self.backend) {
            .sealevel => |*value| {
                scope.svm_deadline = value.chain.client.deadline_ns;
                value.chain.client.deadline_ns = clock.deadline_ns;
                for (self.submission_svm) |*client| {
                    client.deadline_ns = clock.deadline_ns;
                    client.rpc_client.options.cancel = clock.cancel;
                }
            },
            .cosmos => |*value| {
                scope.backend_cancel = value.queries.cancel;
                scope.backend_timeout_ms = value.queries.timeout_ms;
                value.queries.cancel = clock.cancel;
                value.queries.timeout_ms = @min(remaining, self.resources.options.request_timeout_ms);
            },
            .aleo => |*value| {
                scope.backend_cancel = value.limits.cancel;
                scope.backend_timeout_ms = value.limits.timeout_ms;
                value.limits.cancel = clock.cancel;
                value.limits.timeout_ms = @min(self.options.aleo_worker_timeout_ms, remaining);
            },
            else => {},
        }
        return scope;
    }
    fn checked(clock: Clock) !void {
        try checkHalt(clock.halt);
        _ = try common.milliseconds(clock.deadline_ns);
        if (clock.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
    }
    fn ensureChain(self: *Factory) !void {
        if (self.chain_checked) return;
        switch (self.backend) {
            .sealevel => |*value| {
                _ = try value.chain.inbox();
            },
            .cosmos => |*value| {
                _ = try value.transactions.rpc.status();
                if (value.native) {
                    var mailbox_value = try value.queries.nativeMailbox(value.mailbox, null);
                    defer mailbox_value.deinit();
                }
            },
            .radix => |*value| {
                _ = try value.chain.provider.gatewayState();
            },
            .starknet => |*value| try value.chain.provider.checkChain(value.chain_id),
            .aleo => |*value| {
                _ = try value.chain.mailbox(true);
            },
            .tron => |*value| {
                const json_rpc = @import("../../tron/rpc.zig");
                var response = try value.chain.provider.jsonrpc.call("eth_chainId", .{});
                defer response.deinit();
                const expected = try std.fmt.parseInt(u256, value.chain_id, if (std.mem.startsWith(u8, value.chain_id, "0x")) 0 else 10);
                if (try @import("../../evm/codecs.zig").quantityAs(u256, try json_rpc.string(json_rpc.result(response))) != expected) return error.WrongTronChain;
                const bytes = try value.chain.provider.ethCall(value.chain.mailbox, &@import("../../evm/codecs.zig").selector("localDomain()"), .finalized);
                defer self.allocator.free(bytes);
                if (try @import("../../evm/codecs.zig").uintWord(u32, bytes) != value.chain.domain) return error.WrongTronMailboxDomain;
            },
        }
        self.chain_checked = true;
    }
    pub fn recipientIsm(self: *Factory, message: protocol.Message, clock: Clock) !Hash {
        _ = try self.originHook(message.origin);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        if (self.options.metadata_cache) |cache| if (try cache.get(try self.cacheContext(), .recipientIsm(message.recipient), self.active_cache_ms)) |found| {
            var value = found;
            defer value.deinit(cache.allocator);
            try checked(clock);
            return value.address;
        };
        const result = switch (self.backend) {
            .sealevel => |*value| try value.recipientIsm(message),
            .cosmos => |*value| try value.recipientIsm(message),
            .radix => |*value| try value.recipientIsm(message),
            .tron => |*value| padded(try value.chain.recipientIsm(try evmAddress(message.recipient))),
            .starknet => |*value| (try value.chain.recipientIsm(message.recipient)).toBytes(),
            .aleo => |*value| try value.chain.recipientIsm(message.recipient),
        };
        if (self.options.metadata_cache) |cache| _ = try cache.put(try self.cacheContext(), .recipientIsm(message.recipient), &.{ .address = result }, self.active_cache_ms);
        try checked(clock);
        return result;
    }
    fn cacheContext(self: *Factory) !contract_cache.Context {
        return .{ .domain_name = self.resources.chain.name, .context_hash = try self.identityContext() };
    }
    fn appContext(self: *Factory, message: protocol.Message) !?[]const u8 {
        for (self.metric_contexts) |*context| if (try context.matcher.messageMatches(message, false)) return context.name;
        return null;
    }
    /// Root CCIP binding borrows this only inside metadata()'s scoped job.
    /// Fork handlers replace it with the fork's independent native reader.
    pub fn lookupSource(self: *Factory) !@import("../../relayer/ccip.zig").LookupSource {
        if (self.backend != .tron) return error.UnsupportedNativeCcipRead;
        return .{ .context = self, .lookup_fn = nativeLookup };
    }
    fn nativeLookup(context: *anyopaque, a: A, module: [20]u8, message: protocol.Message, _: u64, cancel: ?*const std.atomic.Value(bool)) !@import("../../relayer/ccip.zig").Lookup {
        const self: *Factory = @ptrCast(@alignCast(context));
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        if (self.backend != .tron) return error.UnsupportedNativeCcipRead;
        self.backend.tron.chain.provider.signer_address = self.backend.tron.signer.address[1..21].*;
        if (self.options.metadata_cache) |cache| return cached.offchainLookupFor(Hash, cache, try self.cacheContext(), padded(module), message, .{ .context = self, .get_fn = uncachedLookup }, self.active_cache_ms);
        return self.backend.tron.chain.offchainLookup(a, module, message);
    }
    fn uncachedLookup(context: *anyopaque, module: Hash, message: protocol.Message) !@import("../../relayer/ccip.zig").Lookup {
        const self: *Factory = @ptrCast(@alignCast(context));
        return self.backend.tron.chain.offchainLookup(self.allocator, try evmAddress(module), message);
    }
    pub fn metadata(self: *Factory, origin: anytype, module: Hash, message: protocol.Message, clock: Clock) ![]u8 {
        const observer = self.options.metadata_observer;
        if (observer) |value| try value.start();
        const result = metadataInner(self, origin, module, message, clock) catch |err| {
            if (err != error.PendingReadIo) {
                const outcome: @import("../../ops/relayer_metrics.zig").MetadataResult = if (err == error.AwaitingValidatorSignatures) .awaiting_validator_signatures else if (err == error.RequestCancelled or err == error.Cancelled) .cancelled else .failure;
                if (observer) |value| try value.complete(outcome);
            }
            return err;
        };
        errdefer self.allocator.free(result);
        if (observer) |value| try value.complete(.success);
        return result;
    }

    fn metadataInner(self: *Factory, origin: anytype, module: Hash, message: protocol.Message, clock: Clock) ![]u8 {
        _ = try self.originHook(message.origin);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        const Source = @import("source_metadata.zig").Source(@TypeOf(origin.*));
        var source = Source.init(self.allocator, self.resources, origin, .{
            .deadline_ns = clock.deadline_ns,
            .cancel = clock.cancel,
            .executor = self.options.metadata_executor,
            .observation = self.options.observation,
            .ccip_handler = self.ccip_handler,
            .default_ism_cache = self.options.default_ism_cache,
            .lookup_cache = if (self.options.metadata_cache) |cache| .{ .cache = cache, .context = try self.cacheContext(), .now_ms = self.active_cache_ms } else null,
            .tron_sender = if (self.backend == .tron) self.backend.tron.signer.address[1..21].* else null,
            .svm_payer = if (self.backend == .sealevel) self.backend.sealevel.signer.payer else null,
            .svm_identity = if (self.backend == .sealevel) self.backend.sealevel.identity else null,
        });
        const Default = struct {
            fn get(context: *anyopaque, _: u64) !Hash {
                const value: *Source = @ptrCast(@alignCast(context));
                return value.defaultIsm();
            }
            fn observedNow(_: *anyopaque) !u64 {
                // Native contract caches use the raw monotonic Instant epoch.
                // Keep both lookup and post-RPC insertion in that domain.
                return (try @import("../scraper/receipts_evm.zig").nowNs()) / std.time.ns_per_ms;
            }
        };
        const root_app_context = try @import("../../relayer/app_context.zig").classify(Hash, module, try self.appContext(message), self.options.default_ism_cache, try self.cacheContext(), .{ .context = &source, .get_fn = Default.get, .now_ms_fn = Default.observedNow }, self.active_cache_ms);
        source.options.app_context = root_app_context;
        const result = if (self.options.metadata_cache) |cache| cached_result: {
            const Cached = cached.CachedSource(Source);
            var wrapper = Cached.initBorrowed(self.allocator, &source, cache, .{ .context = try self.cacheContext(), .configs = self.options.ism_cache_configs, .default_ism_cache = self.options.default_ism_cache });
            wrapper.setMessage(module, root_app_context, self.active_cache_ms);
            var builder: @import("../../relayer/metadata.zig").Builder(Cached) = .{ .allocator = self.allocator, .source = &wrapper, .executor = self.options.metadata_executor, .cancel = clock.cancel, .observation = self.options.observation, .app_context = root_app_context };
            break :cached_result try builder.build(module, message);
        } else uncached_result: {
            var builder: @import("../../relayer/metadata.zig").Builder(Source) = .{ .allocator = self.allocator, .source = &source, .executor = self.options.metadata_executor, .cancel = clock.cancel, .observation = self.options.observation, .app_context = root_app_context };
            break :uncached_result try builder.build(module, message);
        };
        errdefer self.allocator.free(result);
        try checked(clock);
        return result;
    }
    pub fn prepare(self: *Factory, context: types.Authority, message: protocol.Message, metadata_bytes: []const u8, clock: Clock) !types.Prepared {
        try self.checkAuthority(context);
        try context.message(message);
        self.svm_witness.failure = null;
        if (self.backend == .sealevel) if (self.resources.chain.connection.sealevel.ur_reveal) |configured| {
            if (@import("reveal.zig").Commit.message(configured.program_id, message) != null and !self.options.enable_reveals) return error.RevealQueueDisabled;
        };
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        if (self.backend == .sealevel) {
            const configured = self.resources.chain.connection.sealevel;
            self.backend.sealevel.alt_addresses = configured.mailbox_process_alts;
            for (configured.process_alt_overrides) |override| {
                var matcher = try @import("../../ops/matching.zig").Matcher.init(self.allocator, override.matching_list, self.options.regex_engine);
                defer matcher.deinit();
                if (try matcher.messageMatches(message, false)) {
                    self.backend.sealevel.alt_addresses = override.alt_addresses;
                    break;
                }
            }
        }
        var result = switch (self.backend) {
            .sealevel => |*value| try value.prepare(context, message, metadata_bytes),
            .cosmos => |*value| try value.prepare(context, message, metadata_bytes),
            .radix => |*value| try value.prepare(context, message, metadata_bytes),
            .tron => |*value| try value.prepare(context, message, metadata_bytes, clock.unix_ms),
            .starknet => |*value| try value.prepare(context, message, metadata_bytes),
            .aleo => |*value| try value.prepare(context, message, metadata_bytes),
        };
        errdefer result.deinit();
        try checked(clock);
        return result;
    }
    pub fn prepareAnnouncement(self: *Factory, context: types.Authority, announcement: objects.SignedAnnouncement, clock: Clock) !types.Prepared {
        try self.checkAuthority(context);
        if (context.kind != .announcement or announcement.value.mailbox_domain != context.destination or !std.mem.eql(u8, &announcement.value.mailbox_address, &context.mailbox) or !std.mem.eql(u8, &announcement.value.digest(), &context.operation_id) or !std.mem.eql(u8, &try announcement.recover(), &announcement.value.validator)) return error.AnnouncementAuthorityMismatch;
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        const value = announcement.value;
        const signature = announcement.signature.bytes();
        var result = switch (self.backend) {
            .sealevel => |*backend| try backend.prepareAnnouncement(context, value.validator, value.storage_location, signature),
            .cosmos => |*backend| try backend.prepareAnnouncement(context, value.validator, value.storage_location, signature),
            .radix => |*backend| try backend.prepareAnnouncement(context, value.validator, value.storage_location, signature),
            .tron => |*backend| try backend.prepareAnnouncement(context, value.validator, value.storage_location, signature, clock.unix_ms),
            .starknet => |*backend| try backend.prepareAnnouncement(context, value.validator, value.storage_location, signature),
            .aleo => |*backend| blk: {
                if (value.storage_location.len >= 480 or std.mem.indexOfScalar(u8, value.storage_location, 0) != null) return error.InvalidAleoAnnouncementLength;
                var location: [480]u8 = .{0} ** 480;
                @memcpy(location[0..value.storage_location.len], value.storage_location);
                break :blk try backend.prepareAnnouncement(context, value.validator, &location, signature);
            },
        };
        errdefer result.deinit();
        try checked(clock);
        return result;
    }
    pub const Estimate = struct { gas_limit: u256, estimated_cost: u256 };
    pub fn quote(self: *Factory, prepared: *types.Prepared, authorization: ?[]const u8, persistence: types.Persistence, clock: Clock) !Estimate {
        try self.checkAuthority(prepared.authority);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        if (self.backend == .aleo) {
            var authorized = if (authorization) |bytes| try aleo.Authorized.restore(self.allocator, bytes) else try self.backend.aleo.authorize(prepared, persistence, clock.deadline_ns);
            defer authorized.deinit();
            try self.backend.aleo.validateAuthorization(prepared, &authorized, clock.deadline_ns);
            const cost = try std.math.add(u64, authorized.base_fee, authorized.priority_fee);
            prepared.gas_limit = cost;
            prepared.estimated_cost = cost;
        } else {
            try prepared.validate();
            const json_rpc = @import("../../net/json_rpc.zig");
            prepared.gas_limit = try json_rpc.integer(u256, try json_rpc.field(prepared.body, "gas_limit"));
            prepared.estimated_cost = try json_rpc.integer(u256, try json_rpc.field(prepared.body, switch (self.backend) {
                .sealevel, .cosmos => "fee",
                .radix => "estimated_fee",
                else => "estimated_cost",
            }));
            if (self.options.maximum_fee) |maximum| if (prepared.estimated_cost.? > maximum) return error.NativeFeeCapExceeded;
        }
        try checked(clock);
        return .{ .gas_limit = prepared.gas_limit orelse return error.UnpricedNativeTransaction, .estimated_cost = prepared.estimated_cost orelse return error.UnpricedNativeTransaction };
    }
    /// New canonical bytes: caller must use only before staged/prepared. A
    /// recovered intent is immutable and cannot be silently replaced by this.
    pub fn applyGasAllowance(self: *Factory, prepared: *const types.Prepared, allowed: u256, clock: Clock) !types.Prepared {
        try self.checkAuthority(prepared.authority);
        var scope = try self.begin(clock);
        defer scope.finish();
        const result = switch (self.backend) {
            .cosmos => |*value| try value.applyGasAllowance(prepared, allowed),
            .tron => |*value| try value.applyGasAllowance(prepared, allowed),
            else => try types.Prepared.restore(self.allocator, prepared.canonical_intent),
        };
        return result;
    }
    pub fn prepareStarknetBatch(self: *Factory, inputs: []const *const types.Prepared, maximum: usize, clock: Clock) !starknet.PreparedBatch {
        if (self.backend != .starknet) return error.DestinationDoesNotSupportBatching;
        for (inputs) |input| try self.checkAuthority(input.authority);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        var result = try self.backend.starknet.prepareBatch(inputs, maximum);
        errdefer result.deinit();
        try checked(clock);
        return result;
    }
    pub fn refreshStarknetPrepared(self: *Factory, input: *const types.Prepared, clock: Clock) !types.Prepared {
        if (self.backend != .starknet) return error.DestinationDoesNotSupportBatching;
        try self.checkAuthority(input.authority);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        var result = try self.backend.starknet.refreshPrepared(input);
        errdefer result.deinit();
        try checked(clock);
        return result;
    }
    pub fn validateStarknetBatch(self: *Factory, members: []const types.Prepared) !void {
        if (self.backend != .starknet) return error.DestinationDoesNotSupportBatching;
        for (members) |member| try self.checkAuthority(member.authority);
        try self.backend.starknet.validateBatch(members);
    }
    pub fn sign(self: *Factory, prepared: *const types.Prepared, authorization: ?[]const u8, persistence: types.Persistence, clock: Clock) !types.Signed {
        try self.checkAuthority(prepared.authority);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        var result = switch (self.backend) {
            .sealevel => |*value| try value.sign(prepared, persistence),
            .cosmos => |*value| try value.sign(prepared, persistence),
            .radix => |*value| try value.sign(prepared, persistence),
            .tron => |*value| try value.sign(prepared, persistence, clock.unix_ms),
            .starknet => |*value| try value.sign(prepared, persistence),
            .aleo => |*value| blk: {
                var authorized = try aleo.Authorized.restore(self.allocator, authorization orelse return error.AleoQuoteRequired);
                defer authorized.deinit();
                break :blk if (value.delegated_prover != null) try value.proveDelegated(prepared, &authorized, persistence, clock.deadline_ns, @intCast(clock.unix_ms / 1000)) else try value.proveLocal(prepared, &authorized, persistence, clock.deadline_ns);
            },
        };
        errdefer result.deinit();
        try checked(clock);
        return result;
    }
    pub fn broadcast(self: *Factory, prepared: *const types.Prepared, authorization: ?[]const u8, signed: *const types.Signed, persistence: types.Persistence, clock: Clock) !void {
        try self.checkAuthority(prepared.authority);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        switch (self.backend) {
            .sealevel => |*value| try value.broadcast(prepared, signed, persistence),
            .cosmos => |*value| try value.broadcast(prepared, signed, persistence),
            .radix => |*value| try value.broadcast(prepared, signed, persistence),
            .tron => |*value| try value.broadcast(prepared, signed, persistence, clock.unix_ms),
            .starknet => |*value| try value.broadcast(prepared, signed, persistence),
            .aleo => |*value| {
                var authorized = try aleo.Authorized.restore(self.allocator, authorization orelse return error.AleoQuoteRequired);
                defer authorized.deinit();
                try value.broadcast(prepared, &authorized, signed, persistence, clock.deadline_ns);
            },
        }
        try checked(clock);
    }
    pub fn reconcile(self: *Factory, identity: types.Identity, clock: Clock) !?types.Receipt {
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        const result = switch (self.backend) {
            .sealevel => |*value| try value.reconcile(identity),
            .cosmos => |*value| try value.reconcile(identity),
            .radix => |*value| try value.reconcile(identity),
            .tron => |*value| try value.reconcile(identity),
            .starknet => |*value| try value.reconcile(identity),
            .aleo => |*value| try value.reconcile(identity, clock.deadline_ns),
        };
        try checked(clock);
        return result;
    }
    /// The successful Jito tip is a signed system transfer, outside meta.fee.
    /// Failed transactions roll it back atomically. Keep it in actual spend.
    pub fn reconcilePrepared(self: *Factory, prepared: *const types.Prepared, identity: types.Identity, clock: Clock) !?types.Receipt {
        try prepared.validate();
        try self.checkAuthority(prepared.authority);
        var result = try self.reconcile(identity, clock) orelse return null;
        if (self.backend == .sealevel and self.backend.sealevel.submitter == .jito and result.success and result.expenditure != null) {
            const json = @import("../../net/json_rpc.zig");
            const tip = try json.integer(u64, try json.field(prepared.body, "tip_lamports"));
            result.expenditure.?.tokens_used = try std.math.add(u256, result.expenditure.?.tokens_used, tip);
        }
        if (self.backend == .starknet and prepared.body == .object and (prepared.body.object.contains("batch_version") or prepared.body.object.contains("batch_members"))) result = try self.backend.starknet.memberReceipt(prepared, result);
        return result;
    }
    pub fn delivered(self: *Factory, id: Hash, clock: Clock) !bool {
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        const result = switch (self.backend) {
            .sealevel => |*value| try value.delivered(id),
            .cosmos => |*value| blk: {
                const height = try value.queries.finalizedHeight();
                break :blk if (value.native) try value.queries.nativeDeliveredAt(value.mailbox, id, height) else try value.queries.wasmDeliveredAt(value.mailbox, id, height);
            },
            .radix => |*value| try value.chain.deliveredAt(id, try value.chain.provider.finalizedState()),
            .tron => |*value| try value.chain.delivered(id),
            .starknet => |*value| blk: {
                var pinned = value.chain;
                pinned.block = .{ .number = try value.chain.provider.height(value.reorg) };
                break :blk try pinned.delivered(id);
            },
            .aleo => |*value| try value.chain.delivered(id),
        };
        try checked(clock);
        return result;
    }
    /// Explicit finality contract for callers deciding durable completion.
    pub fn deliveredFinalized(self: *Factory, id: Hash, clock: Clock) !bool {
        return self.delivered(id, clock);
    }
    /// Positive consensus-bound expiry/supersession evidence. Receipt absence,
    /// pruning, RPC errors and local wall time never establish retirement.
    pub fn retirementProof(self: *Factory, prepared: *const types.Prepared, signed: *const types.Signed, clock: Clock) !?types.RetirementProof {
        if (prepared.authority.kind != .process) return null;
        return self.retirement(prepared, signed, null, clock);
    }
    /// Release a group nonce reservation only with positive configured-finality
    /// consumption evidence. This proof alone cannot retire an undelivered actor.
    pub fn starknetConsumedNonceProof(self: *Factory, prepared: *const types.Prepared, signed: *const types.Signed, clock: Clock) !?types.RetirementProof {
        return self.starknetNonceProof(prepared, signed, null, false, clock);
    }
    /// Rebind one group's consumption proof to an individual message's same-
    /// height mailbox absence, retaining its own intent/generation authority.
    pub fn starknetNonceRetirementAt(self: *Factory, prepared: *const types.Prepared, signed: *const types.Signed, consumed: types.RetirementProof, clock: Clock) !?types.RetirementProof {
        return self.starknetNonceProof(prepared, signed, consumed, true, clock);
    }
    fn starknetNonceProof(self: *Factory, prepared: *const types.Prepared, signed: *const types.Signed, at: ?types.RetirementProof, absent: bool, clock: Clock) !?types.RetirementProof {
        try self.checkAuthority(prepared.authority);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        if (self.backend != .starknet) return error.DestinationAuthorityMismatch;
        const result = try self.backend.starknet.nonceProof(prepared, signed, at, absent);
        try checked(clock);
        return result;
    }
    pub fn announcementRetirement(self: *Factory, prepared: *const types.Prepared, signed: *const types.Signed, announcement: objects.SignedAnnouncement, clock: Clock) !?types.RetirementProof {
        const context = prepared.authority;
        try self.checkAuthority(context);
        if (context.kind != .announcement or announcement.value.mailbox_domain != context.destination or !std.mem.eql(u8, &announcement.value.mailbox_address, &context.mailbox) or !std.mem.eql(u8, &announcement.value.digest(), &context.operation_id) or !std.mem.eql(u8, &try announcement.recover(), &announcement.value.validator)) return error.AnnouncementAuthorityMismatch;
        // Walletsolidity has no historical query/provenance field. Its latest
        // absence cannot establish an announcement absence at an expiry block.
        if (self.backend == .tron) return null;
        return self.retirement(prepared, signed, announcement, clock);
    }
    fn retirement(self: *Factory, prepared: *const types.Prepared, signed: *const types.Signed, announcement: ?objects.SignedAnnouncement, clock: Clock) !?types.RetirementProof {
        try self.checkAuthority(prepared.authority);
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        const json = @import("../../net/json_rpc.zig");
        var proof: types.RetirementProof = .{ .kind = prepared.authority.kind, .target = prepared.authority.target, .identity = signed.identity, .intent_digest = prepared.digest(), .generation = prepared.authority.generation, .reason = undefined, .finalized_height = 0, .boundary = 0, .observed = 0 };
        switch (self.backend) {
            .tron => |*value| {
                try value.validateSigned(prepared, signed);
                const block = try value.chain.provider.finalizedBlock();
                proof.boundary = try json.integer(u64, try json.field(prepared.body, "expiration_ms"));
                if (block.timestamp_ms < proof.boundary) return null;
                if (try value.chain.delivered(prepared.authority.operation_id)) return null;
                const again = try value.chain.provider.solidBlock(block.number);
                if (!std.mem.eql(u8, &again.id, &block.id)) return error.NoncanonicalTronReceipt;
                proof.reason = .tron_expired;
                proof.finalized_height = block.number;
                proof.finalized_block_hash = block.id;
                proof.observed = block.timestamp_ms;
            },
            .sealevel => |*value| {
                try value.validateSigned(prepared, signed);
                const client = value.chain.client;
                const old_commitment = client.commitment;
                const old_slot = client.minimum_slot;
                defer {
                    client.commitment = old_commitment;
                    client.minimum_slot = old_slot;
                }
                client.commitment = .finalized;
                client.minimum_slot = try client.slot();
                const height = try client.blockHeight();
                proof.boundary = try json.integer(u64, try json.field(prepared.body, "last_valid_block_height"));
                if (height <= proof.boundary) return null;
                if (announcement) |expected| {
                    var actual = try @import("../../sealevel/announcement.zig").locations(self.allocator, client, value.announce, &.{expected.value.validator});
                    defer actual.deinit();
                    for (actual.values[0]) |location| if (std.mem.eql(u8, location, expected.value.storage_location)) return null;
                } else if (try value.delivered(prepared.authority.operation_id)) return null;
                proof.reason = .svm_blockhash_expired;
                proof.finalized_height = height;
                proof.observed = height;
            },
            .radix => |*value| {
                _ = try value.validateSigned(prepared, signed);
                const height = try value.chain.provider.finalizedState();
                const ledger = try value.finalizedLedger(height);
                proof.boundary = try std.math.add(u64, try json.integer(u64, try json.field(prepared.body, "epoch")), 2);
                if (ledger.epoch < proof.boundary) return null;
                if (announcement) |expected| {
                    var actual = try value.chain.locationsAt(value.announce, &.{expected.value.validator}, height);
                    defer actual.deinit();
                    for (actual.values[0]) |location| if (std.mem.eql(u8, location, expected.value.storage_location)) return null;
                } else if (try value.chain.deliveredAt(prepared.authority.operation_id, height)) return null;
                proof.reason = .radix_epoch_expired;
                proof.finalized_height = height;
                proof.observed = ledger.epoch;
            },
            .cosmos => |*value| {
                try value.validateSigned(prepared, signed);
                const proto = @import("../../cosmos/proto.zig");
                const status = try value.transactions.rpc.status();
                if (status.catching_up) return error.CosmosNodeCatchingUp;
                const height = status.height -| value.transactions.config.confirmations;
                if (height == 0) return null;
                const request = try proto.queryString(self.allocator, value.transactions.signer_address);
                defer self.allocator.free(request);
                var response = try value.transactions.rpc.abciQuery(proto.paths.account, request, height, false);
                defer response.deinit();
                const account = try proto.BaseAccount.queryResponse(response.value);
                if (!std.mem.eql(u8, account.address, value.transactions.signer_address) or account.account_number != try json.integer(u64, try json.field(prepared.body, "account_number"))) return error.WrongCosmosAccount;
                const sequence = try json.integer(u64, try json.field(prepared.body, "sequence"));
                const body_text = try json.string(try json.field(prepared.body, "body"));
                const raw_body = try self.allocator.alloc(u8, body_text.len / 2);
                defer self.allocator.free(raw_body);
                const body = try @import("../../evm/codecs.zig").decodeHex(raw_body, body_text);
                const timeout = try proto.uintField(body, 3);
                if (account.sequence > sequence) {
                    proof.reason = .cosmos_sequence_superseded;
                    proof.boundary = sequence;
                    proof.observed = account.sequence;
                } else if (timeout != 0 and height > timeout) {
                    proof.reason = .cosmos_timeout_expired;
                    proof.boundary = timeout;
                    proof.observed = height;
                } else return null;
                if (announcement) |expected| {
                    var actual = if (value.native) try value.queries.nativeLocationsAt(value.mailbox, &.{expected.value.validator}, height) else try value.queries.wasmLocationsAt(value.announce, &.{expected.value.validator}, height);
                    defer actual.deinit();
                    for (actual.values[0]) |location| if (std.mem.eql(u8, location, expected.value.storage_location)) return null;
                } else if (if (value.native) try value.queries.nativeDeliveredAt(value.mailbox, prepared.authority.operation_id, height) else try value.queries.wasmDeliveredAt(value.mailbox, prepared.authority.operation_id, height)) return null;
                var block = try value.transactions.rpc.block(height);
                defer block.deinit();
                proof.finalized_height = height;
                proof.finalized_block_hash = try @import("../../cosmos/types.zig").hash(try json.string(try json.field(try json.field(block.value(), "block_id"), "hash")));
            },
            .starknet => |*value| {
                if (announcement) |expected| {
                    const target_address = try value.validateAnnouncementSigned(prepared, signed, expected.value.validator, expected.value.storage_location, expected.signature.bytes());
                    var consumed = try value.nonceProof(prepared, signed, null, false) orelse return null;
                    var pinned = value.chain;
                    pinned.block = .{ .number = consumed.finalized_height };
                    var locations = try pinned.announcedLocations(target_address, &.{expected.value.validator});
                    defer locations.deinit();
                    for (locations.values[0]) |location| if (std.mem.eql(u8, location, expected.value.storage_location)) return null;
                    const again = try value.chain.provider.header(.{ .number = consumed.finalized_height });
                    if (!std.mem.eql(u8, &again.hash.toBytes(), &consumed.finalized_block_hash.?)) return error.NoncanonicalStarknetReceipt;
                    consumed.absence_checked = true;
                    try checked(clock);
                    return consumed;
                }
                const result = try value.nonceProof(prepared, signed, null, true);
                try checked(clock);
                return result;
            },
            .aleo => return null,
        }
        try checked(clock);
        return proof;
    }
    pub fn isRecipientContract(self: *Factory, message: protocol.Message, clock: Clock) !bool {
        if (message.destination != self.resources.chain.domain) return error.DestinationAuthorityMismatch;
        var scope = try self.begin(clock);
        defer scope.finish();
        try self.ensureChain();
        // Rust providers deliberately return true on these protocols: their
        // execution/ISM path validates the actual recipient. Never invent a
        // deployment probe with different address semantics.
        const result = switch (self.backend) {
            .cosmos => |*value| if (value.native) true else try value.queries.wasmIsContract(message.recipient),
            .tron => |*value| try value.chain.provider.isContract(try evmAddress(message.recipient)),
            .sealevel, .radix, .starknet, .aleo => true,
        };
        try checked(clock);
        return result;
    }
    /// Stable public deployment+native-signer identity. Credential tokens,
    /// private keys and RPC URLs never contribute to this digest.
    pub fn identityContext(self: *Factory) !Hash {
        var state = std.crypto.hash.sha2.Sha256.init(.{});
        state.update("HYPERLANE_NATIVE_DESTINATION_CONTEXT_V1");
        hashPart(&state, @tagName(self.resources.chain.protocol));
        hashPart(&state, self.resources.chain.chain_id);
        var domain: [4]u8 = undefined;
        std.mem.writeInt(u32, &domain, self.resources.chain.domain, .big);
        state.update(&domain);
        state.update(&try self.mailbox());
        state.update(&try self.announcementTarget());
        switch (self.backend) {
            .sealevel => |value| {
                state.update(&value.signer.payer);
                state.update(&.{@intFromBool(value.identity != null)});
                if (value.identity) |identity| state.update(&identity);
            },
            .cosmos => |value| {
                state.update(&value.signer.public_key);
                hashPart(&state, value.transactions.signer_address);
            },
            .radix => |value| state.update(&value.signer.public_key),
            .tron => |value| state.update(&value.signer.address),
            .starknet => |value| {
                state.update(&value.account.toBytes());
                state.update(&value.signer.public_key.toBytes());
            },
            .aleo => |value| state.update(&value.signer.address),
        }
        var result: Hash = undefined;
        state.final(&result);
        return result;
    }
    pub fn contextFor(self: *Factory, authority: types.Authority) !Hash {
        try self.checkAuthority(authority);
        var state = std.crypto.hash.sha2.Sha256.init(.{});
        state.update(&try self.identityContext());
        var origin: [4]u8 = undefined;
        std.mem.writeInt(u32, &origin, authority.origin, .big);
        state.update(&origin);
        state.update(&.{@intFromEnum(authority.kind)});
        if (authority.origin_hook) |hook| state.update(&hook);
        if (authority.kind == .reveal) {
            state.update(&try self.revealTarget());
            state.update(&(self.ccs_digest orelse return error.MissingCcsSigner).address);
            hashPart(&state, self.resources.chain.connection.sealevel.ur_reveal.?.ccs_url);
        }
        var result: Hash = undefined;
        state.final(&result);
        return result;
    }
    /// Persist before the process Actor's final processed/pending batch. Replay
    /// of this public enqueue never creates another process transaction.
    pub fn onDelivered(self: *Factory, store: *@import("../store.zig").Store, message: protocol.Message, clock: Clock) !void {
        if (self.backend != .sealevel) return;
        const config = self.resources.chain.connection.sealevel.ur_reveal orelse return;
        const commit = @import("reveal.zig").Commit.message(config.program_id, message) orelse return;
        if (!self.options.enable_reveals) return error.RevealQueueDisabled;
        try checked(clock);
        const queue = @import("reveal_queue.zig");
        const route = try queue.routeId(message.destination, commit);
        const id = queue.operationId(route, 0, message.id());
        const authority = try self.authorityFor(message.origin, id, 0, .reveal);
        _ = try queue.enqueue(self.allocator, store, try self.contextFor(authority), self.reveal_boot, message, commit, .reveal);
    }
    pub fn recoverDuplicateCommit(self: *Factory, store: *@import("../store.zig").Store, message: protocol.Message, clock: Clock) !bool {
        if (self.backend != .sealevel or !self.options.enable_reveals) return false;
        const failure = self.svm_witness.failure orelse return false;
        if (failure.instruction != 2 or failure.code != 10) return false;
        const config = self.resources.chain.connection.sealevel.ur_reveal orelse return false;
        const commit = @import("reveal.zig").Commit.message(config.program_id, message) orelse return false;
        try checked(clock);
        const queue = @import("reveal_queue.zig");
        const route = try queue.routeId(message.destination, commit);
        const authority = try self.authorityFor(message.origin, queue.operationId(route, 0, message.id()), 0, .reveal);
        _ = try queue.enqueue(self.allocator, store, try self.contextFor(authority), self.reveal_boot, message, commit, .duplicate_close);
        return true;
    }
    pub fn tickReveal(self: *Factory, store: *@import("../store.zig").Store, clock: Clock, now: @import("operation.zig").Times) !usize {
        if (self.backend != .sealevel or !self.options.enable_reveals or self.resources.chain.connection.sealevel.ur_reveal == null) return 0;
        var scope = try self.begin(clock);
        defer scope.finish();
        // Reveal signing and CCS HTTP share this owner. Chain RPC clients use
        // their own native/Pool path; this transport is non-RPC here.
        var signer_scope = NonRpcScope.init(&self.resources.http);
        defer signer_scope.finish();
        try self.ensureChain();
        return @import("reveal_runner.zig").tick(self, store, clock, now);
    }
    fn cap(self: *Factory, comptime T: type, default: T) !T {
        return if (self.options.maximum_fee) |fee| std.math.cast(T, fee) orelse error.NativeFeeCapOutOfRange else default;
    }
    fn digestSign(context: *anyopaque, digest: Hash) ![65]u8 {
        const self: *Factory = @ptrCast(@alignCast(context));
        try checkHalt(self.active_halt);
        var signer_scope = NonRpcScope.init(self.signer_http);
        defer signer_scope.finish();
        return self.digest.?.signDigest(&digest);
    }
    const NonRpcScope = struct {
        owner: ?*@import("../../cloud/http.zig").HttpTransport,
        saved: ?@import("../../cloud/http.zig").RpcReadOwner,
        fn init(owner: ?*@import("../../cloud/http.zig").HttpTransport) NonRpcScope {
            var scope: NonRpcScope = .{ .owner = owner, .saved = null };
            if (owner) |value| {
                if (value.rpc_read_owner) |guard| {
                    scope.saved = .{ .deadline_ns = guard.deadline_ns, .halt = guard.halt, .retry_physical_timeout = guard.retry_physical_timeout };
                    value.rpc_read_owner.?.retry_physical_timeout = false;
                }
            }
            return scope;
        }
        fn finish(self: *NonRpcScope) void {
            if (self.owner) |owner| owner.rpc_read_owner = self.saved;
        }
    };
    fn readKey(context: *anyopaque, out: *Hash) !void {
        const self: *Factory = @ptrCast(@alignCast(context));
        try checkHalt(self.active_halt);
        out.* = self.key orelse return error.NativeKeyUnavailable;
    }
    fn edSign(context: *anyopaque, public_key: Hash, message: []const u8) ![64]u8 {
        const self: *Factory = @ptrCast(@alignCast(context));
        try checkHalt(self.active_halt);
        for ([_]?Hash{ self.key, self.identity_key }) |key| if (key) |seed| {
            const pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
            if (std.mem.eql(u8, &pair.public_key.toBytes(), &public_key)) return (try pair.sign(message, null)).toBytes();
        };
        return error.UnconfiguredSvmSigner;
    }
    fn starkSign(context: *anyopaque, digest: @import("../../starknet/codec.zig").Felt) !@import("../../starknet/crypto.zig").Signature {
        const self: *Factory = @ptrCast(@alignCast(context));
        try checkHalt(self.active_halt);
        return self.stark_signer.?.crypto.sign(self.stark_signer.?.secret, digest);
    }
    fn aleoAddress(self: *Factory, decoder: @import("../../aleo/events.zig").NativeDecoder) !Hash {
        var digits: [3][32]u8 = undefined;
        const limits = decoder.limits;
        var session = try @import("../../aleo/worker.zig").Session.spawn(self.allocator, &.{ decoder.executable, try std.fmt.bufPrint(&digits[0], "{d}", .{limits.memory_bytes}), try std.fmt.bufPrint(&digits[1], "{d}", .{limits.max_input_bytes}), try std.fmt.bufPrint(&digits[2], "{d}", .{limits.max_output_bytes}) }, limits);
        defer session.deinit();
        const config = try std.json.Stringify.valueAlloc(self.allocator, .{ .library = decoder.library, .network = decoder.network }, .{});
        defer self.allocator.free(config);
        self.allocator.free(try session.exchange(.init, config));
        const result = try session.exchange(.key_address, &self.key.?);
        defer self.allocator.free(result);
        if (result.len != 32) return error.InvalidAleoSignerAddress;
        return result[0..32].*;
    }
    /// Refresh borrowed cloud leases before every new signing operation.
    pub fn refresh(self: *Factory, credentials: signing.Credentials) !void {
        try self.bindSignerOwner(credentials);
        if (self.digest) |value| try value.refresh(credentials);
        if (self.ccs_digest) |value| try value.refresh(credentials);
    }
    fn bindSignerOwner(self: *Factory, credentials: signing.Credentials) !void {
        if (credentials.http_owner) |owner| {
            const actual = owner.interface();
            if (actual.context != credentials.transport.context or actual.send_fn != credentials.transport.send_fn) return error.SignerTransportOwnerMismatch;
            if (self.remote_signer and owner.native_curl == null and !self.options.allow_fixture_transport) return error.NativeSignerTransportRequired;
        } else if (self.remote_signer and !self.options.allow_fixture_transport) return error.NativeSignerTransportOwnerRequired;
        self.signer_http = credentials.http_owner;
    }
    pub fn deinit(self: *Factory) void {
        if (self.svm_oracle_http) |*owner| owner.deinit();
        for (self.metric_contexts[0..self.metric_initialized]) |*context| context.matcher.deinit();
        if (self.prover) |value| value.deinit();
        if (self.digest) |value| value.deinit();
        if (self.ccs_digest) |value| value.deinit();
        for (self.submission_svm[0..self.submission_initialized]) |*value| value.deinit();
        if (self.submission_svm.len > 0) self.allocator.free(self.submission_svm);
        if (self.stark_signer) |*value| value.deinit();
        if (self.stark_crypto) |*value| value.deinit();
        if (self.key) |*value| std.crypto.secureZero(u8, value);
        if (self.identity_key) |*value| std.crypto.secureZero(u8, value);
        self.arena.deinit();
        self.allocator.destroy(self);
    }
};
fn evmAddress(value: Hash) ![20]u8 {
    if (!std.mem.allEqual(u8, value[0..12], 0)) return error.InvalidEvmStyleAddress;
    return value[12..32].*;
}

fn padded(value: [20]u8) Hash {
    var full: Hash = .{0} ** 32;
    full[12..32].* = value;
    return full;
}

fn hashPart(state: *std.crypto.hash.sha2.Sha256, bytes: []const u8) void {
    var size: [8]u8 = undefined;
    std.mem.writeInt(u64, &size, bytes.len, .big);
    state.update(&size);
    state.update(bytes);
}
test "Native destination dispatcher declarations cover concrete retained chain clients" {
    std.testing.refAllDecls(Factory);
}

fn feeLevel(text: []const u8) !?@import("../../sealevel/transaction.zig").Level {
    if (std.ascii.eqlIgnoreCase(text, "recommended")) return null;
    inline for (std.meta.fields(@import("../../sealevel/transaction.zig").Level)) |field| if (std.ascii.eqlIgnoreCase(text, field.name)) return @enumFromInt(field.value);
    return error.InvalidHeliusFeeLevel;
}
const EmptyHistory = struct {
    pub fn leafIndex(_: *@This(), _: Hash) !?u32 {
        return null;
    }
    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return null;
    }
    pub fn fetchCheckpoint(_: *@This(), _: [20]u8, _: u32) !?objects.SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *@This(), _: [20]u8) !?u32 {
        return null;
    }
    pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.UnexpectedFixtureProof;
    }
};
test "Native destination metadata dispatcher rejects unconfigured origin before any network or credentials" {
    var factory: Factory = .{ .allocator = std.testing.allocator, .arena = .init(std.testing.allocator), .resources = undefined, .options = .{} };
    defer factory.arena.deinit();
    var origin: EmptyHistory = .{};
    try std.testing.expectError(error.MissingOriginAuthorityBinding, factory.metadata(&origin, .{0} ** 32, .{ .origin = 1 }, .{ .unix_ms = 0, .deadline_ns = 0 }));
    try std.testing.expect((try feeLevel("recommended")) == null);
    try std.testing.expectEqual(@import("../../sealevel/transaction.zig").Level.VeryHigh, (try feeLevel("veryhigh")).?);
}

test "Native destination scopes separate credential HTTP owner and restores job cancellation pointers" {
    const a = std.testing.allocator;
    const http = @import("../../cloud/http.zig");
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var resources: sources.Resources = .{ .environment = &environment, .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a) };
    defer resources.http.deinit();
    defer resources.arena.deinit();
    var secondary = http.HttpTransport.init(a);
    defer secondary.deinit();
    var prior = std.atomic.Value(bool).init(true);
    var current = std.atomic.Value(bool).init(false);
    secondary.cancel = &prior;
    secondary.timeout_ms = 20000;
    secondary.connect_timeout_ms = 10000;
    var factory: Factory = .{ .allocator = a, .arena = .init(a), .resources = &resources, .options = .{ .allow_fixture_transport = true }, .remote_signer = true, .backend = .{ .tron = undefined } };
    defer factory.arena.deinit();
    try factory.bindSignerOwner(.{ .transport = secondary.interface(), .http_owner = &secondary, .amz_date = "fixture" });
    try std.testing.expectError(error.SignerTransportOwnerMismatch, factory.bindSignerOwner(.{ .transport = secondary.interface(), .http_owner = &resources.http, .amz_date = "fixture" }));
    var scope = try factory.begin(.{ .unix_ms = 0, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + 200 * std.time.ns_per_ms, .cancel = &current });
    try std.testing.expect(secondary.cancel == &current);
    try std.testing.expect(secondary.timeout_ms <= 200 and secondary.connect_timeout_ms <= 200);
    scope.finish();
    try std.testing.expect(secondary.cancel == &prior);
    try std.testing.expectEqual(@as(u32, 20000), secondary.timeout_ms);
    try std.testing.expectEqual(@as(u32, 10000), secondary.connect_timeout_ms);
    try std.testing.expect(resources.http.cancel == null);
}

fn checkHalt(halt: ?*const std.atomic.Value(bool)) !void {
    if (halt) |flag| if (flag.load(.acquire)) return error.CheckpointEffectsHalted;
}
test "RPC timeout nonRPC nested owner scopes restore capability on error" {
    const http = @import("../../cloud/http.zig");
    var owner = http.HttpTransport.init(std.testing.allocator);
    defer owner.deinit();
    const deadline = (try http.rpcNowNs()) + std.time.ns_per_s;
    owner.rpc_read_owner = .{ .deadline_ns = deadline, .retry_physical_timeout = true };
    const ErrorPath = struct {
        fn fail(value: *http.HttpTransport) !void {
            var outer = Factory.NonRpcScope.init(value);
            defer outer.finish();
            try std.testing.expect(outer.saved.?.retry_physical_timeout);
            try std.testing.expect(!value.rpc_read_owner.?.retry_physical_timeout);
            var inner = Factory.NonRpcScope.init(value);
            defer inner.finish();
            try std.testing.expect(!inner.saved.?.retry_physical_timeout);
            return error.RequestDeadlineExceeded;
        }
    };
    try std.testing.expectError(error.RequestDeadlineExceeded, ErrorPath.fail(&owner));
    try std.testing.expect(owner.rpc_read_owner.?.retry_physical_timeout);
    try std.testing.expectEqual(deadline, owner.rpc_read_owner.?.deadline_ns);
}
test "RPC timeout Factory scope binds actual minimum deadline and restores separate credential owner" {
    const a = std.testing.allocator;
    const http = @import("../../cloud/http.zig");
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var resources: sources.Resources = .{ .environment = &environment, .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a) };
    defer resources.http.deinit();
    defer resources.arena.deinit();
    var credentials = http.HttpTransport.init(a);
    defer credentials.deinit();
    var factory: Factory = .{ .allocator = a, .arena = .init(a), .resources = &resources, .options = .{ .allow_fixture_transport = true }, .backend = .{ .tron = undefined }, .signer_http = &credentials };
    defer factory.arena.deinit();
    var cancel: std.atomic.Value(bool) = .init(false);
    var halt: std.atomic.Value(bool) = .init(false);
    const deadline = (try http.rpcNowNs()) + std.time.ns_per_s;
    {
        var scope = try factory.begin(.{ .unix_ms = 0, .deadline_ns = deadline, .cancel = &cancel, .halt = &halt });
        defer scope.finish();
        try std.testing.expectEqual(deadline, resources.rpc_deadline_ns.?);
        try std.testing.expectEqual(deadline, resources.http.rpc_read_owner.?.deadline_ns);
        try std.testing.expect(resources.http.rpc_read_owner.?.halt == &halt);
        try std.testing.expectEqual(deadline, credentials.rpc_read_owner.?.deadline_ns);
        try std.testing.expect(!credentials.rpc_read_owner.?.retry_physical_timeout);
    }
    try std.testing.expect(resources.rpc_deadline_ns == null and resources.http.rpc_read_owner == null);
    const inherited = deadline - 100 * std.time.ns_per_ms;
    resources.rpc_deadline_ns = inherited;
    resources.http.rpc_read_owner = .{ .deadline_ns = inherited, .halt = &halt };
    var scope = try factory.begin(.{ .unix_ms = 0, .deadline_ns = deadline, .cancel = &cancel });
    try std.testing.expectEqual(inherited, resources.rpc_deadline_ns.?);
    try std.testing.expectEqual(inherited, resources.http.rpc_read_owner.?.deadline_ns);
    try std.testing.expect(resources.http.rpc_read_owner.?.halt == &halt);
    scope.finish();
    try std.testing.expectEqual(inherited, resources.rpc_deadline_ns.?);
    try std.testing.expectEqual(inherited, resources.http.rpc_read_owner.?.deadline_ns);
    try std.testing.expect(credentials.rpc_read_owner == null and credentials.cancel == null);
}
test "native announcement halt is independent of job cancellation and rechecked immediately before every key effect" {
    const a = std.testing.allocator;
    var factory: Factory = .{ .allocator = a, .arena = .init(a), .resources = undefined, .options = .{ .allow_fixture_transport = true }, .backend = .{ .tron = undefined } };
    defer factory.arena.deinit();
    var halt = std.atomic.Value(bool).init(true);
    var cancel = std.atomic.Value(bool).init(false);
    const clock: Clock = .{ .unix_ms = 0, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + std.time.ns_per_s, .halt = &halt, .cancel = &cancel };
    try std.testing.expectError(error.CheckpointEffectsHalted, factory.begin(clock));
    try std.testing.expectError(error.CheckpointEffectsHalted, Factory.checked(clock));
    factory.active_halt = &halt;
    var key: Hash = .{0x55} ** 32;
    try std.testing.expectError(error.CheckpointEffectsHalted, Factory.readKey(&factory, &key));
    try std.testing.expectEqual(@as(Hash, .{0x55} ** 32), key);
    try std.testing.expectError(error.CheckpointEffectsHalted, Factory.digestSign(&factory, .{0} ** 32));
    try std.testing.expectError(error.CheckpointEffectsHalted, Factory.edSign(&factory, .{0} ** 32, "public"));
    try std.testing.expectError(error.CheckpointEffectsHalted, Factory.starkSign(&factory, .{ .value = 1 }));
    try std.testing.expect(!cancel.load(.acquire));
}

test "native metadata cache uses immutable metric rules across messages and preserves public signer context" {
    const a = std.testing.allocator;
    const mock = @import("../../cloud/testing.zig");
    const abi = @import("../../evm/codecs.zig");
    var routing: [32]u8 = .{0} ** 32;
    routing[31] = 1;
    var child: Hash = .{0} ** 32;
    child[12..32].* = .{5} ** 20;
    var null_type: [32]u8 = .{0} ** 32;
    null_type[31] = 6;
    const words = [_][]const u8{ &routing, &child, &null_type };
    var responses: [3][]u8 = undefined;
    var initialized: usize = 0;
    defer for (responses[0..initialized]) |response| a.free(response);
    for (words, &responses) |word, *response| {
        const hex = try abi.hexAlloc(a, word);
        defer a.free(hex);
        response.* = try std.json.Stringify.valueAlloc(a, .{ .constant_result = .{hex[2..]} }, .{});
        initialized += 1;
    }
    var network: mock.Mock = .{ .steps = &.{
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = responses[0] },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = responses[1] },
        .{ .method = .POST, .suffix = "/walletsolidity/triggerconstantcontract", .response = responses[2] },
    } };
    const endpoints = [_]@import("../../tron/rpc.zig").Endpoint{.{ .url = "https://fixture/walletsolidity" }};
    var provider = try @import("../../tron/provider.zig").Provider.init(a, network.transport(), .{ .rpc_urls = &endpoints, .wallet_urls = &endpoints, .wallet_solidity_urls = &endpoints });
    var chain: settings.Chain = undefined;
    chain.name = "native-cache-fixture";
    chain.domain = 2;
    chain.protocol = .tron;
    chain.chain_id = "1";
    chain.contracts = .{ .mailbox = .{0} ** 31 ++ .{1}, .merkle_tree_hook = .{0} ** 31 ++ .{2}, .interchain_gas_paymaster = .{0} ** 32, .validator_announce = .{0} ** 31 ++ .{3} };
    chain.connection = .{ .tron = .{ .wallet_urls = &.{}, .wallet_solidity_urls = &.{}, .fee_multiplier = null } };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var readers: sources.Resources = .{ .environment = &environment, .allocator = a, .arena = .init(a), .chain = chain, .options = .{ .curl_library = "unused" }, .clients = .{ .tron = &provider }, .http = @import("../../cloud/http.zig").HttpTransport.init(a) };
    defer readers.http.deinit();
    defer readers.arena.deinit();
    var cache = try contract_cache.CacheFor(Hash).Cache.init(a, .{});
    defer cache.deinit();
    const factory = try Factory.open(a, &readers, .{ .hex_key = .{0x11} ** 32 }, .{ .transport = network.transport(), .amz_date = "fixture" }, .{
        .allow_fixture_transport = true,
        .metadata_cache = &cache,
        .origin_bindings = &.{.{ .domain = 1, .hook = .{1} ** 32 }},
        .metric_app_contexts = &.{ .{ .name = "empty", .matching_list = &.{} }, .{ .name = "application", .matching_list = &.{.{ .origin_domain = .{ .values = &.{1} } }} } },
        .ism_cache_configs = &.{.{ .selector = .{ .app_context = "application" }, .module_types = &.{1}, .chains = null, .cache_policy = .ism_specific }},
    });
    defer factory.deinit();
    // Identity calls are covered separately; this fixture isolates contract cache.
    factory.chain_checked = true;
    var history: EmptyHistory = .{};
    const clock: Clock = .{ .unix_ms = 1000, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + std.time.ns_per_s };
    for ([_][]const u8{ "first", "second" }) |body| {
        const output = try factory.metadata(&history, .{0} ** 31 ++ .{9}, .{ .origin = 1, .destination = 2, .body = body }, clock);
        defer a.free(output);
        try std.testing.expectEqual(@as(usize, 0), output.len);
    }
    try std.testing.expectEqual(@as(usize, 3), network.index);
    try std.testing.expectEqualStrings("application", (try factory.appContext(.{ .origin = 1 })).?);
    try std.testing.expect((try factory.appContext(.{ .origin = 3 })) == null);
    try std.testing.expectEqual(@as(?[20]u8, factory.digest.?.address), provider.signer_address);
    try network.expectDone();
}
