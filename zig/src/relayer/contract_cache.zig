//! Bounded, typed contract-call caching. No receipt/finality/header fences,
//! full metadata, Merkle proofs, or signatures are accepted by this API.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const metadata = @import("metadata.zig");
const ccip = @import("ccip.zig");
const settings = @import("../settings/types.zig");
const Allocator = std.mem.Allocator;
const Hash = [32]u8;
const EvmAddress = [20]u8;

pub const default_ttl_ms: u64 = 120_000;
pub const default_ism_ttl_ms: u64 = 600_000;
pub const expiration_env = "HYP_CACHEDEFAULTEXPIRATIONSECONDS";
pub const CachePolicy = enum { message_specific, ism_specific };
pub const Context = struct { domain_name: []const u8, context_hash: Hash };
pub const Options = struct {
    enabled: bool = true,
    max_entries: usize = 1024,
    max_bytes: usize = 16 * 1024 * 1024,
    default_ttl_ms: u64 = default_ttl_ms,
    default_ism_ttl_ms: u64 = default_ism_ttl_ms,
    environment: ?*const std.process.EnvMap = null,
    observer: ?Observer = null,
};
pub const Stats = struct {
    entries: usize = 0,
    bytes: usize = 0,
    hits: usize = 0,
    misses: usize = 0,
    inserts: usize = 0,
    evictions: usize = 0,
    expirations: usize = 0,
    rejected: usize = 0,
};

/// Callbacks are serialized under the cache mutex. They must not re-enter Cache.
pub const Partition = enum { evm, native };
pub const Decision = enum { hit, miss, failure };
pub const MetricsSnapshot = struct {
    entries: u64 = 0,
    serialized_bytes: u64 = 0,
    expired: u64 = 0,
    size: u64 = 0,
};
pub const Observation = struct {
    chain: []const u8,
    method: ?[]const u8 = null,
    decision: ?Decision = null,
    snapshot: MetricsSnapshot,
    retired: bool = false,
};
pub const Observer = struct {
    context: *anyopaque,
    partition: Partition,
    notify_fn: *const fn (*anyopaque, Partition, Observation) void,
};

pub fn CacheFor(comptime ModuleAddress: type) type {
    if (ModuleAddress != [20]u8 and ModuleAddress != [32]u8) @compileError("contract cache module addresses must be [20]u8 or [32]u8");
    return struct {
        const Self = @This();
        pub const Address = ModuleAddress;
        pub const Route = struct { ism: Address, message: protocol.Message, policy: CachePolicy };
        pub const MembersQuery = struct { ism: Address, message: protocol.Message, validators: bool, policy: CachePolicy };
        pub const OffchainQuery = struct { ism: Address, message: protocol.Message };
        pub const Query = union(enum) {
            module_type: Address,
            route_query: Self.Route,
            members_query: Self.MembersQuery,
            recipient_ism: Hash,
            default_ism,
            offchain_lookup: Self.OffchainQuery,

            pub fn moduleType(ism: Address) Self.Query {
                return .{ .module_type = ism };
            }
            pub fn route(ism: Address, message: protocol.Message, policy: CachePolicy) Self.Query {
                return .{ .route_query = .{ .ism = ism, .message = message, .policy = policy } };
            }
            pub fn members(ism: Address, message: protocol.Message, validators: bool, policy: CachePolicy) Self.Query {
                return .{ .members_query = .{ .ism = ism, .message = message, .validators = validators, .policy = policy } };
            }
            pub fn recipientIsm(recipient: Hash) Self.Query {
                return .{ .recipient_ism = recipient };
            }
            pub fn defaultIsm() Self.Query {
                return .default_ism;
            }
            pub fn offchainLookup(ism: Address, message: protocol.Message) Self.Query {
                return .{ .offchain_lookup = .{ .ism = ism, .message = message } };
            }
        };

        pub const Value = union(enum) {
            module_type: metadata.ModuleType,
            address: Address,
            members: metadata.ModuleMembers(Address),
            validators: metadata.Members,
            offchain_lookup: ccip.Lookup,

            pub fn deinit(self: *Self.Value, allocator: Allocator) void {
                switch (self.*) {
                    .members => |value| allocator.free(value.addresses),
                    .validators => |value| allocator.free(value.addresses),
                    .offchain_lookup => |*value| value.deinit(),
                    else => {},
                }
                self.* = undefined;
            }

            fn clone(self: *const Self.Value, allocator: Allocator) !Self.Value {
                return switch (self.*) {
                    .module_type => |value| .{ .module_type = value },
                    .address => |value| .{ .address = value },
                    .members => |value| .{ .members = .{ .addresses = try allocator.dupe(Address, value.addresses), .threshold = value.threshold } },
                    .validators => |value| .{ .validators = .{ .addresses = try allocator.dupe(EvmAddress, value.addresses), .threshold = value.threshold } },
                    .offchain_lookup => |value| .{ .offchain_lookup = try cloneLookup(allocator, value) },
                };
            }

            fn cost(self: *const Self.Value) usize {
                return switch (self.*) {
                    .module_type => 1,
                    .address => @sizeOf(Address),
                    .members => |value| 1 + value.addresses.len * @sizeOf(Address),
                    .validators => |value| 1 + value.addresses.len * @sizeOf(EvmAddress),
                    .offchain_lookup => |value| value.encoded.len + value.urls.len * @sizeOf([]const u8),
                };
            }
        };

        const Key = struct {
            kind: std.meta.Tag(Self.Query),
            context_hash: Hash,
            domain_name: []const u8,
            ism: Address = @splat(0),
            subject: Hash = @splat(0),
            origin: ?u32 = null,
            validators: bool = false,

            fn init(allocator: Allocator, context: Context, query: Self.Query) !Key {
                var result: Key = .{ .kind = std.meta.activeTag(query), .context_hash = context.context_hash, .domain_name = try allocator.dupe(u8, context.domain_name) };
                errdefer allocator.free(result.domain_name);
                switch (query) {
                    .module_type => |ism| result.ism = ism,
                    .route_query => |route| {
                        result.ism = route.ism;
                        switch (route.policy) {
                            .message_specific => result.subject = route.message.id(),
                            .ism_specific => result.origin = route.message.origin,
                        }
                    },
                    .members_query => |members| {
                        result.ism = members.ism;
                        result.validators = members.validators;
                        if (members.policy == .message_specific) result.subject = members.message.id();
                    },
                    .recipient_ism => |recipient| result.subject = recipient,
                    .default_ism => {},
                    .offchain_lookup => |lookup| {
                        result.ism = lookup.ism;
                        result.subject = lookup.message.id();
                    },
                }
                return result;
            }

            fn deinit(self: *Key, allocator: Allocator) void {
                allocator.free(self.domain_name);
                self.domain_name = &.{};
            }

            fn eql(self: *const Key, other: *const Key) bool {
                return self.kind == other.kind and
                    std.mem.eql(u8, &self.context_hash, &other.context_hash) and
                    std.mem.eql(u8, self.domain_name, other.domain_name) and
                    std.mem.eql(u8, &self.ism, &other.ism) and
                    std.mem.eql(u8, &self.subject, &other.subject) and
                    self.origin == other.origin and
                    self.validators == other.validators;
            }

            fn cost(self: *const Key) usize {
                return self.domain_name.len + @sizeOf(Hash) + @sizeOf(Address) + @sizeOf(Hash) + @sizeOf(?u32) + 2;
            }
        };

        const Entry = struct {
            key: Key,
            value: ?Self.Value = null,
            expires_at_ms: u64 = 0,
            touched: u64 = 0,
            cost: usize = 0,
            serialized_bytes: u64 = 0,
        };

        pub const Cache = struct {
            allocator: Allocator,
            entries: []Entry,
            max_bytes: usize,
            default_ttl_ms: u64,
            default_ism_ttl_ms: u64,
            used_bytes: usize = 0,
            sequence: u64 = 0,
            mutex: std.Thread.Mutex = .{},
            stats: Stats = .{},
            observer: ?Observer = null,
            metric_snapshot: MetricsSnapshot = .{},
            metrics_active: bool = false,

            fn method(query: Self.Query) ?[]const u8 {
                return switch (query) {
                    .module_type => "module_type",
                    .route_query => "route",
                    .members_query => |v| if (v.validators) "validators_and_threshold" else "modules_and_threshold",
                    .recipient_ism => "recipient_ism",
                    .offchain_lookup => "get_offchain_verify_info",
                    .default_ism => null,
                };
            }

            fn observe(self: *Self.Cache, context: Context, query: Self.Query, decision: ?Decision) void {
                const observer = self.observer orelse return;
                const name = method(query) orelse return;
                self.metrics_active = true;
                observer.notify_fn(observer.context, observer.partition, .{ .chain = context.domain_name, .method = name, .decision = decision, .snapshot = self.metric_snapshot });
            }

            // Source weighs serialized key + value, not retained native memory.
            // The typed Zig representation retains context and address width.
            fn serializedWeight(key: Key, value: Self.Value) u64 {
                var buffer: [256]u8 = undefined;
                var counter = std.Io.Writer.Discarding.init(&buffer);
                std.json.Stringify.value(key, .{}, &counter.writer) catch unreachable;
                switch (value) {
                    .module_type => |v| std.json.Stringify.value(v, .{}, &counter.writer) catch unreachable,
                    .address => |v| std.json.Stringify.value(v, .{}, &counter.writer) catch unreachable,
                    .members => |v| std.json.Stringify.value(v, .{}, &counter.writer) catch unreachable,
                    .validators => |v| std.json.Stringify.value(v, .{}, &counter.writer) catch unreachable,
                    .offchain_lookup => |v| std.json.Stringify.value(.{ .sender = v.sender, .urls = v.urls, .call_data = v.call_data, .callback_function = v.callback_function, .extra_data = v.extra_data }, .{}, &counter.writer) catch unreachable,
                }
                return counter.fullCount();
            }

            fn removed(self: *Self.Cache, entry: *const Entry, expired: bool) void {
                if (entry.key.kind == .default_ism) return;
                if (expired) self.metric_snapshot.expired +|= 1 else self.metric_snapshot.size +|= 1;
            }

            pub fn init(allocator: Allocator, options: Options) !Self.Cache {
                if (options.max_entries == 0 or options.max_bytes == 0) return error.InvalidContractCacheLimit;
                var default_ttl = options.default_ttl_ms;
                if (options.environment) |environment| {
                    if (environment.get(expiration_env)) |configured| {
                        default_ttl = std.fmt.parseInt(u64, configured, 10) catch default_ttl_ms;
                        default_ttl = std.math.mul(u64, default_ttl, 1000) catch default_ttl_ms;
                    }
                }
                const entries = if (options.enabled) try allocator.alloc(Entry, options.max_entries) else try allocator.alloc(Entry, 0);
                for (entries) |*entry| entry.* = .{ .key = .{ .kind = .default_ism, .context_hash = @splat(0), .domain_name = &.{} } };
                return .{ .allocator = allocator, .entries = entries, .max_bytes = options.max_bytes, .default_ttl_ms = default_ttl, .default_ism_ttl_ms = options.default_ism_ttl_ms, .observer = options.observer };
            }

            pub fn deinit(self: *Self.Cache) void {
                for (self.entries) |*entry| self.clear(entry);
                if (self.metrics_active) if (self.observer) |observer| {
                    observer.notify_fn(observer.context, observer.partition, .{ .chain = "", .snapshot = self.metric_snapshot, .retired = true });
                };
                self.allocator.free(self.entries);
                self.* = undefined;
            }

            fn clear(self: *Self.Cache, entry: *Entry) void {
                if (entry.value) |*value| {
                    if (entry.key.kind != .default_ism) {
                        self.metric_snapshot.entries -= 1;
                        self.metric_snapshot.serialized_bytes -= entry.serialized_bytes;
                    }
                    value.deinit(self.allocator);
                }
                entry.key.deinit(self.allocator);
                entry.* = .{ .key = .{ .kind = .default_ism, .context_hash = @splat(0), .domain_name = &.{} } };
            }

            fn ttl(self: *const Self.Cache, kind: std.meta.Tag(Self.Query)) u64 {
                return if (kind == .default_ism) self.default_ism_ttl_ms else self.default_ttl_ms;
            }

            fn find(self: *Self.Cache, key: *const Key, now_ms: u64) ?*Entry {
                for (self.entries) |*entry| {
                    if (entry.value != null and entry.key.eql(key)) {
                        if (now_ms >= entry.expires_at_ms) {
                            self.used_bytes -= entry.cost;
                            self.stats.expirations += 1;
                            self.removed(entry, true);
                            self.clear(entry);
                            continue;
                        }
                        return entry;
                    }
                }
                return null;
            }

            pub fn get(self: *Self.Cache, context: Context, query: Self.Query, now_ms: u64) !?Self.Value {
                return self.getAlloc(self.allocator, context, query, now_ms);
            }

            pub fn getAlloc(self: *Self.Cache, output_allocator: Allocator, context: Context, query: Self.Query, now_ms: u64) !?Self.Value {
                if (self.entries.len == 0) return null;
                var key = Key.init(self.allocator, context, query) catch |err| {
                    self.mutex.lock();
                    defer self.mutex.unlock();
                    self.stats.misses += 1;
                    self.observe(context, query, .failure);
                    return err;
                };
                defer key.deinit(self.allocator);
                self.mutex.lock();
                defer self.mutex.unlock();
                const entry = self.find(&key, now_ms) orelse {
                    self.stats.misses += 1;
                    self.observe(context, query, .miss);
                    return null;
                };
                self.sequence +|= 1;
                entry.touched = self.sequence;
                const result = entry.value.?.clone(output_allocator) catch |err| {
                    self.stats.misses += 1;
                    self.observe(context, query, .failure);
                    return err;
                };
                self.stats.hits += 1;
                self.observe(context, query, .hit);
                return result;
            }

            pub fn put(self: *Self.Cache, context: Context, query: Self.Query, value: *const Self.Value, now_ms: u64) !bool {
                if (self.entries.len == 0) return false;
                self.mutex.lock();
                defer self.mutex.unlock();
                defer self.observe(context, query, null);
                if (!compatible(query, value.*)) return error.ContractCacheValueMismatch;
                var key = try Key.init(self.allocator, context, query);
                var own_key = true;
                defer if (own_key) key.deinit(self.allocator);
                var cloned = try value.clone(self.allocator);
                var own_cloned = true;
                defer if (own_cloned) cloned.deinit(self.allocator);
                const entry_cost = key.cost() + cloned.cost();
                const weight = if (self.observer != null and method(query) != null) serializedWeight(key, cloned) else 0;
                if (entry_cost > self.max_bytes) {
                    self.stats.rejected += 1;
                    return false;
                }
                if (self.find(&key, now_ms)) |entry| {
                    while (self.used_bytes - entry.cost + entry_cost > self.max_bytes) {
                        const victim = self.oldestExcept(entry) orelse {
                            self.stats.rejected += 1;
                            return false;
                        };
                        self.used_bytes -= victim.cost;
                        self.stats.evictions += 1;
                        self.removed(victim, false);
                        self.clear(victim);
                    }
                    self.used_bytes -= entry.cost;
                    if (entry.key.kind != .default_ism) self.metric_snapshot.serialized_bytes -= entry.serialized_bytes;
                    entry.value.?.deinit(self.allocator);
                    entry.value = cloned;
                    own_cloned = false;
                    entry.cost = entry_cost;
                    entry.serialized_bytes = weight;
                    if (entry.key.kind != .default_ism) self.metric_snapshot.serialized_bytes += weight;
                    entry.expires_at_ms = now_ms +| self.ttl(key.kind);
                    self.sequence +|= 1;
                    entry.touched = self.sequence;
                    self.used_bytes += entry_cost;
                    self.stats.inserts += 1;
                    key.deinit(self.allocator);
                    own_key = false;
                    return true;
                }
                while (self.used_bytes + entry_cost > self.max_bytes) {
                    const victim = self.oldest() orelse {
                        self.stats.rejected += 1;
                        return false;
                    };
                    self.used_bytes -= victim.cost;
                    self.stats.evictions += 1;
                    self.removed(victim, false);
                    self.clear(victim);
                }
                var destination: ?*Entry = null;
                for (self.entries) |*entry| {
                    if (entry.value == null) {
                        destination = entry;
                        break;
                    }
                }
                if (destination == null) {
                    const victim = self.oldest() orelse {
                        self.stats.rejected += 1;
                        return false;
                    };
                    self.used_bytes -= victim.cost;
                    self.stats.evictions += 1;
                    self.removed(victim, false);
                    self.clear(victim);
                    destination = victim;
                }
                destination.?.key = key;
                own_key = false;
                destination.?.value = cloned;
                own_cloned = false;
                destination.?.cost = entry_cost;
                destination.?.serialized_bytes = weight;
                if (key.kind != .default_ism) {
                    self.metric_snapshot.entries += 1;
                    self.metric_snapshot.serialized_bytes += weight;
                }
                destination.?.expires_at_ms = now_ms +| self.ttl(key.kind);
                self.sequence +|= 1;
                destination.?.touched = self.sequence;
                self.used_bytes += entry_cost;
                self.stats.inserts += 1;
                return true;
            }

            fn oldest(self: *Self.Cache) ?*Entry {
                var result: ?*Entry = null;
                for (self.entries) |*entry| {
                    if (entry.value == null) continue;
                    if (result == null or entry.touched < result.?.touched) result = entry;
                }
                return result;
            }

            fn oldestExcept(self: *Self.Cache, excluded: *Entry) ?*Entry {
                var result: ?*Entry = null;
                for (self.entries) |*entry| {
                    if (entry == excluded or entry.value == null) continue;
                    if (result == null or entry.touched < result.?.touched) result = entry;
                }
                return result;
            }

            pub fn snapshot(self: *Self.Cache) Stats {
                self.mutex.lock();
                defer self.mutex.unlock();
                var result = self.stats;
                result.entries = 0;
                result.bytes = self.used_bytes;
                for (self.entries) |entry| if (entry.value != null) {
                    result.entries += 1;
                };
                return result;
            }
        };

        fn compatible(query: Self.Query, value: Self.Value) bool {
            return switch (query) {
                .module_type => value == .module_type,
                .route_query, .recipient_ism, .default_ism => value == .address,
                .members_query => |members| if (members.validators) value == .validators else value == .members,
                .offchain_lookup => value == .offchain_lookup,
            };
        }

        pub const DefaultIsmFetch = struct {
            context: *anyopaque,
            get_fn: *const fn (*anyopaque, u64) anyerror!Address,
            /// Same clock domain as the lookup timestamp. Source starts the
            /// 600-second TTL after a successful RPC, not before it begins.
            now_ms_fn: ?*const fn (*anyopaque) anyerror!u64 = null,

            pub fn get(self: Self.DefaultIsmFetch, now_ms: u64) !Address {
                return self.get_fn(self.context, now_ms);
            }
        };

        pub const Classifier = struct {
            cache: *Self.Cache,
            context: Context,
            default_ism: Self.DefaultIsmFetch,
            configs: []const settings.IsmCache,

            pub fn classify(self: *const Self.Classifier, root_ism: Address, domain_name: []const u8, module_type: metadata.ModuleType, app_context: ?[]const u8, now_ms: u64) !CachePolicy {
                for (self.configs) |config| {
                    const selected = switch (config.selector) {
                        .default_ism => blk: {
                            const default_ism = defaultIsmFor(Address, self.cache, self.context, self.default_ism, now_ms) catch |err| {
                                if (metadata.hardFailure(err)) return err;
                                continue;
                            };
                            break :blk std.mem.eql(u8, &root_ism, &default_ism);
                        },
                        .app_context => |expected| app_context != null and std.mem.eql(u8, expected, app_context.?),
                    };
                    if (!selected or !matchesChain(config.chains, domain_name) or !matchesModule(config.module_types, module_type)) continue;
                    return switch (config.cache_policy) {
                        .message_specific => .message_specific,
                        .ism_specific => .ism_specific,
                    };
                }
                return .message_specific;
            }
        };
    };
}

fn cloneLookup(allocator: Allocator, value: ccip.Lookup) !ccip.Lookup {
    const encoded = try allocator.dupe(u8, value.encoded);
    errdefer allocator.free(encoded);
    const urls = try allocator.alloc([]const u8, value.urls.len);
    errdefer allocator.free(urls);
    for (urls, value.urls) |*dest, source| dest.* = try cloneEncodedSlice(encoded, value.encoded, source);
    return .{
        .allocator = allocator,
        .encoded = encoded,
        .sender = value.sender,
        .urls = urls,
        .call_data = try cloneEncodedSlice(encoded, value.encoded, value.call_data),
        .callback_function = value.callback_function,
        .extra_data = try cloneEncodedSlice(encoded, value.encoded, value.extra_data),
    };
}

fn cloneEncodedSlice(encoded: []u8, previous: []const u8, source: []const u8) ![]const u8 {
    const start = @intFromPtr(previous.ptr);
    const source_start = @intFromPtr(source.ptr);
    if (source_start < start) return error.InvalidOffchainLookup;
    const offset = source_start - start;
    if (offset > previous.len or source.len > previous.len - offset) return error.InvalidOffchainLookup;
    return encoded[offset..][0..source.len];
}

pub fn defaultIsmFor(comptime ModuleAddress: type, cache: *CacheFor(ModuleAddress).Cache, context: Context, fetch: CacheFor(ModuleAddress).DefaultIsmFetch, now_ms: u64) !ModuleAddress {
    if (try cache.get(context, .default_ism, now_ms)) |cached| {
        var value = cached;
        defer value.deinit(cache.allocator);
        return value.address;
    }
    const fetched = try fetch.get(now_ms);
    const inserted_ms = if (fetch.now_ms_fn) |clock| clock(fetch.context) catch now_ms else now_ms;
    _ = try cache.put(context, .default_ism, &.{ .address = fetched }, inserted_ms);
    return fetched;
}

pub fn defaultIsm(cache: *Cache, context: Context, fetch: DefaultIsmFetch, now_ms: u64) !EvmAddress {
    return defaultIsmFor(EvmAddress, cache, context, fetch, now_ms);
}

fn matchesChain(chains: ?[]const []const u8, domain_name: []const u8) bool {
    const configured = chains orelse return true;
    for (configured) |chain| if (std.mem.eql(u8, chain, domain_name)) return true;
    return false;
}

fn matchesModule(module_types: []const u8, module_type: metadata.ModuleType) bool {
    for (module_types) |configured| if (configured == @intFromEnum(module_type)) return true;
    return false;
}

pub const Cache = CacheFor(EvmAddress).Cache;
pub const Query = CacheFor(EvmAddress).Query;
pub const Value = CacheFor(EvmAddress).Value;
pub const Route = CacheFor(EvmAddress).Route;
pub const MembersQuery = CacheFor(EvmAddress).MembersQuery;
pub const OffchainQuery = CacheFor(EvmAddress).OffchainQuery;
pub const DefaultIsmFetch = CacheFor(EvmAddress).DefaultIsmFetch;
pub const Classifier = CacheFor(EvmAddress).Classifier;
