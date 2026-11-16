//! Source's opt-in 250ms concrete-endpoint dynamic-tip cache/singleflight.
//! Role-owned, bounded, and shared explicitly. No global state or I/O while locked.
const std = @import("std");
const A = std.mem.Allocator;
pub const ttl_ns: u64 = 250 * std.time.ns_per_ms;
pub const Clock = struct { context: *anyopaque, now_fn: *const fn (*anyopaque) u64 };
pub const Config = struct { max_entries: usize = 1024, max_bytes: usize = 16 * 1024 * 1024, max_response_bytes: usize = 4 * 1024 * 1024, clock: ?Clock = null };
pub const Event = enum { logical_read, cache_hit, upstream_read, upstream_error };
/// Native synchronous clients borrow this for the role lifetime. Endpoint URL
/// is consumed synchronously only to select an already registered public host;
/// observer must never retain/log it or perform I/O.
pub const Observer = struct {
    context: *anyopaque,
    event_fn: *const fn (*anyopaque, []const u8, []const u8, Event) void,
    pub fn notify(self: Observer, url: []const u8, method: []const u8, event: Event) void {
        self.event_fn(self.context, url, method, event);
    }
};
pub const Ticket = struct { key: Key, generation: u64 };
pub const Claim = union(enum) { hit: []u8, leader: Ticket, follower: Ticket, bypass };
pub const Follow = union(enum) { hit: []u8, pending, released };
const Entry = struct { key: Key, generation: u64, inflight: bool = true, inserted_ns: u64 = 0, touched: u64, result: ?[]u8 = null };
pub const Cache = struct {
    allocator: A,
    config: Config,
    mutex: std.Thread.Mutex = .{},
    entries: std.ArrayList(Entry) = .empty,
    used_bytes: usize = 0,
    generation: u64 = 0,
    started: std.time.Instant,
    pub fn init(a: A, config: Config) !*Cache {
        if (config.max_entries == 0 or config.max_entries > 65536 or config.max_bytes == 0 or config.max_response_bytes == 0 or config.max_response_bytes > config.max_bytes) return error.InvalidTipCacheLimit;
        const self = try a.create(Cache);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .config = config, .started = try std.time.Instant.now() };
        return self;
    }
    /// Join all clients, replay journals and I/O pool owners before destruction.
    pub fn deinit(self: *Cache) void {
        for (self.entries.items) |entry| if (entry.result) |value| self.allocator.free(value);
        self.entries.deinit(self.allocator);
        self.allocator.destroy(self);
    }
    fn now(self: *Cache) u64 {
        return if (self.config.clock) |clock| clock.now_fn(clock.context) else (std.time.Instant.now() catch self.started).since(self.started);
    }
    fn find(self: *Cache, hash: Key) ?*Entry {
        for (self.entries.items) |*entry| if (entry.key.eql(hash)) return entry;
        return null;
    }
    fn clear(self: *Cache, entry: *Entry) void {
        if (entry.result) |value| {
            self.used_bytes -= value.len;
            self.allocator.free(value);
        }
        entry.result = null;
    }
    fn cached(self: *Cache, a: A, entry: *Entry, now_ns: u64) !?[]u8 {
        if (entry.result) |value| {
            if (now_ns -| entry.inserted_ns < ttl_ns) return try a.dupe(u8, value);
            self.clear(entry);
        }
        return null;
    }
    pub fn claim(self: *Cache, a: A, hash: Key) !Claim {
        self.mutex.lock();
        defer self.mutex.unlock();
        const now_ns = self.now();
        if (self.find(hash)) |entry| {
            entry.touched = now_ns;
            if (try self.cached(a, entry, now_ns)) |value| return .{ .hit = value };
            if (entry.inflight) return .{ .follower = .{ .key = hash, .generation = entry.generation } };
            if (self.generation == std.math.maxInt(u64)) return .bypass;
            self.generation += 1;
            entry.generation = self.generation;
            entry.inflight = true;
            return .{ .leader = .{ .key = hash, .generation = entry.generation } };
        }
        if (self.generation == std.math.maxInt(u64)) return .bypass;
        if (self.entries.items.len == self.config.max_entries) {
            var victim: ?usize = null;
            for (self.entries.items, 0..) |entry, index| if (!entry.inflight and (victim == null or entry.touched < self.entries.items[victim.?].touched)) {
                victim = index;
            };
            const index = victim orelse return .bypass;
            self.clear(&self.entries.items[index]);
            _ = self.entries.swapRemove(index);
        }
        try self.entries.ensureUnusedCapacity(self.allocator, 1);
        self.generation += 1;
        self.entries.appendAssumeCapacity(.{ .key = hash, .generation = self.generation, .touched = now_ns });
        return .{ .leader = .{ .key = hash, .generation = self.generation } };
    }
    pub fn follow(self: *Cache, a: A, ticket: Ticket) !Follow {
        self.mutex.lock();
        defer self.mutex.unlock();
        const entry = self.find(ticket.key) orelse return .released;
        // Source wakes then consults the current endpoint cache. A newer
        // successful generation may satisfy an old follower; an in-flight new
        // generation must not serialize retries from the failed generation.
        if (try self.cached(a, entry, self.now())) |value| return .{ .hit = value };
        if (entry.generation != ticket.generation) return .released;
        return if (entry.inflight) .pending else .released;
    }
    /// Null releases a failed/canceled generation. Followers of that generation
    /// bypass once, even if a new request has already become the next leader.
    /// Pressure/OOM skips insertion and releases followers; it never fabricates a
    /// successful result or changes the underlying request's outcome.
    pub fn finish(self: *Cache, ticket: Ticket, result: ?[]const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const entry = self.find(ticket.key) orelse return;
        if (entry.generation != ticket.generation or !entry.inflight) return;
        entry.inflight = false;
        const bytes = result orelse return;
        if (bytes.len > self.config.max_response_bytes or bytes.len > self.config.max_bytes -| self.used_bytes) return;
        const owned = self.allocator.dupe(u8, bytes) catch return;
        self.clear(entry);
        entry.result = owned;
        self.used_bytes += owned.len;
        entry.inserted_ns = self.now();
    }
};

/// SHA-256 of a complete endpoint identity (canonical URL and configured
/// headers, never the public host label), computed once per endpoint owner.
/// Only this digest is kept in memory.
pub const Identity = [32]u8;
pub fn identity(endpoint_identity: []const u8) Identity {
    var digest: Identity = undefined;
    std.crypto.hash.sha2.Sha256.hash(endpoint_identity, &digest, .{});
    return digest;
}
pub const Method = enum(u8) { block_number, block_by_number };
pub const Tag = enum(u8) { none, latest, safe, finalized };
/// What follows the tag in eth_getBlockByNumber params. `other` (never seen
/// from our clients) keys on the digest of the stringified params, so equal
/// keys still mean exactly equal params.
pub const Rest = enum(u8) { none, full_false, full_true, other };
/// Entries share one key exactly when the former SHA-256 keys were equal:
/// same endpoint identity and method; blockNumber ignores params; block
/// reads also need equal params.
pub const Key = struct {
    endpoint: Identity,
    method: Method,
    tag: Tag = .none,
    rest: Rest = .none,
    params: [32]u8 = @splat(0),
    pub fn eql(self: Key, other: Key) bool {
        return std.mem.eql(u8, &self.endpoint, &other.endpoint) and self.method == other.method and self.tag == other.tag and self.rest == other.rest and std.mem.eql(u8, &self.params, &other.params);
    }
};

/// BlockNumber ignores params exactly as Source; the full RPC request must
/// already have passed the ordinary envelope/size validation before this call.
/// No hashing or serialization on the shapes our clients send.
pub fn key(a: A, endpoint: Identity, method: []const u8, params: std.json.Value) !?Key {
    if (std.mem.eql(u8, method, "eth_blockNumber")) return .{ .endpoint = endpoint, .method = .block_number };
    if (!std.mem.eql(u8, method, "eth_getBlockByNumber") or params != .array or params.array.items.len == 0) return null;
    const items = params.array.items;
    if (items[0] != .string) return null;
    const tag: Tag = if (std.mem.eql(u8, items[0].string, "latest")) .latest else if (std.mem.eql(u8, items[0].string, "safe")) .safe else if (std.mem.eql(u8, items[0].string, "finalized")) .finalized else return null;
    var result: Key = .{ .endpoint = endpoint, .method = .block_by_number, .tag = tag };
    if (items.len == 1) return result;
    if (items.len == 2 and items[1] == .bool) {
        result.rest = if (items[1].bool) .full_true else .full_false;
        return result;
    }
    const encoded = try std.json.Stringify.valueAlloc(a, params, .{});
    defer a.free(encoded);
    result.tag = .none;
    result.rest = .other;
    std.crypto.hash.sha2.Sha256.hash(encoded, &result.params, .{});
    return result;
}

fn testKey(byte: u8) Key {
    return .{ .endpoint = @splat(byte), .method = .block_number };
}
const TestClock = struct {
    value: std.atomic.Value(u64) = .init(0),
    fn nowFn(context: *anyopaque) u64 {
        const self: *TestClock = @ptrCast(@alignCast(context));
        return self.value.load(.acquire);
    }
    fn interface(self: *TestClock) Clock {
        return .{ .context = self, .now_fn = nowFn };
    }
};
test "tip cache Source eligibility keys ignore only blockNumber params and isolate complete endpoint identities" {
    const a = std.testing.allocator;
    var params = try std.json.parseFromSlice(std.json.Value, a, "[\"latest\",false]", .{});
    defer params.deinit();
    const first = (try key(a, identity("endpointA+authA"), "eth_getBlockByNumber", params.value)).?;
    const second = (try key(a, identity("endpointA+authB"), "eth_getBlockByNumber", params.value)).?;
    try std.testing.expect(!first.eql(second));
    const endpoint = identity("endpoint");
    try std.testing.expect((try key(a, endpoint, "eth_blockNumber", .null)).?.eql((try key(a, endpoint, "eth_blockNumber", params.value)).?));
    try std.testing.expectEqual(@as(?Key, null), try key(a, endpoint, "eth_call", params.value));
    var pinned = try std.json.parseFromSlice(std.json.Value, a, "[\"0x123\",false]", .{});
    defer pinned.deinit();
    try std.testing.expectEqual(@as(?Key, null), try key(a, endpoint, "eth_getBlockByNumber", pinned.value));
    var pending = try std.json.parseFromSlice(std.json.Value, a, "[\"pending\",false]", .{});
    defer pending.deinit();
    try std.testing.expectEqual(@as(?Key, null), try key(a, endpoint, "eth_getBlockByNumber", pending.value));
}

/// The former key: SHA-256 over identity, method and (block reads) the
/// stringified params. Two requests must share a key exactly when these did.
fn legacyKey(a: A, endpoint_identity: []const u8, method: []const u8, params: std.json.Value) !?[32]u8 {
    const number = std.mem.eql(u8, method, "eth_blockNumber");
    if (!number) {
        if (!std.mem.eql(u8, method, "eth_getBlockByNumber") or params != .array or params.array.items.len == 0) return null;
        const tag = params.array.items[0];
        if (tag != .string or (!std.mem.eql(u8, tag.string, "latest") and !std.mem.eql(u8, tag.string, "safe") and !std.mem.eql(u8, tag.string, "finalized"))) return null;
    }
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    hash.update(endpoint_identity);
    hash.update(&.{0});
    hash.update(method);
    if (!number) {
        const encoded = try std.json.Stringify.valueAlloc(a, params, .{});
        defer a.free(encoded);
        hash.update(&.{0});
        hash.update(encoded);
    }
    return hash.finalResult();
}

test "tip cache keys partition requests exactly as the former hashed keys" {
    const a = std.testing.allocator;
    const identities = [_][]const u8{ "https://a.example/rpc", "https://a.example/rpc|authorization:x", "https://b.example/" };
    const methods = [_][]const u8{ "eth_blockNumber", "eth_getBlockByNumber", "eth_call", "eth_getBlockByHash" };
    const shapes = [_][]const u8{ "[]", "null", "{}", "[\"latest\"]", "[\"latest\",false]", "[\"latest\",true]", "[\"safe\",false]", "[\"finalized\",true]", "[\"l\\u0061test\",false]", "[\"latest\",false,1]", "[\"latest\",0]", "[\"latest\",\"false\"]", "[\"safe\",{\"a\":1}]", "[\"pending\",false]", "[\"0x10\",false]", "[1,false]" };
    const Case = struct { legacy: ?[32]u8, key: ?Key };
    var cases: std.ArrayList(Case) = .empty;
    defer cases.deinit(a);
    var trees: std.ArrayList(std.json.Parsed(std.json.Value)) = .empty;
    defer {
        for (trees.items) |tree| tree.deinit();
        trees.deinit(a);
    }
    for (shapes) |shape| try trees.append(a, try std.json.parseFromSlice(std.json.Value, a, shape, .{}));
    for (identities) |text| for (methods) |method| for (trees.items) |tree| {
        try cases.append(a, .{ .legacy = try legacyKey(a, text, method, tree.value), .key = try key(a, identity(text), method, tree.value) });
    };
    for (cases.items) |left| {
        try std.testing.expectEqual(left.legacy == null, left.key == null);
        if (left.key == null) continue;
        for (cases.items) |right| {
            if (right.key == null) continue;
            try std.testing.expectEqual(std.mem.eql(u8, &left.legacy.?, &right.legacy.?), left.key.?.eql(right.key.?));
        }
    }
}

test "tip cache TTL starts at successful insertion, strict250ms expiry, and failed generations release every follower" {
    const a = std.testing.allocator;
    var clock: TestClock = .{};
    const cache = try Cache.init(a, .{ .clock = clock.interface() });
    defer cache.deinit();
    const hash = testKey(1);
    const leader = (try cache.claim(a, hash)).leader;
    const follower = (try cache.claim(a, hash)).follower;
    clock.value.store(900 * std.time.ns_per_ms, .release);
    try std.testing.expect((try cache.follow(a, follower)) == .pending);
    cache.finish(leader, "null");
    clock.value.store(1149 * std.time.ns_per_ms, .release);
    const hit = (try cache.follow(a, follower)).hit;
    defer a.free(hit);
    try std.testing.expectEqualStrings("null", hit);
    clock.value.store(1150 * std.time.ns_per_ms, .release);
    const next = (try cache.claim(a, hash)).leader;
    const followers = [_]Ticket{ (try cache.claim(a, hash)).follower, (try cache.claim(a, hash)).follower };
    cache.finish(next, null);
    const newer = (try cache.claim(a, hash)).leader;
    for (followers) |ticket| try std.testing.expect((try cache.follow(a, ticket)) == .released);
    cache.finish(next, "\"stale\""); // Late old completion cannot populate new generation.
    try std.testing.expect((try cache.follow(a, newer)) == .pending);
    cache.finish(newer, null);
    try std.testing.expectEqual(@as(usize, 0), cache.used_bytes);
}
test "tip cache bounded entries never evict active leaders and byte pressure releases followers without fake data" {
    const a = std.testing.allocator;
    const cache = try Cache.init(a, .{ .max_entries = 1, .max_bytes = 8, .max_response_bytes = 8 });
    defer cache.deinit();
    const first = (try cache.claim(a, testKey(1))).leader;
    try std.testing.expect((try cache.claim(a, testKey(2))) == .bypass);
    cache.finish(first, "123456789");
    try std.testing.expect((try cache.follow(a, first)) == .released);
    const other = (try cache.claim(a, testKey(2))).leader;
    cache.finish(other, "123");
    try std.testing.expectEqual(@as(usize, 3), cache.used_bytes);
    const replacement = (try cache.claim(a, testKey(3))).leader;
    try std.testing.expectEqual(@as(usize, 0), cache.used_bytes);
    cache.finish(replacement, null);
}
test "tip cache concurrent claims elect one leader and bounded followers with no I/O inside ownership lock" {
    const a = std.testing.allocator;
    const cache = try Cache.init(a, .{});
    defer cache.deinit();
    const Context = struct {
        cache: *Cache,
        leaders: std.atomic.Value(u32) = .init(0),
        followers: std.atomic.Value(u32) = .init(0),
        fn run(self: *@This()) void {
            const result = self.cache.claim(std.heap.page_allocator, testKey(4)) catch unreachable;
            switch (result) {
                .leader => {
                    _ = self.leaders.fetchAdd(1, .monotonic);
                },
                .follower => {
                    _ = self.followers.fetchAdd(1, .monotonic);
                },
                else => unreachable,
            }
        }
    };
    var context: Context = .{ .cache = cache };
    var threads: [16]std.Thread = undefined;
    for (&threads) |*thread| thread.* = try std.Thread.spawn(.{}, Context.run, .{&context});
    for (threads) |thread| thread.join();
    try std.testing.expectEqual(@as(u32, 1), context.leaders.load(.acquire));
    try std.testing.expectEqual(@as(u32, 15), context.followers.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), cache.entries.items.len);
}

test "tip cache failed-generation follower may use newer ready result but never waits behind newer leader" {
    const a = std.testing.allocator;
    const cache = try Cache.init(a, .{});
    defer cache.deinit();
    const leader = (try cache.claim(a, testKey(9))).leader;
    const follower = (try cache.claim(a, testKey(9))).follower;
    cache.finish(leader, null);
    const next = (try cache.claim(a, testKey(9))).leader;
    try std.testing.expect((try cache.follow(a, follower)) == .released);
    cache.finish(next, "null");
    const fresh = (try cache.follow(a, follower)).hit;
    defer a.free(fresh);
    try std.testing.expectEqualStrings("null", fresh);
}
