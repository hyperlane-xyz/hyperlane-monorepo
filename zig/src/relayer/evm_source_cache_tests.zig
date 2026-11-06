const std = @import("std");
const cached = @import("cached_source.zig");
const contract = @import("contract_cache.zig");
const settings = @import("../settings/types.zig");
const evm = @import("../evm/root.zig");
const evm_source = @import("evm_source.zig");
const chain_testing = @import("../agents/chain_source_testing.zig");
const resources_module = @import("../agents/chain_source.zig");
const announcements = @import("../agents/announcement_source.zig");
const readers = @import("announced_readers.zig");
const remote = @import("remote_checkpoints.zig");
const Pool = @import("../evm/pool.zig").Pool;
const pool_fixture = @import("../evm/pool_testing.zig");
const budget_module = @import("../net/byte_budget.zig");
const parallel = @import("metadata_parallel.zig");
const A = std.mem.Allocator;
const Address = [20]u8;

const DefaultMock = struct {
    allocator: A,
    calls: usize = 0,
    invalid: bool = false,

    fn exchange(self: *DefaultMock) evm.provider.Exchange {
        return .{ .context = self, .fetch_fn = fetch };
    }

    fn fetch(context: *anyopaque, allocator: A, body: []const u8, _: evm.provider.Options) anyerror!evm.provider.WireResponse {
        const self: *DefaultMock = @ptrCast(@alignCast(context));
        const parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
        defer parsed.deinit();
        const object = parsed.value.object;
        const id = object.get("id").?.integer;
        const params = object.get("params").?.array.items;
        if (!std.mem.eql(u8, params[1].string, "0x7")) return error.UnpinnedDefaultIsmBlock;
        const data = params[0].object.get("data").?.string;
        const selector = try evm.codecs.hexAlloc(allocator, &evm.codecs.selector("defaultIsm()"));
        defer allocator.free(selector);
        if (!std.mem.eql(u8, data, selector)) return error.UnexpectedDefaultCalldata;
        self.calls += 1;
        var word: [32]u8 = @splat(0);
        if (self.invalid) word[0] = 1 else word[31] = 0x11;
        const hex = try evm.codecs.hexAlloc(allocator, &word);
        defer allocator.free(hex);
        const bytes = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"{s}\"}}", .{ id, hex });
        return .{ .bytes = bytes, .len = bytes.len };
    }
};

fn unexpectedDefault(_: *anyopaque, _: u64) !Address {
    return error.BorrowedDefaultCallbackUsed;
}

test "default ISM getter pins block and CachedSource forks use independent child getter" {
    const a = std.testing.allocator;
    var mock: DefaultMock = .{ .allocator = a };
    var client = try evm.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = mock.exchange() });
    defer client.deinit();
    var origin: evm_source.LocalOrigin = .{ .allocator = a, .leaves = &.{}, .stores = &.{} };
    var source: evm_source.Source(evm_source.LocalOrigin) = .{ .allocator = a, .client = &client, .block_number = 7, .origin = &origin, .mailbox = @splat(0x42) };
    var expected: Address = @splat(0);
    expected[19] = 0x11;
    try std.testing.expectEqual(expected, try source.defaultIsm());
    var cancel = std.atomic.Value(bool).init(false);
    const child = try source.fork(a, &cancel);
    defer child.deinitFork();
    try std.testing.expect(child.client != source.client);
    try std.testing.expectEqual(source.mailbox.?, child.mailbox.?);
    try std.testing.expectEqual(expected, try child.defaultIsm());

    const configured = [_]settings.IsmCache{.{ .selector = .default_ism, .module_types = &.{1}, .chains = &.{"ethereum"}, .cache_policy = .ism_specific }};
    var cache = try contract.Cache.init(a, .{ .max_entries = 4, .max_bytes = 4096 });
    defer cache.deinit();
    var ignored: u8 = 0;
    var wrapper = cached.CachedSource(@TypeOf(source)).initBorrowed(a, &source, &cache, .{ .context = .{ .domain_name = "ethereum", .context_hash = @splat(0x42) }, .configs = &configured, .default_ism = .{ .context = &ignored, .get_fn = unexpectedDefault } });
    const cached_child = try wrapper.fork(a, &cancel);
    defer cached_child.deinitFork();
    cached_child.setMessage(expected, null, 1000);
    try std.testing.expectEqual(expected, try cached_child.defaultIsm());
    try std.testing.expectEqual(@as(usize, 3), mock.calls);
    mock.invalid = true;
    try std.testing.expectError(error.InvalidAbi, source.defaultIsm());
}

const NativeObserver = struct {
    upstream_failures: std.atomic.Value(usize) = .init(0),
    request_failures: std.atomic.Value(usize) = .init(0),
    attempt_timeouts: std.atomic.Value(usize) = .init(0),

    fn interface(self: *NativeObserver) @import("../evm/pool.zig").Observer {
        return .{ .context = self, .event_fn = record };
    }
    fn record(context: *anyopaque, event: @import("../evm/pool.zig").Event) void {
        const self: *NativeObserver = @ptrCast(@alignCast(context));
        switch (event.kind) {
            .upstream_completed => {
                if (!event.success and !event.cancelled) _ = self.upstream_failures.fetchAdd(1, .acq_rel);
            },
            .request_failed => {
                if (!event.cancelled) _ = self.request_failures.fetchAdd(1, .acq_rel);
            },
            .attempt_timed_out => {
                _ = self.attempt_timeouts.fetchAdd(1, .acq_rel);
            },
            else => {},
        }
    }
    fn expectClean(self: *const NativeObserver) !void {
        try std.testing.expectEqual(@as(usize, 0), self.upstream_failures.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), self.request_failures.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), self.attempt_timeouts.load(.acquire));
    }
};

fn appendWord(out: *std.ArrayList(u8), allocator: A, value: u256) !void {
    var buffer: [64]u8 = undefined;
    const text = try std.fmt.bufPrint(&buffer, "{x:0>64}", .{value});
    try out.appendSlice(allocator, text);
}

fn announceResponse(allocator: A, body: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
    defer parsed.deinit();
    const object = parsed.value.object;
    const id = object.get("id").?.integer;
    const method = object.get("method").?.string;
    if (std.mem.eql(u8, method, "eth_chainId") or std.mem.eql(u8, method, "eth_blockNumber")) return std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x1\"}}", .{id});
    if (!std.mem.eql(u8, method, "eth_call")) return error.UnexpectedDiscoveryMethod;
    const params = object.get("params").?.array.items;
    const data = params[0].object.get("data").?.string;
    const local_domain = try evm.codecs.hexAlloc(allocator, &evm.codecs.selector("localDomain()"));
    defer allocator.free(local_domain);
    if (std.mem.eql(u8, data, local_domain)) return std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x1\"}}", .{id});
    var result: std.ArrayList(u8) = .empty;
    defer result.deinit(allocator);
    try appendWord(&result, allocator, 32);
    try appendWord(&result, allocator, 1);
    try appendWord(&result, allocator, 32);
    try appendWord(&result, allocator, 0);
    return std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x{s}\"}}", .{ id, result.items });
}

const Maintain = struct {
    job: parallel.Job = .{ .run_fn = run },
    registry: *readers.Registry,
    done: bool = false,
    failure: ?anyerror = null,

    fn run(job: *parallel.Job) parallel.RunResult {
        const self: *Maintain = @alignCast(@fieldParentPtr("job", job));
        if (self.registry.active == null) {
            self.done = true;
            return .done;
        }
        self.registry.maintain(null) catch |err| {
            self.failure = err;
            self.done = true;
            return .done;
        };
        return .suspended;
    }
};

test "two independent discoveries make progress round robin and drain shared quota" {
    const a = std.testing.allocator;
    const library = try pool_fixture.nativeLibrary(a);
    defer a.free(library);
    const stalled = [_]pool_fixture.Reply{
        .{ .body = "" },
        .{ .body = "", .stall = true },
    };
    const healthy = [_]pool_fixture.Reply{.{ .body = "" }};
    const behaviors = [_]pool_fixture.Behavior{
        .{ .replies = &stalled, .response_fn = announceResponse },
        .{ .replies = &healthy, .response_fn = announceResponse },
    };
    var server = try pool_fixture.Fixture.init(64, &behaviors);
    try server.start();
    defer server.deinit();
    var urls: [2][]const u8 = undefined;
    var owned_urls: [2][]u8 = undefined;
    for (&urls, &owned_urls, 0..) |*url, *owned, index| {
        owned.* = try server.url(a, index);
        url.* = owned.*;
    }
    defer for (&owned_urls) |url| a.free(url);
    var observer: NativeObserver = .{};
    var budget: budget_module.Budget = .{};
    defer {
        std.testing.expectEqual(@as(usize, 0), budget.used) catch unreachable;
    }
    var pools: [2]*Pool = undefined;
    for (&pools, 0..) |*pool, index| pool.* = try Pool.start(a, .{
        .library_path = library,
        .urls = urls[index .. index + 1],
        .strategy = .{ .single = .{ .max_attempts = 1 } },
        .observer = observer.interface(),
        .max_sessions = 2,
        .max_concurrent = 4,
        .max_pending = 16,
        .max_response_bytes = 16384,
        .max_reserved_bytes = 4 * 1024 * 1024,
    });
    defer for (&pools) |pool| pool.deinit();
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var resources: [2]*resources_module.Resources = undefined;
    for (&resources, 0..) |*resource, index| {
        var chain = chain_testing.chainFor(urls[index .. index + 1]);
        resource.* = try resources_module.Resources.open(a, &chain, &env, .{
            .curl_library = library,
            .cooperative_reads = true,
            .borrowed_rpc_pool = pools[index],
            .read_budget = &budget,
            .rpc_parallelism = 2,
            .request_timeout_ms = 20000,
            .allow_insecure_loopback = true,
            .rpc_max_response_bytes = 16384,
        });
    }
    defer for (&resources) |resource| resource.deinit();
    const engine = try remote.Engine.start(a, .{ .multi = .{ .library_path = library }, .timeout_ms = 20000, .allow_insecure_loopback = true });
    defer engine.deinit();
    var factories = [_]announcements.Factory{ announcements.Factory.init(resources[0]), announcements.Factory.init(resources[1]) };
    var registries = [_]readers.Registry{
        try readers.Registry.initSource(a, factories[0].interface(), &resources[0].native, engine, .{ .domain = 1, .discovery_timeout_ms = 20000 }),
        try readers.Registry.initSource(a, factories[1].interface(), &resources[1].native, engine, .{ .domain = 2, .discovery_timeout_ms = 20000 }),
    };
    defer for (&registries) |*registry| registry.deinit();
    try std.testing.expectError(error.PendingReadIo, registries[0].ensureValidators(&.{@splat(1)}, null));
    try std.testing.expectError(error.PendingReadIo, registries[1].ensureValidators(&.{@splat(1)}, null));
    const root = try parallel.Root.start(a, .{ .workers = 1, .max_retained_jobs = 8 });
    var cancel_a = std.atomic.Value(bool).init(false);
    defer {
        cancel_a.store(true, .release);
        registries[0].ensureValidators(&.{@splat(1)}, &cancel_a) catch {};
        while (root.executor.retainedJobs() != 0) {
            _ = root.executor.assist();
            std.Thread.sleep(std.time.ns_per_ms);
        }
        root.deinit();
    }
    var maintains = [_]Maintain{ .{ .registry = &registries[0] }, .{ .registry = &registries[1] } };
    try root.executor.submit(&maintains[0].job);
    try root.executor.submit(&maintains[1].job);
    var timer = try std.time.Timer.start();
    while (!maintains[1].done) {
        _ = root.executor.assist();
        if (timer.read() > 15 * std.time.ns_per_s) return error.HealthyOriginStalled;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    if (maintains[1].failure) |err| return err;
    if (maintains[0].failure) |err| return err;
    if (maintains[0].done) return error.StalledMaintainCompleted;
    if (registries[0].active == null) return error.StalledRegistryCompleted;
    if (registries[1].active != null) return error.HealthyRegistryIncomplete;
    try observer.expectClean();
    if (resources[1].cancel != null) return error.HealthyCancellationRetained;
    if (resources[1].read_replay) |replay| if (replay.cancel != null) return error.HealthyReplayCancellationRetained;
    cancel_a.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, registries[0].ensureValidators(&.{@splat(1)}, &cancel_a));
    while (root.executor.retainedJobs() != 0) {
        _ = root.executor.assist();
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(maintains[0].done);
    try server.check();
}
