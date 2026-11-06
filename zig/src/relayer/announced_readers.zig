//! Origin-scoped announcement resolution. Discovery is a shared cooperative
//! frame: no network runs under the Registry mutex, and immutable results are
//! installed before the active frame is released.
const std = @import("std");
const evm = @import("../evm/root.zig");
const reader = @import("checkpoint_reader.zig");
const engine = @import("remote_checkpoints.zig");
const Curl = @import("../net/curl.zig");
const origin = @import("../agents/origin.zig");
const Allocator = std.mem.Allocator;
const Address = [20]u8;
pub const Locations = evm.announce.Locations;
/// Native provider callback returns owned, validator-ordered location lists.
/// Optional pass hooks bracket one retained read-only replay across PendingReadIo.
pub const LocationSource = struct {
    context: *anyopaque,
    fetch_fn: *const fn (*anyopaque, Allocator, []const Address, ?*const std.atomic.Value(bool)) anyerror!Locations,
    begin_pass_fn: ?*const fn (*anyopaque, *const std.atomic.Value(bool)) anyerror!void = null,
    end_pass_fn: ?*const fn (*anyopaque, ?anyerror) void = null,
};

pub const Options = struct {
    domain: u32,
    chain_id: u256 = 0,
    announce_contract: Address = @splat(0),
    allow_local: bool = false,
    ignore_reorg_reports: bool = false,
    /// Zero disables call caching. Rust's configured default is 120 seconds.
    cache_ttl_ms: u64 = 0,
    max_cache_entries: usize = 4096,
    max_cache_bytes: usize = 8 * 1024 * 1024,
    discovery_timeout_ms: u64 = 120000,
};
const Cached = struct {
    arena: std.heap.ArenaAllocator,
    locations: [][]const u8,
    bytes: usize,
    expires_ms: u64,
    touched: u64,
    fn init(allocator: Allocator, input: []const []const u8, expires_ms: u64, touched: u64) !Cached {
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const locations = try a.alloc([]const u8, input.len);
        var bytes: usize = locations.len * @sizeOf([]const u8);
        for (input, locations) |value, *location| {
            location.* = try a.dupe(u8, value);
            bytes = try std.math.add(usize, bytes, value.len);
        }
        return .{ .arena = arena, .locations = locations, .bytes = bytes, .expires_ms = expires_ms, .touched = touched };
    }
    fn deinit(self: *Cached) void {
        self.arena.deinit();
    }
};

const Active = struct {
    allocator: Allocator,
    missing: []Address,
    started: std.time.Instant,
    references: std.atomic.Value(usize) = .init(2),
    cancel: std.atomic.Value(bool) = .init(false),
    provider: ?LocationSource,
    fetched: ?Locations = null,
    needs_reset: bool = false,

    fn create(allocator: Allocator, missing: []const Address, provider: ?LocationSource) !Active {
        const owned = try allocator.dupe(Address, missing);
        errdefer allocator.free(owned);
        return .{
            .allocator = allocator,
            .missing = owned,
            .started = try std.time.Instant.now(),
            .provider = provider,
        };
    }
    fn retain(self: *Active) void {
        _ = self.references.fetchAdd(1, .acq_rel);
    }
    fn release(self: *Active) void {
        if (self.references.fetchSub(1, .acq_rel) != 1) return;
        if (self.needs_reset) if (self.provider) |provider| if (provider.end_pass_fn) |end| end(provider.context, error.RequestCancelled);
        if (self.fetched) |*fetched| fetched.deinit();
        self.allocator.free(self.missing);
        const allocator = self.allocator;
        allocator.destroy(self);
    }
};

pub const Registry = struct {
    allocator: Allocator,
    /// Dedicated cooperative RPC client, borrowed. Never shared with indexing.
    client: ?*evm.RpcClient,
    location_source: ?LocationSource = null,
    native: *Curl.Client,
    owner: *engine.Engine,
    options: Options,
    cache: std.AutoArrayHashMapUnmanaged(Address, Cached) = .empty,
    bytes: usize = 0,
    sequence: u64 = 0,
    started: std.time.Instant,
    checked: bool = false,
    active: ?*Active = null,
    mutex: std.Thread.Mutex = .{},

    pub fn init(allocator: Allocator, client: *evm.RpcClient, native: *Curl.Client, owner: *engine.Engine, options: Options) !Registry {
        if (options.max_cache_entries == 0 or options.max_cache_bytes == 0 or options.discovery_timeout_ms == 0 or client.options.native_transport == null) return error.InvalidAnnouncementRegistry;
        return .{ .allocator = allocator, .client = client, .native = native, .owner = owner, .options = options, .started = try std.time.Instant.now() };
    }
    pub fn initSource(allocator: Allocator, source: LocationSource, native: *Curl.Client, owner: *engine.Engine, options: Options) !Registry {
        if (options.max_cache_entries == 0 or options.max_cache_bytes == 0 or options.discovery_timeout_ms == 0) return error.InvalidAnnouncementRegistry;
        return .{ .allocator = allocator, .client = null, .location_source = source, .native = native, .owner = owner, .options = options, .started = try std.time.Instant.now() };
    }
    pub fn deinit(self: *Registry) void {
        if (self.active) |active| {
            active.cancel.store(true, .release);
            active.release();
            self.active = null;
        }
        for (self.cache.values()) |*cached| cached.deinit();
        self.cache.deinit(self.allocator);
        self.* = undefined;
    }
    pub fn interface(self: *Registry) origin.Origin.Discovery {
        return .{ .context = self, .ensure = ensure };
    }
    fn ensure(context: *anyopaque, validators: []const Address, cancel: ?*const std.atomic.Value(bool)) !void {
        const self: *Registry = @ptrCast(@alignCast(context));
        return self.ensureValidators(validators, cancel);
    }
    fn now(self: *Registry) !u64 {
        return (try std.time.Instant.now()).since(self.started) / std.time.ns_per_ms;
    }

    fn insert(self: *Registry, validator: Address, locations: []const []const u8, now_ms: u64) !void {
        self.sequence +|= 1;
        var cached = try Cached.init(self.allocator, locations, now_ms +| self.options.cache_ttl_ms, self.sequence);
        errdefer cached.deinit();
        if (cached.bytes > self.options.max_cache_bytes) return error.AnnouncementCacheByteLimit;
        if (self.cache.fetchSwapRemove(validator)) |previous| {
            var old = previous.value;
            self.bytes -= old.bytes;
            old.deinit();
        }
        while (self.cache.count() >= self.options.max_cache_entries or self.bytes + cached.bytes > self.options.max_cache_bytes) {
            var oldest: usize = 0;
            for (self.cache.values(), 0..) |value, i| if (value.touched < self.cache.values()[oldest].touched) {
                oldest = i;
            };
            self.bytes -= self.cache.values()[oldest].bytes;
            self.cache.values()[oldest].deinit();
            self.cache.swapRemoveAt(oldest);
        }
        try self.cache.put(self.allocator, validator, cached);
        self.bytes += cached.bytes;
    }

    fn lock(self: *Registry) !void {
        if (!self.mutex.tryLock()) return error.PendingReadIo;
    }

    fn startOrAcquire(self: *Registry, validators: []const Address) !?*Active {
        try self.lock();
        defer self.mutex.unlock();
        if (self.active) |active| {
            if (active.missing.len != validators.len or !std.mem.eql(Address, active.missing, validators)) return error.PendingReadIo;
            active.retain();
            return active;
        }
        var missing: [256]Address = undefined;
        var count: usize = 0;
        const now_ms = try self.now();
        for (validators) |validator| {
            const cached = self.cache.get(validator);
            if (cached == null or self.options.cache_ttl_ms == 0 or cached.?.expires_ms <= now_ms) {
                missing[count] = validator;
                count += 1;
            }
        }
        if (count == 0) {
            for (validators) |validator| {
                const cached = self.cache.getPtr(validator) orelse return error.AnnouncementCacheCapacity;
                self.sequence +|= 1;
                cached.touched = self.sequence;
                try self.install(validator, cached.locations);
            }
            return null;
        }
        const active = try self.allocator.create(Active);
        errdefer self.allocator.destroy(active);
        active.* = try Active.create(self.allocator, missing[0..count], self.location_source);
        self.active = active;
        return active;
    }

    fn clearActive(self: *Registry, active: *Active) void {
        self.mutex.lock();
        const owned = self.active == active;
        if (owned) self.active = null;
        self.mutex.unlock();
        if (owned) active.release();
    }

    fn advance(self: *Registry, active: *Active, cancel: ?*const std.atomic.Value(bool)) !bool {
        if (cancel) |flag| if (flag.load(.acquire)) {
            active.cancel.store(true, .release);
            self.clearActive(active);
            return error.RequestCancelled;
        };
        const elapsed = (try std.time.Instant.now()).since(active.started) / std.time.ns_per_ms;
        if (elapsed >= self.options.discovery_timeout_ms) {
            active.cancel.store(true, .release);
            self.clearActive(active);
            return error.RequestDeadlineExceeded;
        }
        if (self.client) |client| {
            if (!self.checked) {
                client.options.cancel = &active.cancel;
                defer client.options.cancel = null;
                client.checkChain(self.options.chain_id) catch |err| {
                    if (err == error.PendingReadIo) return false;
                    self.clearActive(active);
                    return err;
                };
                self.checked = true;
            }
        }
        if (active.fetched == null) {
            if (self.location_source) |provider| {
                var failure: ?anyerror = null;
                if (provider.begin_pass_fn) |begin| begin(provider.context, &active.cancel) catch |err| {
                    failure = err;
                };
                active.needs_reset = true;
                const fetched = if (failure == null) provider.fetch_fn(provider.context, self.allocator, active.missing, &active.cancel) catch |err| blk: {
                    failure = err;
                    break :blk null;
                } else null;
                active.needs_reset = failure != null and failure.? == error.PendingReadIo;
                if (provider.end_pass_fn) |end| end(provider.context, failure);
                if (failure) |err| {
                    if (err == error.PendingReadIo) return false;
                    self.clearActive(active);
                    return err;
                }
                active.fetched = fetched orelse return error.AnnouncementProviderMissing;
            } else {
                const client = self.client orelse return error.AnnouncementProviderMissing;
                client.options.cancel = &active.cancel;
                defer client.options.cancel = null;
                const fetched = evm.announce.fetch(client, self.options.announce_contract, active.missing, .latest, .{}) catch |err| {
                    if (err == error.PendingReadIo) return false;
                    self.clearActive(active);
                    return err;
                };
                active.fetched = fetched;
            }
        }
        const fetched = &active.fetched.?;
        if (fetched.values.len != active.missing.len) {
            self.clearActive(active);
            return error.AnnouncementValidatorCountMismatch;
        }
        const inserted_at = try self.now();
        try self.lock();
        if (self.active != active) {
            self.mutex.unlock();
            return true;
        }
        for (active.missing, fetched.values) |validator, locations| self.insert(validator, locations, inserted_at) catch |err| {
            self.mutex.unlock();
            self.clearActive(active);
            return err;
        };
        for (active.missing) |validator| {
            const cached = self.cache.getPtr(validator) orelse {
                self.mutex.unlock();
                self.clearActive(active);
                return error.AnnouncementCacheCapacity;
            };
            self.install(validator, cached.locations) catch |err| {
                self.mutex.unlock();
                self.clearActive(active);
                return err;
            };
        }
        const owned = self.active == active;
        if (owned) self.active = null;
        self.mutex.unlock();
        if (owned) active.release();
        return true;
    }

    pub fn ensureValidators(self: *Registry, validators: []const Address, cancel: ?*const std.atomic.Value(bool)) !void {
        if (validators.len > 256) return error.InvalidValidatorCount;
        if (cancel) |flag| if (flag.load(.acquire)) {
            self.mutex.lock();
            if (self.active) |active| {
                active.cancel.store(true, .release);
                self.active = null;
                active.release();
            }
            self.mutex.unlock();
            return error.RequestCancelled;
        };
        const active = (try self.startOrAcquire(validators)) orelse return;
        defer active.release();
        if (!try self.advance(active, cancel)) return error.PendingReadIo;
    }

    /// OriginTask calls between index cycles. Never starts new discovery.
    pub fn maintain(self: *Registry, cancel: ?*const std.atomic.Value(bool)) !void {
        try self.lock();
        const active = self.active orelse {
            self.mutex.unlock();
            return;
        };
        active.retain();
        self.mutex.unlock();
        defer active.release();
        _ = try self.advance(active, cancel);
    }

    fn install(self: *Registry, validator: Address, locations: []const []const u8) !void {
        var hasher = std.crypto.hash.sha2.Sha256.init(.{});
        hasher.update(&.{ @intFromBool(self.options.allow_local), @intFromBool(self.options.ignore_reorg_reports) });
        for (locations) |location| {
            var length: [8]u8 = undefined;
            std.mem.writeInt(u64, &length, location.len, .big);
            hasher.update(&length);
            hasher.update(location);
        }
        var version: [32]u8 = undefined;
        hasher.final(&version);
        if (self.owner.hasLocation(self.options.domain, validator, version)) return;
        var candidates: std.ArrayList(engine.Candidate) = .empty;
        defer candidates.deinit(self.allocator);
        var owned: std.ArrayList(*reader.Reader) = .empty;
        defer {
            for (owned.items) |value| value.deinit();
            owned.deinit(self.allocator);
        }
        var index = locations.len;
        while (index > 0) {
            index -= 1;
            const value = reader.Reader.open(self.allocator, self.options.domain, validator, locations[index], self.native, self.options.allow_local) catch |err| {
                if (err == error.OutOfMemory) return err;
                continue; // Source parser/disallowed/unavailable local path fallback.
            };
            owned.append(self.allocator, value) catch |err| {
                value.deinit();
                return err;
            };
            const candidate: engine.Candidate = switch (value.backend) {
                .cloud => |backend| .{ .remote = .{ .origin = self.options.domain, .validator = validator, .location_id = if (candidates.items.len == 0) version else value.location_id, .backend = backend, .ignore_reorg_reports = self.options.ignore_reorg_reports } },
                .local => local: {
                    var interface_ = value.interface();
                    interface_.ignore_reorg_reports = self.options.ignore_reorg_reports;
                    if (candidates.items.len == 0) interface_.location_id = version;
                    break :local .{ .disk = interface_ };
                },
            };
            try candidates.append(self.allocator, candidate);
        }
        try self.owner.registerLocations(self.options.domain, validator, candidates.items);
    }
};

test "announced readers retain latest-first locations, reorg policy and removal" {
    const a = std.testing.allocator;
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    var native = try Curl.Client.init(a, library);
    defer native.deinit();
    var client = try evm.RpcClient.init(a, "http://127.0.0.1:1", .{ .native_transport = &native });
    defer client.deinit();
    const owner = try engine.Engine.start(a, .{ .multi = .{ .library_path = library } });
    defer owner.deinit();
    var registry = try Registry.init(a, &client, &native, owner, .{ .domain = 1, .chain_id = 1, .announce_contract = @splat(1), .allow_local = true, .max_cache_entries = 2 });
    defer registry.deinit();
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const storage = @import("../storage/root.zig");
    const key: [32]u8 = @splat(7);
    const signer = try @import("../protocol/signature.zig").secretKeyAddress(key);
    const old = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(old);
    var older = try storage.LocalStore.open(a, tmp.dir, "old", .{ .read_only = false, .signer = signer });
    defer older.deinit();
    var newer = try storage.LocalStore.open(a, tmp.dir, "new", .{ .read_only = false, .signer = signer });
    defer newer.deinit();
    const checkpoint: @import("../protocol/root.zig").Checkpoint = .{ .mailbox_domain = 1, .merkle_tree_hook_address = @splat(2), .root = @splat(3), .index = 1, .message_id = @splat(4) };
    _ = try older.writeCheckpoint(try storage.SignedCheckpoint.sign(checkpoint, key, null), 1);
    try older.writeLatestIndex(1);
    var later = checkpoint;
    later.index = 3;
    _ = try newer.writeCheckpoint(try storage.SignedCheckpoint.sign(later, key, null), 1);
    try newer.writeLatestIndex(3);
    const old_location = try std.fmt.allocPrint(a, "file://{s}/old", .{old});
    defer a.free(old_location);
    const new_location = try std.fmt.allocPrint(a, "file://{s}/new", .{old});
    defer a.free(new_location);
    const locations = [_][]const u8{ old_location, new_location, "invalid announcement" };
    try registry.install(signer, &locations);
    var values: [1]?u32 = undefined;
    var errors: usize = 0;
    try owner.latestIndices(1, &.{signer}, &values, &errors, null);
    try std.testing.expectEqual(@as(?u32, 3), values[0]);
    try newer.dir.writeFile(.{ .sub_path = "reorg_flag.json", .data = "malformed flag still halts" });
    try std.testing.expectError(error.ValidatorReorg, owner.latestIndices(1, &.{signer}, &values, &errors, null));
    registry.options.ignore_reorg_reports = true;
    try registry.install(signer, &locations);
    try owner.latestIndices(1, &.{signer}, &values, &errors, null);
    try std.testing.expectEqual(@as(?u32, 1), values[0]);
    try registry.install(signer, &.{});
    try std.testing.expect(!owner.hasReader(1, signer));
    // A cancelled discovery must compile the real fetch path but perform no I/O.
    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, registry.ensureValidators(&.{signer}, &cancelled));
    try registry.insert(@splat(1), &locations, 0);
    try registry.insert(@splat(2), &.{old_location}, 0);
    registry.cache.getPtr(@splat(1)).?.touched = 10;
    try registry.insert(@splat(3), &.{new_location}, 0);
    try std.testing.expect(registry.cache.contains(@splat(1)));
    try std.testing.expect(!registry.cache.contains(@splat(2)));
    try std.testing.expectEqual(@as(usize, 2), registry.cache.count());
}

const CooperativeLocations = struct {
    pending: usize = 1,
    fetches: usize = 0,
    begins: usize = 0,
    resets: usize = 0,

    fn source(self: *CooperativeLocations) LocationSource {
        return .{ .context = self, .fetch_fn = fetch, .begin_pass_fn = begin, .end_pass_fn = end };
    }
    fn begin(context: *anyopaque, _: *const std.atomic.Value(bool)) !void {
        const self: *CooperativeLocations = @ptrCast(@alignCast(context));
        self.begins += 1;
    }
    fn end(context: *anyopaque, failure: ?anyerror) void {
        const self: *CooperativeLocations = @ptrCast(@alignCast(context));
        if (failure != null and failure.? == error.RequestCancelled) self.resets += 1;
    }
    fn fetch(context: *anyopaque, allocator: Allocator, validators: []const Address, _: ?*const std.atomic.Value(bool)) !Locations {
        const self: *CooperativeLocations = @ptrCast(@alignCast(context));
        self.fetches += 1;
        if (self.pending > 0) {
            self.pending -= 1;
            return error.PendingReadIo;
        }
        var arena = std.heap.ArenaAllocator.init(allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const values = try a.alloc([][]const u8, validators.len);
        for (values) |*value| value.* = try a.alloc([]const u8, 0);
        return .{ .arena = arena, .values = values };
    }
};

test "cooperative discovery resumes stable inputs and resets retained replay on cancel" {
    const a = std.testing.allocator;
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    var native = try Curl.Client.init(a, library);
    defer native.deinit();
    const owner = try engine.Engine.start(a, .{ .multi = .{ .library_path = library } });
    defer owner.deinit();
    var provider: CooperativeLocations = .{};
    var registry = try Registry.initSource(a, provider.source(), &native, owner, .{ .domain = 1 });
    defer registry.deinit();
    const validator: Address = @splat(1);
    const other: Address = @splat(2);
    try std.testing.expectError(error.PendingReadIo, registry.ensureValidators(&.{validator}, null));
    try std.testing.expectError(error.PendingReadIo, registry.ensureValidators(&.{other}, null));
    try std.testing.expectEqual(@as(usize, 1), provider.fetches);
    try registry.maintain(null);
    try std.testing.expectEqual(@as(usize, 2), provider.fetches);
    try std.testing.expect(registry.active == null);
    try registry.ensureValidators(&.{validator}, null);
    try std.testing.expectEqual(@as(usize, 3), provider.fetches);
    provider.pending = 1;
    try std.testing.expectError(error.PendingReadIo, registry.ensureValidators(&.{validator}, null));
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, registry.ensureValidators(&.{validator}, &cancel));
    try std.testing.expectEqual(@as(usize, 1), provider.resets);
    try std.testing.expect(registry.active == null);
}

fn discoveryAllocationExercise(allocator: Allocator) !void {
    {
        const active = try allocator.create(Active);
        errdefer allocator.destroy(active);
        active.* = try Active.create(allocator, &.{@splat(1)}, null);
        active.release();
        active.release();
    }
    var cached = try Cached.init(allocator, &.{"file://fixture"}, 0, 0);
    cached.deinit();
}

test "discovery active and cache allocation failures preserve ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, discoveryAllocationExercise, .{});
}
