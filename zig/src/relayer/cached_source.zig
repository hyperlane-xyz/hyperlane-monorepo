//! Generic metadata Source wrapper. Only public contract data is cached;
//! verification, estimation, proofs, headers, canonical data, and CCIP HTTP
//! metadata always bypass this cache. No singleflight/coalescing is implied.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const metadata = @import("metadata.zig");
const contract = @import("contract_cache.zig");
const ccip = @import("ccip.zig");
const quorum = @import("quorum.zig");
const storage = @import("../storage/root.zig");
const settings = @import("../settings/types.zig");
const Allocator = std.mem.Allocator;
const Hash = [32]u8;
const Address20 = [20]u8;

pub fn CachedSource(comptime Underlying: type) type {
    return struct {
        const Self = @This();
        pub const ModuleAddress = if (@hasDecl(Underlying, "ModuleAddress")) Underlying.ModuleAddress else Address20;
        pub const Family = contract.CacheFor(ModuleAddress);
        pub const DefaultIsmFetch = Family.DefaultIsmFetch;
        pub const OwnedDefault = struct {
            fetch: DefaultIsmFetch,
            context: ?*anyopaque = null,
            deinit_fn: ?*const fn (*anyopaque, Allocator) void = null,

            fn deinit(self: *OwnedDefault, allocator: Allocator) void {
                if (self.deinit_fn) |deinit_fn| deinit_fn(self.context.?, allocator);
            }
        };
        pub const DefaultIsmFork = struct {
            context: *anyopaque,
            fork_fn: *const fn (*anyopaque, Allocator, *const std.atomic.Value(bool)) anyerror!OwnedDefault,
        };
        pub const DefaultClock = struct {
            context: *anyopaque,
            now_ms_fn: *const fn (*anyopaque) anyerror!u64,
        };
        pub const Options = struct {
            context: contract.Context,
            configs: []const settings.IsmCache = &.{},
            default_ism_cache: ?*Family.Cache = null,
            default_ism: ?DefaultIsmFetch = null,
            default_ism_fork: ?DefaultIsmFork = null,
            default_ism_now: ?DefaultClock = null,
        };

        allocator: Allocator,
        source: *Underlying,
        cache: *Family.Cache,
        options: Options,
        owned_default: ?OwnedDefault = null,
        owned_app_context: ?[]u8 = null,
        root_ism: ModuleAddress = @splat(0),
        app_context: ?[]const u8 = null,
        now_ms: u64 = 0,

        pub const parallel_quorum = Underlying.parallel_quorum;
        pub const parallel_latest = Underlying.parallel_latest;

        /// Borrows the underlying pointer. It must outlive this wrapper.
        pub fn initBorrowed(allocator: Allocator, source: *Underlying, cache: *Family.Cache, options: Options) Self {
            return .{ .allocator = allocator, .source = source, .cache = cache, .options = options };
        }

        /// Takes one underlying fork returned by Underlying.fork. The caller
        /// relinquishes it; this wrapper destroys it exactly once after jobs drain.
        fn initOwnedFork(allocator: Allocator, source: *Underlying, cache: *Family.Cache, options: Options) Self {
            return initBorrowed(allocator, source, cache, options);
        }

        pub fn fork(self: *Self, allocator: Allocator, cancel: *const std.atomic.Value(bool)) !*Self {
            const result = try allocator.create(Self);
            errdefer allocator.destroy(result);
            const source = try self.source.fork(allocator, cancel);
            errdefer source.deinitFork();
            var options = self.options;
            var owned: ?OwnedDefault = null;
            errdefer if (owned) |*value| value.deinit(allocator);
            if (!@hasDecl(Underlying, "defaultIsm") and options.default_ism != null and self.needsDefaultContext()) {
                const factory = options.default_ism_fork orelse return error.DefaultIsmForkNotConfigured;
                owned = try factory.fork_fn(factory.context, allocator, cancel);
                options.default_ism = owned.?.fetch;
            }
            const app_context = if (self.app_context) |text| try allocator.dupe(u8, text) else null;
            errdefer if (app_context) |text| allocator.free(text);
            result.* = initOwnedFork(allocator, source, self.cache, options);
            result.owned_default = owned;
            result.owned_app_context = app_context;
            result.root_ism = self.root_ism;
            result.app_context = app_context;
            result.now_ms = self.now_ms;
            return result;
        }

        pub fn deinitFork(self: *Self) void {
            const allocator = self.allocator;
            self.source.deinitFork();
            if (self.owned_default) |*owned| owned.deinit(allocator);
            if (self.owned_app_context) |text| allocator.free(text);
            allocator.destroy(self);
        }

        pub fn setMessage(self: *Self, root_ism: ModuleAddress, app_context: ?[]const u8, now_ms: u64) void {
            self.root_ism = root_ism;
            self.app_context = app_context;
            self.now_ms = now_ms;
        }

        pub fn beginPass(self: *Self, cancel: *const std.atomic.Value(bool)) !void {
            if (@hasDecl(Underlying, "beginPass")) return self.source.beginPass(cancel);
        }

        pub fn setMetadataParent(self: *Self, link: ?@import("metadata_parallel.zig").CancelLink) void {
            if (@hasDecl(Underlying, "setMetadataParent")) self.source.setMetadataParent(link);
        }

        pub fn endPass(self: *Self, failure: ?anyerror) void {
            if (@hasDecl(Underlying, "endPass")) self.source.endPass(failure);
        }

        fn underlyingDefault(context: *anyopaque, _: u64) !ModuleAddress {
            const self: *Self = @ptrCast(@alignCast(context));
            return self.source.defaultIsm();
        }

        fn defaultNow(context: *anyopaque) !u64 {
            const self: *Self = @ptrCast(@alignCast(context));
            if (@hasDecl(Underlying, "defaultIsmNow")) return self.source.defaultIsmNow();
            const clock = self.options.default_ism_now orelse return error.DefaultIsmClockUnavailable;
            return clock.now_ms_fn(clock.context);
        }

        fn defaultFetch(self: *Self) !DefaultIsmFetch {
            if (@hasDecl(Underlying, "defaultIsm")) return .{ .context = self, .get_fn = underlyingDefault, .now_ms_fn = defaultNow };
            return self.options.default_ism orelse error.DefaultIsmNotConfigured;
        }

        fn defaultCache(self: *Self) *Family.Cache {
            return self.options.default_ism_cache orelse self.cache;
        }

        pub fn defaultIsm(self: *Self) !ModuleAddress {
            return contract.defaultIsmFor(ModuleAddress, self.defaultCache(), self.options.context, try self.defaultFetch(), self.now_ms);
        }

        fn needsDefaultContext(self: *const Self) bool {
            for (self.options.configs) |config| if (config.selector == .default_ism) return true;
            return false;
        }

        pub fn appContext(self: *Self) !?[]const u8 {
            if (self.app_context) |configured| return configured;
            if (self.options.default_ism_cache == null and !self.needsDefaultContext()) return null;
            const default = self.defaultIsm() catch |err| {
                if (metadata.hardFailure(err)) return err;
                return null;
            };
            if (std.mem.eql(u8, &self.root_ism, &default)) return "default_ism";
            return null;
        }

        fn unconfiguredDefault(_: *anyopaque, _: u64) !ModuleAddress {
            return error.DefaultIsmNotConfigured;
        }

        fn policy(self: *Self, module_type: metadata.ModuleType) !contract.CachePolicy {
            if (self.options.configs.len == 0) return .message_specific;
            const app_context = try self.appContext();
            const default_fetch = self.defaultFetch() catch |err| fallback: {
                if (err != error.DefaultIsmNotConfigured) return err;
                break :fallback DefaultIsmFetch{ .context = self, .get_fn = unconfiguredDefault };
            };
            const classifier: Family.Classifier = .{
                .cache = self.defaultCache(),
                .context = self.options.context,
                .default_ism = default_fetch,
                .configs = self.options.configs,
            };
            return classifier.classify(self.root_ism, self.options.context.domain_name, module_type, app_context, self.now_ms);
        }

        pub fn moduleType(self: *Self, address: ModuleAddress) !metadata.ModuleType {
            if (try self.cache.get(self.options.context, .moduleType(address), self.now_ms)) |cached| {
                var value = cached;
                defer value.deinit(self.cache.allocator);
                return value.module_type;
            }
            const result = try self.source.moduleType(address);
            _ = try self.cache.put(self.options.context, .moduleType(address), &.{ .module_type = result }, self.now_ms);
            return result;
        }

        pub fn route(self: *Self, address: ModuleAddress, message: protocol.Message) !ModuleAddress {
            const cache_policy = try self.policy(.routing);
            const query = Family.Query.route(address, message, cache_policy);
            if (try self.cache.get(self.options.context, query, self.now_ms)) |cached| {
                var value = cached;
                defer value.deinit(self.cache.allocator);
                return value.address;
            }
            const result = try self.source.route(address, message);
            _ = try self.cache.put(self.options.context, query, &.{ .address = result }, self.now_ms);
            return result;
        }

        fn MemberResult(comptime validators: bool) type {
            return anyerror!metadata.ModuleMembers(if (validators) Address20 else ModuleAddress);
        }

        pub fn members(self: *Self, address: ModuleAddress, message: protocol.Message, comptime validators: bool) MemberResult(validators) {
            const module_type = try self.moduleType(address);
            const cache_policy = try self.policy(module_type);
            const query = Family.Query.members(address, message, validators, cache_policy);
            if (try self.cache.getAlloc(self.allocator, self.options.context, query, self.now_ms)) |cached| {
                const value = cached;
                if (validators) return value.validators;
                return value.members;
            }
            const result = try self.source.members(address, message, validators);
            errdefer self.allocator.free(result.addresses);
            if (validators) {
                _ = try self.cache.put(self.options.context, query, &.{ .validators = result }, self.now_ms);
            } else {
                _ = try self.cache.put(self.options.context, query, &.{ .members = result }, self.now_ms);
            }
            return result;
        }

        pub fn verify(self: *Self, address: ModuleAddress, message: protocol.Message, bytes: []const u8) !u256 {
            return self.source.verify(address, message, bytes);
        }

        pub fn verifyCandidate(self: *Self, address: ModuleAddress, message: protocol.Message, bytes: []const u8) !metadata.Verification {
            if (@hasDecl(Underlying, "verifyCandidate")) return self.source.verifyCandidate(address, message, bytes);
            return .{ .valid = true, .cost = try self.source.verify(address, message, bytes) };
        }

        pub fn ccipMetadata(self: *Self, address: ModuleAddress, message: protocol.Message) ![]u8 {
            return self.source.ccipMetadata(address, message);
        }

        pub fn compositeMetadata(self: *Self, address: ModuleAddress, message: protocol.Message) ![]u8 {
            if (@hasDecl(Underlying, "compositeMetadata")) return self.source.compositeMetadata(address, message);
            return error.UnsupportedIsmType;
        }

        pub fn offchainLookup(self: *Self, address: ModuleAddress, message: protocol.Message) !ccip.Lookup {
            const Fetch = struct {
                source: *Underlying,
                fn get(context: *anyopaque, ism: ModuleAddress, msg: protocol.Message) !ccip.Lookup {
                    const underlying: *Underlying = @ptrCast(@alignCast(context));
                    return underlying.offchainLookup(ism, msg);
                }
            };
            return offchainLookupForAlloc(self.allocator, ModuleAddress, self.cache, self.options.context, address, message, .{ .context = self.source, .get_fn = Fetch.get }, self.now_ms);
        }

        pub fn fetchQuorum(self: *Self, allocator: Allocator, validators: []const Address20, threshold: usize, index: u32, storage_errors: *usize) !?quorum.Quorum {
            return self.source.fetchQuorum(allocator, validators, threshold, index, storage_errors);
        }

        pub fn fetchLatestIndices(self: *Self, validators: []const Address20, output: []?u32, storage_errors: *usize) !void {
            return self.source.fetchLatestIndices(validators, output, storage_errors);
        }

        pub fn leafIndex(self: *Self, id: Hash) !?u32 {
            return self.source.leafIndex(id);
        }

        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            return self.source.highestKnownLeafIndex();
        }

        pub fn fetchCheckpoint(self: *Self, validator: Address20, index: u32) !?storage.SignedCheckpoint {
            return self.source.fetchCheckpoint(validator, index);
        }

        pub fn latestIndex(self: *Self, validator: Address20) !?u32 {
            return self.source.latestIndex(validator);
        }

        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            return self.source.proof(index, checkpoint);
        }
    };
}

pub fn RecipientIsmFetch(comptime ModuleAddress: type) type {
    return struct {
        context: *anyopaque,
        get_fn: *const fn (*anyopaque, Hash) anyerror!ModuleAddress,
    };
}

pub fn recipientIsmFor(comptime ModuleAddress: type, cache: *contract.CacheFor(ModuleAddress).Cache, context: contract.Context, recipient: Hash, fetch: RecipientIsmFetch(ModuleAddress), now_ms: u64) !ModuleAddress {
    if (try cache.get(context, .recipientIsm(recipient), now_ms)) |cached| {
        var value = cached;
        defer value.deinit(cache.allocator);
        return value.address;
    }
    const result = try fetch.get_fn(fetch.context, recipient);
    _ = try cache.put(context, .recipientIsm(recipient), &.{ .address = result }, now_ms);
    return result;
}

pub fn OffchainLookupFetch(comptime ModuleAddress: type) type {
    return struct {
        context: *anyopaque,
        get_fn: *const fn (*anyopaque, ModuleAddress, protocol.Message) anyerror!ccip.Lookup,
    };
}

pub fn offchainLookupFor(comptime ModuleAddress: type, cache: *contract.CacheFor(ModuleAddress).Cache, context: contract.Context, ism: ModuleAddress, message: protocol.Message, fetch: OffchainLookupFetch(ModuleAddress), now_ms: u64) !ccip.Lookup {
    return offchainLookupForAlloc(cache.allocator, ModuleAddress, cache, context, ism, message, fetch, now_ms);
}

pub fn offchainLookupForAlloc(output_allocator: Allocator, comptime ModuleAddress: type, cache: *contract.CacheFor(ModuleAddress).Cache, context: contract.Context, ism: ModuleAddress, message: protocol.Message, fetch: OffchainLookupFetch(ModuleAddress), now_ms: u64) !ccip.Lookup {
    if (try cache.getAlloc(output_allocator, context, .offchainLookup(ism, message), now_ms)) |cached| {
        const value = cached;
        return value.offchain_lookup;
    }
    var result = try fetch.get_fn(fetch.context, ism, message);
    errdefer result.deinit();
    _ = try cache.put(context, .offchainLookup(ism, message), &.{ .offchain_lookup = result }, now_ms);
    return result;
}
