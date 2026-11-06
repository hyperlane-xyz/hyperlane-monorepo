const std = @import("std");
const cached = @import("cached_source.zig");
const contract = @import("contract_cache.zig");
const protocol = @import("../protocol/root.zig");
const metadata = @import("metadata.zig");
const metadata_parallel = @import("metadata_parallel.zig");
const evm = @import("../evm/root.zig");
const evm_source = @import("evm_source.zig");
const ccip = @import("ccip.zig");
const settings = @import("../settings/types.zig");
const A = std.mem.Allocator;
const Address20 = [20]u8;
const Address32 = [32]u8;

fn context() contract.Context {
    return .{ .domain_name = "ethereum", .context_hash = @splat(0x42) };
}

const body_bytes: [256]u8 = blk: {
    var bytes: [256]u8 = undefined;
    for (&bytes, 0..) |*byte, index| byte.* = @truncate(index);
    break :blk bytes;
};

fn message(nonce: u32) protocol.Message {
    return .{ .version = 3, .nonce = nonce, .origin = 1000, .destination = 2000, .sender = @splat(1), .recipient = @splat(2), .body = body_bytes[nonce..][0..1] };
}

fn configs() [1]settings.IsmCache {
    return .{.{ .selector = .{ .app_context = "foo" }, .module_types = &.{1}, .chains = &.{"ethereum"}, .cache_policy = .ism_specific }};
}

fn default20(_: *anyopaque, _: u64) !Address20 {
    return @splat(0x11);
}

fn word(comptime suffix: []const u8) []const u8 {
    const zeros = "00000000000000000000000000000000" ++ "00000000000000000000000000000000";
    return zeros[0 .. 64 - suffix.len] ++ suffix;
}

const Mock = struct {
    allocator: A,
    mutex: std.Thread.Mutex = .{},
    module_calls: usize = 0,
    route_calls: usize = 0,
    fail_routes: usize = 0,

    fn exchange(self: *Mock) evm.provider.Exchange {
        return .{ .context = self, .fetch_fn = fetch };
    }

    fn result(_: *Mock, allocator: A, id: i64, value: []const u8) !evm.provider.WireResponse {
        const bytes = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x{s}\"}}", .{ id, value });
        return .{ .bytes = bytes, .len = bytes.len };
    }

    fn fetch(context_: *anyopaque, allocator: A, body: []const u8, _: evm.provider.Options) anyerror!evm.provider.WireResponse {
        const self: *Mock = @ptrCast(@alignCast(context_));
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
        defer parsed.deinit();
        const object = parsed.value.object;
        const id = object.get("id").?.integer;
        const method = object.get("method").?.string;
        if (!std.mem.eql(u8, method, "eth_call")) return error.UnexpectedRpcMethod;
        const params = object.get("params").?.array.items;
        const to = params[0].object.get("to").?.string;
        const data = params[0].object.get("data").?.string;
        const raw = try allocator.alloc(u8, (data.len - 2) / 2);
        defer allocator.free(raw);
        _ = try evm.codecs.decodeHex(raw, data);
        self.mutex.lock();
        defer self.mutex.unlock();
        if (raw.len >= 4 and std.mem.eql(u8, raw[0..4], &evm.codecs.selector("moduleType()"))) {
            self.module_calls += 1;
            return self.result(allocator, id, if (std.mem.endsWith(u8, to, "11")) word("1") else word("6"));
        }
        if (raw.len >= 4 and std.mem.eql(u8, raw[0..4], &evm.codecs.selector("route(bytes)"))) {
            self.route_calls += 1;
            if (self.fail_routes > 0) {
                self.fail_routes -= 1;
                const bytes = try std.fmt.allocPrint(self.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"error\":{{\"code\":-32000,\"message\":\"fixture\"}}}}", .{id});
                return .{ .bytes = bytes, .len = bytes.len };
            }
            return self.result(allocator, id, word("33"));
        }
        return error.UnexpectedCalldata;
    }
};

const EvmFixture = struct {
    allocator: A,
    mock: Mock,
    client: evm.RpcClient,
    origin: evm_source.LocalOrigin,
    source: evm_source.Source(evm_source.LocalOrigin),

    fn init(allocator: A) !*EvmFixture {
        const self = try allocator.create(EvmFixture);
        errdefer allocator.destroy(self);
        self.allocator = allocator;
        self.mock = .{ .allocator = allocator };
        self.client = try evm.RpcClient.init(allocator, "http://127.0.0.1:1", .{ .exchange = self.mock.exchange() });
        errdefer self.client.deinit();
        self.origin = .{ .allocator = allocator, .leaves = &.{}, .stores = &.{} };
        self.source = .{ .allocator = allocator, .client = &self.client, .block_number = 7, .origin = &self.origin };
        return self;
    }

    fn deinit(self: *EvmFixture) void {
        self.client.deinit();
        self.allocator.destroy(self);
    }
};

fn build(wrapper: anytype, msg: protocol.Message) ![]u8 {
    var builder: metadata.Builder(@TypeOf(wrapper.*)) = .{ .allocator = wrapper.allocator, .source = wrapper };
    return builder.build(@splat(0x11), msg);
}

test "actual EVM Source cache policy hits across messages and disabled exact RPC" {
    const a = std.testing.allocator;
    var fixture = try EvmFixture.init(a);
    defer fixture.deinit();
    const configured = configs();
    var cache = try contract.Cache.init(a, .{ .max_entries = 16, .max_bytes = 64 * 1024 });
    defer cache.deinit();
    var default_ignored: u8 = 0;
    var wrapper = cached.CachedSource(@TypeOf(fixture.source)).initBorrowed(a, &fixture.source, &cache, .{ .context = context(), .configs = &configured, .default_ism = .{ .context = &default_ignored, .get_fn = default20 } });
    const root: Address20 = @splat(0x11);
    const first = message(1);
    wrapper.setMessage(root, null, 1000);
    const first_metadata = try build(&wrapper, first);
    defer a.free(first_metadata);
    const repeat = try build(&wrapper, first);
    defer a.free(repeat);
    try std.testing.expectEqual(@as(usize, 1), fixture.mock.route_calls);
    try std.testing.expectEqual(@as(usize, 2), fixture.mock.module_calls);

    wrapper.setMessage(root, "foo", 1000);
    const second = try build(&wrapper, message(2));
    defer a.free(second);
    const third = try build(&wrapper, message(3));
    defer a.free(third);
    try std.testing.expectEqual(@as(usize, 2), fixture.mock.route_calls);
    try std.testing.expectEqual(@as(usize, 2), fixture.mock.module_calls);
    var other_origin = message(4);
    other_origin.origin += 1;
    const fourth = try build(&wrapper, other_origin);
    defer a.free(fourth);
    try std.testing.expectEqual(@as(usize, 3), fixture.mock.route_calls);

    var disabled = try contract.Cache.init(a, .{ .enabled = false, .max_entries = 2, .max_bytes = 1024 });
    defer disabled.deinit();
    var uncached = cached.CachedSource(@TypeOf(fixture.source)).initBorrowed(a, &fixture.source, &disabled, .{ .context = context(), .configs = &configured, .default_ism = .{ .context = &default_ignored, .get_fn = default20 } });
    uncached.setMessage(root, null, 1000);
    const before_route = fixture.mock.route_calls;
    const before_module = fixture.mock.module_calls;
    const fifth = try build(&uncached, first);
    defer a.free(fifth);
    const sixth = try build(&uncached, first);
    defer a.free(sixth);
    try std.testing.expectEqual(before_route + 2, fixture.mock.route_calls);
    try std.testing.expectEqual(before_module + 4, fixture.mock.module_calls);
}

test "parallel Builder forks own clients and share only cache hits" {
    const a = std.testing.allocator;
    var fixture = try EvmFixture.init(a);
    defer fixture.deinit();
    const configured = configs();
    var cache = try contract.Cache.init(a, .{ .max_entries = 16, .max_bytes = 64 * 1024 });
    defer cache.deinit();
    var wrapper = cached.CachedSource(@TypeOf(fixture.source)).initBorrowed(a, &fixture.source, &cache, .{ .context = context(), .configs = &configured });
    const root_ism: Address20 = @splat(0x11);
    wrapper.setMessage(root_ism, "foo", 1000);
    const root = try metadata_parallel.Root.start(a, .{ .workers = 2, .max_retained_jobs = 8, .max_output_bytes = 64 * 1024 });
    defer root.deinit();
    const Worker = struct {
        wrapper: *@TypeOf(wrapper),
        executor: *metadata_parallel.Executor,
        message_value: protocol.Message,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            var cancel = std.atomic.Value(bool).init(false);
            const forked = self.wrapper.fork(self.wrapper.allocator, &cancel) catch |err| {
                self.failure = err;
                return;
            };
            defer forked.deinitFork();
            forked.setMessage(self.wrapper.root_ism, "foo", 1000);
            var builder: metadata.Builder(@TypeOf(forked.*)) = .{ .allocator = forked.allocator, .source = forked, .executor = self.executor };
            const bytes = builder.build(@splat(0x11), self.message_value) catch |err| {
                self.failure = err;
                return;
            };
            forked.allocator.free(bytes);
        }
    };
    var workers = [_]Worker{ .{ .wrapper = &wrapper, .executor = &root.executor, .message_value = message(10) }, .{ .wrapper = &wrapper, .executor = &root.executor, .message_value = message(11) } };
    var threads: [2]std.Thread = undefined;
    for (&workers, &threads) |*worker, *thread| thread.* = try std.Thread.spawn(.{}, Worker.run, .{worker});
    for (threads) |thread| thread.join();
    for (workers) |worker| if (worker.failure) |failure| return failure;
    try std.testing.expect(fixture.mock.route_calls >= 1 and fixture.mock.route_calls <= 2);
    try std.testing.expect(fixture.mock.module_calls >= 3 and fixture.mock.module_calls <= 4);
}

test "full32 identities never collide and validators stay20 while verify bypasses cache" {
    const a = std.testing.allocator;
    const Fake = struct {
        allocator: A,
        module_calls: usize = 0,
        route_calls: usize = 0,
        member_calls: usize = 0,
        verify_calls: usize = 0,
        pub const ModuleAddress = Address32;
        pub const parallel_quorum = false;
        pub const parallel_latest = false;
        pub fn moduleType(self: *@This(), _: Address32) !metadata.ModuleType {
            self.module_calls += 1;
            return .routing;
        }
        pub fn route(self: *@This(), address: Address32, _: protocol.Message) !Address32 {
            self.route_calls += 1;
            return address;
        }
        pub fn members(self: *@This(), _: Address32, _: protocol.Message, comptime validators: bool) !metadata.ModuleMembers(if (validators) Address20 else Address32) {
            self.member_calls += 1;
            const T = if (validators) Address20 else Address32;
            const addresses = try self.allocator.alloc(T, 2);
            addresses[0] = @splat(1);
            addresses[1] = @splat(2);
            return .{ .addresses = addresses, .threshold = 1 };
        }
        pub fn verify(self: *@This(), _: Address32, _: protocol.Message, _: []const u8) !u256 {
            self.verify_calls += 1;
            return std.math.maxInt(u256);
        }
    };
    var fake: Fake = .{ .allocator = a };
    var cache = try contract.CacheFor(Address32).Cache.init(a, .{ .max_entries = 16, .max_bytes = 64 * 1024 });
    defer cache.deinit();
    const configured = configs();
    var wrapper = cached.CachedSource(Fake).initBorrowed(a, &fake, &cache, .{ .context = context(), .configs = &configured });
    const first: Address32 = @splat(1);
    var second = first;
    second[0] = 2;
    try std.testing.expectEqualSlices(u8, first[12..], second[12..]);
    const root_ism: Address32 = @splat(0x11);
    wrapper.setMessage(root_ism, "foo", 1000);
    const msg = message(5);
    try std.testing.expectEqual(first, try wrapper.route(first, msg));
    try std.testing.expectEqual(second, try wrapper.route(second, msg));
    _ = try wrapper.route(first, msg);
    _ = try wrapper.route(second, msg);
    try std.testing.expectEqual(@as(usize, 2), fake.route_calls);
    const first_members = try wrapper.members(first, msg, false);
    defer a.free(first_members.addresses);
    const second_members = try wrapper.members(second, msg, false);
    defer a.free(second_members.addresses);
    try std.testing.expectEqual(@as(usize, 2), fake.member_calls);
    const validators = try wrapper.members(first, msg, true);
    defer a.free(validators.addresses);
    try std.testing.expectEqual(@as(usize, 20), @sizeOf(@TypeOf(validators.addresses[0])));
    try std.testing.expectEqual(std.math.maxInt(u256), try wrapper.verify(first, msg, ""));
    try std.testing.expectEqual(std.math.maxInt(u256), try wrapper.verify(first, msg, ""));
    try std.testing.expectEqual(@as(usize, 2), fake.verify_calls);
}

test "full32 recipient default and CCIP helpers return independent owned values" {
    const a = std.testing.allocator;
    var cache = try contract.CacheFor(Address32).Cache.init(a, .{ .max_entries = 8, .max_bytes = 64 * 1024 });
    defer cache.deinit();
    const Fetch = struct {
        calls: usize = 0,
        fn recipient(ctx: *anyopaque, hash: Address32) !Address32 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.calls += 1;
            return hash;
        }
    };
    var fetch: Fetch = .{};
    const first: Address32 = @splat(1);
    var second = first;
    second[0] = 2;
    _ = try cached.recipientIsmFor(Address32, &cache, context(), first, .{ .context = &fetch, .get_fn = Fetch.recipient }, 1000);
    _ = try cached.recipientIsmFor(Address32, &cache, context(), second, .{ .context = &fetch, .get_fn = Fetch.recipient }, 1000);
    _ = try cached.recipientIsmFor(Address32, &cache, context(), first, .{ .context = &fetch, .get_fn = Fetch.recipient }, 1000);
    try std.testing.expectEqual(@as(usize, 2), fetch.calls);

    const Default = struct {
        value: Address32,
        fn get(ctx: *anyopaque, _: u64) !Address32 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return self.value;
        }
    };
    var default_fetch: Default = .{ .value = first };
    const DefaultSource = struct {
        pub const ModuleAddress = Address32;
        pub const parallel_quorum = false;
        pub const parallel_latest = false;
    };
    var source: DefaultSource = .{};
    const default_configs = [_]settings.IsmCache{.{ .selector = .default_ism, .module_types = &.{1}, .chains = &.{"ethereum"}, .cache_policy = .ism_specific }};
    var wrapper = cached.CachedSource(DefaultSource).initBorrowed(a, &source, &cache, .{ .context = context(), .configs = &default_configs, .default_ism = .{ .context = &default_fetch, .get_fn = Default.get } });
    wrapper.setMessage(first, null, 1000);
    try std.testing.expectEqual(first, try wrapper.defaultIsm());
    const app = try wrapper.appContext();
    try std.testing.expectEqualStrings("default_ism", app.?);
}

fn abiWord(out: *std.ArrayList(u8), allocator: A, value: usize) !void {
    var bytes: [32]u8 = @splat(0);
    std.mem.writeInt(u256, &bytes, value, .big);
    try out.appendSlice(allocator, &bytes);
}

fn lookup(allocator: A) !ccip.Lookup {
    var encoded: std.ArrayList(u8) = .empty;
    defer encoded.deinit(allocator);
    try encoded.appendSlice(allocator, &evm.codecs.selector("OffchainLookup(address,string[],bytes,bytes4,bytes)"));
    var sender: [32]u8 = @splat(0);
    sender[31] = 0x33;
    try encoded.appendSlice(allocator, &sender);
    try abiWord(&encoded, allocator, 160);
    try abiWord(&encoded, allocator, 288);
    try encoded.appendSlice(allocator, &.{ 1, 2, 3, 4 });
    try encoded.appendSlice(allocator, &([_]u8{0} ** 28));
    try abiWord(&encoded, allocator, 352);
    try abiWord(&encoded, allocator, 1);
    try abiWord(&encoded, allocator, 32);
    try abiWord(&encoded, allocator, 3);
    try encoded.appendSlice(allocator, "foo");
    try encoded.appendSlice(allocator, &([_]u8{0} ** 29));
    try abiWord(&encoded, allocator, 2);
    try encoded.appendSlice(allocator, &.{ 0xab, 0xcd });
    try encoded.appendSlice(allocator, &([_]u8{0} ** 30));
    try abiWord(&encoded, allocator, 1);
    try encoded.append(allocator, 0x55);
    try encoded.appendSlice(allocator, &([_]u8{0} ** 31));
    return ccip.decode(allocator, encoded.items);
}

test "raw CCIP lookup uses message ID and returns owned bytes on cache hits" {
    const a = std.testing.allocator;
    var cache = try contract.CacheFor(Address32).Cache.init(a, .{ .max_entries = 4, .max_bytes = 16 * 1024 });
    defer cache.deinit();
    const Fetch = struct {
        source: ccip.Lookup,
        calls: usize = 0,
        fn get(ctx: *anyopaque, _: Address32, _: protocol.Message) !ccip.Lookup {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.calls += 1;
            return self.source;
        }
    };
    var source = try lookup(a);
    defer source.deinit();
    var fetch: Fetch = .{ .source = source };
    const first: Address32 = @splat(1);
    var second = first;
    second[0] = 2;
    const msg = message(4);
    _ = try cached.offchainLookupFor(Address32, &cache, context(), first, msg, .{ .context = &fetch, .get_fn = Fetch.get }, 1000);
    _ = try cached.offchainLookupFor(Address32, &cache, context(), second, msg, .{ .context = &fetch, .get_fn = Fetch.get }, 1000);
    try std.testing.expectEqual(@as(usize, 2), cache.snapshot().entries);
    var hit = try cached.offchainLookupFor(Address32, &cache, context(), first, msg, .{ .context = &fetch, .get_fn = Fetch.get }, 1000);
    if (hit.encoded.ptr == source.encoded.ptr) return error.CacheLookupMiss;
    defer hit.deinit();
    try std.testing.expectEqual(@as(usize, 2), fetch.calls);
    try std.testing.expect(hit.encoded.ptr != source.encoded.ptr);
    try std.testing.expectEqualStrings("foo", hit.urls[0]);
}

test "distinct cache and wrapper allocators preserve owned members and lookup values" {
    const a = std.testing.allocator;
    const Fake = struct {
        padding: [7]u64 = @splat(0),
        allocator: A,
        member_calls: usize = 0,
        lookup_calls: usize = 0,
        pub const ModuleAddress = Address32;
        pub const parallel_quorum = false;
        pub const parallel_latest = false;
        pub fn moduleType(_: *@This(), _: Address32) !metadata.ModuleType {
            return .routing;
        }
        pub fn members(self: *@This(), _: Address32, _: protocol.Message, comptime validators: bool) !metadata.ModuleMembers(if (validators) Address20 else Address32) {
            self.member_calls += 1;
            const T = if (validators) Address20 else Address32;
            const addresses = try self.allocator.alloc(T, 2);
            addresses[0] = @splat(1);
            addresses[1] = @splat(2);
            return .{ .addresses = addresses, .threshold = 1 };
        }
        pub fn offchainLookup(self: *@This(), _: Address32, _: protocol.Message) !ccip.Lookup {
            self.lookup_calls += 1;
            return lookup(self.allocator);
        }
    };
    var cache_gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer std.testing.expect(cache_gpa.deinit() == .ok) catch unreachable;
    var cache = try contract.CacheFor(Address32).Cache.init(cache_gpa.allocator(), .{ .max_entries = 8, .max_bytes = 64 * 1024 });
    defer cache.deinit();
    var fake: Fake = .{ .allocator = a };
    const configured = configs();
    var wrapper = cached.CachedSource(Fake).initBorrowed(a, &fake, &cache, .{ .context = context(), .configs = &configured });
    const root: Address32 = @splat(0x11);
    wrapper.setMessage(root, "foo", 1000);
    const msg = message(8);
    const first: Address32 = @splat(1);
    const miss = try wrapper.members(first, msg, false);
    defer a.free(miss.addresses);
    const hit = try wrapper.members(first, msg, false);
    defer a.free(hit.addresses);
    if (fake.member_calls != 1) return error.MemberCacheMiss;
    try std.testing.expect(hit.addresses.ptr != miss.addresses.ptr);
    var lookup_miss = try wrapper.offchainLookup(first, msg);
    defer lookup_miss.deinit();
    var lookup_hit = try wrapper.offchainLookup(first, msg);
    defer lookup_hit.deinit();
    if (fake.lookup_calls != 1) return error.LookupCacheMiss;
    try std.testing.expect(lookup_hit.encoded.ptr != lookup_miss.encoded.ptr);

    var small = try contract.CacheFor(Address32).Cache.init(a, .{ .max_entries = 1, .max_bytes = 20 });
    defer small.deinit();
    var oversized = cached.CachedSource(Fake).initBorrowed(a, &fake, &small, .{ .context = context(), .configs = &configured });
    oversized.setMessage(root, "foo", 1000);
    const result = try oversized.members(first, msg, false);
    defer a.free(result.addresses);
    try std.testing.expectEqual(@as(usize, 2), result.addresses.len);
    try std.testing.expectEqual(@as(usize, 2), small.snapshot().rejected);
}

test "default ISM ordinary failures fall back while control errors propagate" {
    const a = std.testing.allocator;
    const Fake = struct {
        failure: anyerror,
        route_calls: usize = 0,
        pub const ModuleAddress = Address32;
        pub const parallel_quorum = false;
        pub const parallel_latest = false;
        pub fn moduleType(_: *@This(), _: Address32) !metadata.ModuleType {
            return .routing;
        }
        pub fn route(self: *@This(), address: Address32, _: protocol.Message) !Address32 {
            self.route_calls += 1;
            return address;
        }
        pub fn defaultIsm(self: *@This()) !Address32 {
            return self.failure;
        }
    };
    const configured = [_]settings.IsmCache{
        .{ .selector = .default_ism, .module_types = &.{1}, .chains = &.{"ethereum"}, .cache_policy = .ism_specific },
        .{ .selector = .{ .app_context = "foo" }, .module_types = &.{1}, .chains = &.{"ethereum"}, .cache_policy = .ism_specific },
    };
    var cache = try contract.CacheFor(Address32).Cache.init(a, .{ .max_entries = 8, .max_bytes = 64 * 1024 });
    defer cache.deinit();
    var fake: Fake = .{ .failure = error.RpcError };
    var wrapper = cached.CachedSource(Fake).initBorrowed(a, &fake, &cache, .{ .context = context(), .configs = &configured });
    const root: Address32 = @splat(0x11);
    wrapper.setMessage(root, "foo", 1000);
    _ = try wrapper.route(root, message(1));
    _ = try wrapper.route(root, message(2));
    try std.testing.expectEqual(@as(usize, 1), fake.route_calls);
    fake.failure = error.PendingReadIo;
    try std.testing.expectError(error.PendingReadIo, wrapper.route(root, message(3)));

    var no_default = cached.CachedSource(Fake).initBorrowed(a, &fake, &cache, .{ .context = context() });
    no_default.setMessage(root, null, 1000);
    _ = try no_default.route(root, message(4));
}

test "owned fork retains app context after parent policy storage is destroyed" {
    const a = std.testing.allocator;
    var fixture = try EvmFixture.init(a);
    defer fixture.deinit();
    const configured = configs();
    var cache = try contract.Cache.init(a, .{ .max_entries = 8, .max_bytes = 64 * 1024 });
    defer cache.deinit();
    var wrapper = cached.CachedSource(@TypeOf(fixture.source)).initBorrowed(a, &fixture.source, &cache, .{ .context = context(), .configs = &configured });
    const parent_context = try a.dupe(u8, "foo");
    wrapper.setMessage(@splat(0x11), parent_context, 1000);
    var cancel = std.atomic.Value(bool).init(false);
    const child = try wrapper.fork(a, &cancel);
    a.free(parent_context);
    wrapper = undefined;
    const app = try child.appContext();
    try std.testing.expectEqualStrings("foo", app.?);
    const bytes = try build(child, message(12));
    defer child.allocator.free(bytes);
    child.deinitFork();
}

test "composite metadata forwards without caching final metadata and EVM refusal is explicit" {
    const a = std.testing.allocator;
    const Fake = struct {
        allocator: A,
        calls: usize = 0,
        pub const ModuleAddress = Address32;
        pub const parallel_quorum = false;
        pub const parallel_latest = false;
        pub fn compositeMetadata(self: *@This(), address: Address32, _: protocol.Message) ![]u8 {
            self.calls += 1;
            if (address[0] == 0xff) return error.MessageMetadataRefused;
            return self.allocator.dupe(u8, "composite");
        }
    };
    var fake: Fake = .{ .allocator = a };
    var cache = try contract.CacheFor(Address32).Cache.init(a, .{ .max_entries = 4, .max_bytes = 4096 });
    defer cache.deinit();
    var wrapper = cached.CachedSource(Fake).initBorrowed(a, &fake, &cache, .{ .context = context() });
    const bytes = try wrapper.compositeMetadata(@splat(1), message(1));
    defer a.free(bytes);
    try std.testing.expectEqualStrings("composite", bytes);
    try std.testing.expectEqual(@as(usize, 1), fake.calls);
    try std.testing.expectEqual(@as(usize, 0), cache.snapshot().entries);
    var refused: Address32 = @splat(1);
    refused[0] = 0xff;
    try std.testing.expectError(error.MessageMetadataRefused, wrapper.compositeMetadata(refused, message(1)));

    var fixture = try EvmFixture.init(a);
    defer fixture.deinit();
    var evm_cache = try contract.Cache.init(a, .{ .max_entries = 4, .max_bytes = 4096 });
    defer evm_cache.deinit();
    var evm_wrapper = cached.CachedSource(@TypeOf(fixture.source)).initBorrowed(a, &fixture.source, &evm_cache, .{ .context = context() });
    try std.testing.expectError(error.UnsupportedIsmType, evm_wrapper.compositeMetadata(@splat(0x11), message(1)));
}

fn allocationSweep(a: A) !void {
    var fixture = try EvmFixture.init(a);
    defer fixture.deinit();
    const configured = configs();
    var cache = try contract.Cache.init(a, .{ .max_entries = 8, .max_bytes = 16 * 1024 });
    defer cache.deinit();
    var default_ignored: u8 = 0;
    var wrapper = cached.CachedSource(@TypeOf(fixture.source)).initBorrowed(a, &fixture.source, &cache, .{ .context = context(), .configs = &configured, .default_ism = .{ .context = &default_ignored, .get_fn = default20 } });
    wrapper.setMessage(@splat(0x11), null, 1000);
    const bytes = try build(&wrapper, message(1));
    defer a.free(bytes);
    var cancel = std.atomic.Value(bool).init(false);
    const forked = try wrapper.fork(a, &cancel);
    defer forked.deinitFork();
    const forked_bytes = try build(forked, message(1));
    defer forked.allocator.free(forked_bytes);
    const OffchainFetch = struct {
        allocator: A,
        fn get(ctx: *anyopaque, _: Address20, _: protocol.Message) !ccip.Lookup {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return lookup(self.allocator);
        }
    };
    var fetch: OffchainFetch = .{ .allocator = a };
    var first_result = try cached.offchainLookupFor(Address20, &cache, context(), @splat(1), message(1), .{ .context = &fetch, .get_fn = OffchainFetch.get }, 1000);
    defer first_result.deinit();
    var hit = try cached.offchainLookupFor(Address20, &cache, context(), @splat(1), message(1), .{ .context = &fetch, .get_fn = OffchainFetch.get }, 1000);
    defer hit.deinit();
}

test "cached Source and fork clean every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}
