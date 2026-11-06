//! Actual validator range scheduling with native RocksDB and injected readers.
const std = @import("std");
const native = @import("../store.zig");
const rocks = @import("../../db/rocks.zig");
const settings = @import("../../settings/types.zig");
const source = @import("../scraper/source.zig");
const fixture = @import("../indexing/testing.zig");
const fallback = @import("index_source.zig");
const a = std.testing.allocator;
const Database = struct {
    directory: std.testing.TmpDir,
    path: []u8,
    value: rocks.Database,
    fn open() !*Database {
        const self = try a.create(Database);
        errdefer a.destroy(self);
        self.directory = std.testing.tmpDir(.{});
        errdefer self.directory.cleanup();
        const base = try self.directory.dir.realpathAlloc(a, ".");
        defer a.free(base);
        self.path = try std.fs.path.join(a, &.{ base, "validator-fetch" });
        errdefer a.free(self.path);
        self.value = try rocks.Database.open(a, self.path, .{ .sync = true });
        return self;
    }
    fn deinit(self: *Database) void {
        self.value.deinit();
        a.free(self.path);
        self.directory.cleanup();
        a.destroy(self);
    }
};
const Endpoint = struct {
    base: fixture.Chain,
    failure: ?anyerror = null,
    tip_failure: ?anyerror = null,
    calls: usize = 0,
    delay_ms: u64 = 0,
    fn cast(ctx: *anyopaque) *Endpoint {
        return @ptrCast(@alignCast(ctx));
    }
    fn interface(self: *Endpoint) source.Source {
        return .{ .context = self, .header_fn = header, .events_fn = events, .stream_tip_fn = tip, .raw_sequence_fn = raw, .sequence_mode = true };
    }
    fn header(ctx: *anyopaque, selector: source.Selector, fresh: bool) !source.Header {
        const inner = cast(ctx).base.interface();
        return inner.header_fn(inner.context, selector, fresh);
    }
    fn tip(ctx: *anyopaque, stream: usize) !source.Tip {
        const self = cast(ctx);
        if (self.tip_failure) |err| return err;
        return self.base.interface().streamTip(stream);
    }
    fn events(_: *anyopaque, _: std.mem.Allocator, _: u64, _: u64, _: [4]u32) !source.Batch {
        return error.ExpectedSequenceFixture;
    }
    fn raw(ctx: *anyopaque, alloc: std.mem.Allocator, stream: usize, from: u32, through: u32) !source.Batch {
        const self = cast(ctx);
        self.calls += 1;
        if (from <= 1) if (self.failure) |err| {
            if (self.delay_ms != 0) std.Thread.sleep(self.delay_ms * std.time.ns_per_ms);
            return err;
        };
        return self.base.interface().rawSequence(alloc, stream, from, through);
    }
};
const Readers = struct {
    peers: [2]Endpoint,
    selected: usize = 0,
    rotations: usize = 0,
    cancel: ?*const std.atomic.Value(bool) = null,
    fn cast(ctx: *anyopaque) *Readers {
        return @ptrCast(@alignCast(ctx));
    }
    fn current(ctx: *anyopaque) !source.Source {
        const self = cast(ctx);
        return self.peers[self.selected].interface();
    }
    fn advance(ctx: *anyopaque) !void {
        const self = cast(ctx);
        self.selected = (self.selected + 1) % self.peers.len;
        self.rotations += 1;
    }
    fn bind(ctx: *anyopaque, cancel: ?*const std.atomic.Value(bool)) void {
        cast(ctx).cancel = cancel;
    }
    fn wrapper(self: *Readers) fallback.Fallback {
        return .{ .context = self, .current_fn = current, .advance_fn = advance, .bind_fn = bind, .endpoint_count = self.peers.len };
    }
};
pub fn generic(comptime Role: type, comptime prepare: anytype, comptime runIndex: anytype) !void {
    const original = fixture.events();
    var logs: [7]source.Event = undefined;
    @memcpy(logs[0..6], &original);
    logs[6] = original[4];
    logs[6].block_number = 5;
    logs[6].block_hash = @splat(0);
    std.mem.writeInt(u64, logs[6].block_hash[24..32], 5, .big);
    logs[6].data.insertion.index = 2;
    logs[6].data.insertion.message_id = @splat(55);
    var readers: Readers = .{ .peers = .{ .{ .base = .{ .logs = &logs, .sequence = true }, .failure = error.RpcHttpStatus }, .{ .base = .{ .logs = &logs, .sequence = true } } } };
    var chain: settings.Chain = undefined;
    chain.domain = 10;
    chain.contracts = .{ .mailbox = fixture.contracts.mailbox, .merkle_tree_hook = fixture.contracts.hook, .interchain_gas_paymaster = fixture.contracts.paymaster, .validator_announce = @splat(0) };
    chain.index = .{ .from = 0, .chunk = 5, .mode = .sequence, .interval = 1 };
    const database = try Database.open();
    defer database.deinit();
    var role: Role = undefined;
    role.allocator = a;
    role.chain = &chain;
    role.store = native.Store.init(a, &database.value, "validator-source");
    role.core = null;
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .validator, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    role.index_metrics = .{ .registry = registry, .chain = "generic-native-fetch", .unix_seconds = 1234 };
    role.index_fallback = readers.wrapper();
    role.cycle_clock = .{};
    role.index_due_ms = null;
    role.runtime.cancel = null;
    const core = try prepare(&role);
    defer core.deinit();
    try std.testing.expect(core.options.source_fetch_backoff);
    // The production prepare and Core path exhaust an ordinary first peer
    // failure before scheduling backoff. A healthy peer stores both leaves now.
    const immediate = try runIndex(&role, core, 0);
    try std.testing.expectEqual(@as(usize, 1), immediate.ranges);
    try std.testing.expectEqual(@as(usize, 1), readers.peers[0].calls);
    try std.testing.expectEqual(@as(usize, 1), readers.peers[1].calls);
    try std.testing.expectEqual(@as(u32, 0), core.fetch_retries[1].consecutive_failures);
    try std.testing.expect((try role.store.insertionByIndex(0)) != null);
    try std.testing.expect((try role.store.insertionByIndex(1)) != null);
    try expectMetric(registry, "hyperlane_contract_sync_stored_events{data_type=\"merkle_tree_hook\",chain=\"generic-native-fetch\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 2);

    // A new native database/cursor proves real5/10s scheduling and disjoint
    // forward progress, rather than replaying the successful rows above.
    const failed_db = try Database.open();
    defer failed_db.deinit();
    var failed: Role = undefined;
    failed.allocator = a;
    failed.chain = &chain;
    failed.store = native.Store.init(a, &failed_db.value, "validator-source");
    failed.core = null;
    failed.index_metrics = .{ .registry = registry, .chain = "generic-native-failure", .unix_seconds = 1234 };
    failed.index_fallback = readers.wrapper();
    failed.cycle_clock = .{};
    failed.index_due_ms = null;
    failed.runtime.cancel = null;
    readers.selected = 0;
    readers.peers[0].calls = 0;
    readers.peers[1].calls = 0;
    readers.peers[1].failure = error.RpcHttpStatus;
    const failing = try prepare(&failed);
    defer failing.deinit();
    _ = try runIndex(&failed, failing, 0);
    try std.testing.expectEqual(@as(u32, 1), failing.fetch_retries[1].consecutive_failures);
    try std.testing.expectEqual(@as(?u64, 5000), failing.fetch_retries[1].retry_at_ms);
    _ = try runIndex(&failed, failing, 4999);
    try std.testing.expectEqual(@as(usize, 1), readers.peers[0].calls);
    try std.testing.expectEqual(@as(usize, 1), readers.peers[1].calls);
    _ = try runIndex(&failed, failing, 5000);
    try std.testing.expectEqual(@as(u32, 2), failing.fetch_retries[1].consecutive_failures);
    try std.testing.expectEqual(@as(?u64, 15000), failing.fetch_retries[1].retry_at_ms);
    try expectMetric(registry, "hyperlane_contract_sync_fetch_retries{data_type=\"merkle_tree_hook\",chain=\"generic-native-failure\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 2);
    for (&readers.peers) |*peer| peer.base.count = 3;
    _ = try runIndex(&failed, failing, 10000);
    try std.testing.expect((try failed.store.insertionByIndex(2)) != null);
    try std.testing.expect((try failed.store.insertionByIndex(0)) == null);
    try std.testing.expectEqual(@as(u32, 2), failing.fetch_retries[1].consecutive_failures);
    try expectMetric(registry, "hyperlane_contract_sync_fetch_backoff_seconds{data_type=\"merkle_tree_hook\",chain=\"generic-native-failure\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 10);
    for (&readers.peers) |*peer| peer.failure = null;
    _ = try runIndex(&failed, failing, 15000);
    try std.testing.expect((try failed.store.insertionByIndex(0)) != null);
    try std.testing.expect((try failed.store.insertionByIndex(1)) != null);
    try std.testing.expectEqual(@as(u32, 0), failing.fetch_retries[1].consecutive_failures);
    try expectMetric(registry, "hyperlane_contract_sync_fetch_backoff_seconds{data_type=\"merkle_tree_hook\",chain=\"generic-native-failure\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 0);
    // Direct SDK calls may block within Core.tick. The concrete Role rebases
    // the handled failure once, at real completion, rather than shortening5s.
    const clock_db = try Database.open();
    defer clock_db.deinit();
    var clocked: Role = undefined;
    clocked.allocator = a;
    clocked.chain = &chain;
    clocked.store = native.Store.init(a, &clock_db.value, "validator-completion-clock");
    clocked.core = null;
    clocked.index_metrics = null;
    clocked.index_fallback = readers.wrapper();
    clocked.cycle_clock = .{};
    clocked.index_due_ms = null;
    clocked.runtime.cancel = null;
    for (&readers.peers) |*peer| {
        peer.failure = error.RpcHttpStatus;
        peer.delay_ms = 25;
    }
    const clock_core = try prepare(&clocked);
    defer clock_core.deinit();
    try clocked.cycle_clock.begin(100);
    _ = try runIndex(&clocked, clock_core, 100);
    const completed = clocked.cycle_clock.now(100);
    clocked.cycle_clock.end();
    try std.testing.expect(clock_core.fetch_retries[1].retry_at_ms.? >= 5150);
    try std.testing.expect(clock_core.fetch_retries[1].retry_at_ms.? <= completed +| 5000);
    try std.testing.expectEqual(@as(u32, 1), clock_core.fetch_retries[1].consecutive_failures);
    for (&readers.peers) |*peer| peer.delay_ms = 0;
    // Control/security/allocation failures never rotate or enter failed-range
    // scheduling. Actual source callback error values remain unchanged.
    for ([_]anyerror{ error.PendingReadIo, error.RequestCancelled, error.SourceReadDeadline, error.RequestDeadlineExceeded, error.ValidatorReorg, error.MessageMetadataRefused, error.OutOfMemory }) |err| {
        const controlled_db = try Database.open();
        defer controlled_db.deinit();
        var controlled: Role = undefined;
        controlled.allocator = a;
        controlled.chain = &chain;
        controlled.store = native.Store.init(a, &controlled_db.value, "validator-source");
        controlled.core = null;
        controlled.index_metrics = null;
        controlled.index_fallback = readers.wrapper();
        controlled.cycle_clock = .{};
        controlled.index_due_ms = null;
        controlled.runtime.cancel = null;
        const initial_selected = readers.selected;
        const rotations = readers.rotations;
        readers.peers[initial_selected].failure = err;
        const indexer = try prepare(&controlled);
        defer indexer.deinit();
        try std.testing.expectError(err, runIndex(&controlled, indexer, 20000));
        try std.testing.expectEqual(@as(u32, 0), indexer.fetch_retries[1].consecutive_failures);
        try std.testing.expectEqual(rotations, readers.rotations);
    }
}

const http = @import("../../ops/http.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const EvmIndexer = @import("../../evm/indexer.zig");
const votes = @import("votes.zig");
const Curl = @import("../../net/curl.zig");
const HeaderFault = enum { hash, parent, timestamp, number };
const HttpFault = struct { status: u16, body: []const u8, header: ?HeaderFault = null };
const HttpEndpoint = struct {
    fault: ?HttpFault = null,
    tip_failing: std.atomic.Value(bool) = .init(false),
    tip_delay_ms: std.atomic.Value(u64) = .init(0),
    tip_calls: std.atomic.Value(usize) = .init(0),
    header_calls: std.atomic.Value(usize) = .init(0),
    failing: std.atomic.Value(bool) = .init(false),
    calls: std.atomic.Value(usize) = .init(0),
    delay_ms: std.atomic.Value(u64) = .init(0),
    fn handle(context: *anyopaque, alloc: std.mem.Allocator, request: http.Request, cancel: *const std.atomic.Value(bool)) !http.Response {
        const self: *HttpEndpoint = @ptrCast(@alignCast(context));
        const parsed = try std.json.parseFromSlice(std.json.Value, alloc, request.body, .{});
        defer parsed.deinit();
        const raw = parsed.value.object;
        const method = raw.get("method").?.string;
        const id = raw.get("id").?;
        var bytes: []u8 = undefined;
        if (std.mem.eql(u8, method, "eth_getLogs")) {
            _ = self.calls.fetchAdd(1, .monotonic);
            const delay = self.delay_ms.load(.acquire);
            for (0..delay) |_| {
                if (cancel.load(.acquire)) return error.RequestCancelled;
                std.Thread.sleep(std.time.ns_per_ms);
            }
            if (self.failing.load(.acquire) and (self.fault == null or self.fault.?.header == null)) {
                if (self.fault) |fault| return http.Response.init(alloc, fault.status, &.{}, fault.body);
                return http.Response.init(alloc, 503, &.{}, "fixture unavailable");
            }
            bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = [_]std.json.Value{} }, .{});
        } else if (std.mem.eql(u8, method, "eth_call")) {
            _ = self.tip_calls.fetchAdd(1, .monotonic);
            const delay = self.tip_delay_ms.load(.acquire);
            for (0..delay) |_| {
                if (cancel.load(.acquire)) return error.RequestCancelled;
                std.Thread.sleep(std.time.ns_per_ms);
            }
            if (self.tip_failing.load(.acquire) and (self.fault == null or self.fault.?.header == null)) {
                if (self.fault) |fault| return http.Response.init(alloc, fault.status, &.{}, fault.body);
                return http.Response.init(alloc, 503, &.{}, "tip fixture unavailable");
            }
            var word: [32]u8 = @splat(0);
            word[31] = 2;
            const count = try abi.hexAlloc(alloc, &word);
            defer alloc.free(count);
            bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = count }, .{});
        } else if (std.mem.eql(u8, method, "eth_getBlockByNumber")) {
            _ = self.header_calls.fetchAdd(1, .monotonic);
            const parameter = raw.get("params").?.array.items[0].string;
            const number = if (std.mem.eql(u8, parameter, "latest")) "0x5" else parameter;
            const hash = try abi.hexAlloc(alloc, &@as([32]u8, @splat(7)));
            defer alloc.free(hash);
            const fault = if (self.fault) |value| if (self.failing.load(.acquire) or self.tip_failing.load(.acquire)) value.header else null else null;
            if (fault != null) for (0..self.delay_ms.load(.acquire)) |_| {
                if (cancel.load(.acquire)) return error.RequestCancelled;
                std.Thread.sleep(std.time.ns_per_ms);
            };
            bytes = try std.json.Stringify.valueAlloc(alloc, .{ .jsonrpc = "2.0", .id = id, .result = .{ .number = if (fault == .number) "0x01" else number, .hash = if (fault == .hash) "0xzz" else hash, .parentHash = if (fault == .parent) "0xzz" else hash, .timestamp = if (fault == .timestamp) "0x01" else "0x1" } }, .{});
        } else return error.UnexpectedFixtureMethod;
        defer alloc.free(bytes);
        return http.Response.init(alloc, 200, &.{.{ .name = "Content-Type", .value = "application/json" }}, bytes);
    }
};
pub fn evm(comptime Role: type, comptime indexOneRange: anytype, comptime initialize: anytype) !void {
    return evmTransport(Role, indexOneRange, initialize, true, null);
}
pub fn evmResponseVariants(comptime Role: type, comptime indexOneRange: anytype, comptime initialize: anytype, comptime use_native: bool) !void {
    // Original native503 remains its own unchanged default fixture. The std
    // path also exercises that exact plain503 body before additive faults.
    if (!use_native) try evmTransport(Role, indexOneRange, initialize, false, null);
    for ([_]HttpFault{
        .{ .status = 200, .body = "fixture unavailable" },
        .{ .status = 200, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" },
        .{ .status = 429, .body = "fixture rate limited" },
    }) |fault| try evmTransport(Role, indexOneRange, initialize, use_native, fault);
}
pub fn evmHeaderVariants(comptime Role: type, comptime indexOneRange: anytype, comptime initialize: anytype, comptime use_native: bool) !void {
    for ([_]HeaderFault{ .hash, .parent, .timestamp, .number }) |field_name| try evmTransport(Role, indexOneRange, initialize, use_native, .{ .status = 200, .body = "", .header = field_name });
}
fn evmTransport(comptime Role: type, comptime indexOneRange: anytype, comptime initialize: anytype, comptime use_native: bool, fault: ?HttpFault) !void {
    // Real sockets, native/std HTTP, production Indexer hash fences and the
    // actual native Rocks cursor. No mock transport bypasses JSON-RPC parsing.
    var endpoints: [2]HttpEndpoint = .{ .{}, .{} };
    for (&endpoints) |*endpoint| endpoint.fault = fault;
    endpoints[0].failing.store(true, .release);
    const first = try http.Server.start(a, .{ .address = try std.net.Address.parseIp4("127.0.0.1", 0) }, .{ .context = &endpoints[0], .handle_fn = HttpEndpoint.handle });
    defer first.deinit();
    const second = try http.Server.start(a, .{ .address = try std.net.Address.parseIp4("127.0.0.1", 0) }, .{ .context = &endpoints[1], .handle_fn = HttpEndpoint.handle });
    defer second.deinit();
    const urls = [_][]u8{ try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{first.address().getPort()}), try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{second.address().getPort()}) };
    defer for (urls) |url| a.free(url);
    const native_library: ?[]u8 = if (use_native) std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try a.dupe(u8, if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4"),
        else => return err,
    } else null;
    defer if (native_library) |library| a.free(library);
    var transport: ?Curl.Client = if (native_library) |library| try Curl.Client.init(a, library) else null;
    defer if (transport) |*native_transport| native_transport.deinit();
    var clients: [2]rpc.RpcClient = undefined;
    for (&clients, urls) |*client, url| client.* = try rpc.RpcClient.init(a, url, .{ .native_transport = if (transport) |*native_transport| native_transport else null, .timeout_ms = 3000, .connect_timeout_ms = 1000 });
    defer for (&clients) |*client| client.deinit();
    const Slot = @typeInfo(@TypeOf(@as(Role, undefined).slots)).pointer.child;
    var slots: [2]Slot = undefined;
    for (&slots, &clients) |*slot, *client| {
        slot.* = .{ .client = client, .indexer = try EvmIndexer.Indexer.init(a, client, .{ .chain_id = 1, .domain = 10, .mailbox = @splat(1), .hook = @splat(2), .paymaster = @splat(3), .reorg_period = .none }) };
        slot.indexer.chain_checked = true;
    }
    var round: [2]votes.Result = @splat(.{ .ready = true, .chain_checked = true, .count = 2, .head = .{ .number = 5, .hash = @splat(7), .parent_hash = @splat(7), .timestamp = 1 } });
    var chain: settings.Chain = undefined;
    chain.index = .{ .from = 0, .chunk = 2, .mode = .block, .interval = 1 };
    const database = try Database.open();
    defer database.deinit();
    var role: Role = undefined;
    role.allocator = a;
    role.chain = &chain;
    role.runtime.cancel = null;
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .validator, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    var critical: @import("../../ops/critical_metrics.zig").Tracker = .{ .registry = registry, .chain = "evm-native-init" };
    role.runtime.critical = &critical;
    const tip_cache = try @import("../../net/dynamic_tip_cache.zig").Cache.init(a, .{});
    defer tip_cache.deinit();
    role.runtime.dynamic_tip_cache = tip_cache;
    role.primary_metrics = null;
    role.index_metrics = .{ .registry = registry, .chain = "evm-native-init", .unix_seconds = 1234 };
    role.cursor_initialization = .{};
    role.slots = &slots;
    role.store = native.Store.init(a, &database.value, "validator-evm-source");
    role.sequence_store = .{ .store = &role.store, .stream = .insertion };
    role.sequence_cursor = null;
    defer if (role.sequence_cursor) |*value| value.deinit();
    role.fetch_retry = .{};
    role.index_due_ms = null;
    role.cycle_clock = .{};
    role.canonical = std.AutoHashMap(u32, @import("../validator.zig").Observation).init(a);
    defer role.canonical.deinit();
    role.primary = 0;
    role.read_preferred = 0;
    role.round_results = &round;
    try std.testing.expect(try indexOneRange(&role, 0));
    try std.testing.expectEqual(@as(usize, if (fault != null and fault.?.header != null) 0 else 1), endpoints[0].calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), endpoints[1].calls.load(.acquire));
    try std.testing.expectEqual(@as(u32, 0), role.fetch_retry.consecutive_failures);
    try std.testing.expectEqual(@as(?usize, 1), role.primary);

    // Drop only the local test cursor to admit the same logical range again.
    // Both real HTTP readers now fail; one logical5s failure follows both.
    role.sequence_cursor.?.deinit();
    role.sequence_cursor = null;
    role.primary = 0;
    endpoints[1].failing.store(true, .release);
    for (&endpoints) |*endpoint| endpoint.delay_ms.store(25, .release);
    try role.cycle_clock.begin(1000);
    try std.testing.expect(!try indexOneRange(&role, 1000));
    const failed_forward = role.sequence_cursor.?.forward;
    const completed = role.cycle_clock.now(1000);
    role.cycle_clock.end();
    try std.testing.expectEqual(@as(u32, 1), role.fetch_retry.consecutive_failures);
    try expectMetric(registry, "hyperlane_contract_sync_fetch_retries{data_type=\"merkle_tree_hook\",chain=\"evm-native-init\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 1);
    try expectMetric(registry, "hyperlane_contract_sync_fetch_backoff_seconds{data_type=\"merkle_tree_hook\",chain=\"evm-native-init\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 5);
    const retry_at = role.fetch_retry.retry_at_ms.?;
    try std.testing.expect(retry_at >= 6050);
    try std.testing.expect(retry_at <= completed +| 5000);
    const calls = endpoints[0].calls.load(.acquire) + endpoints[1].calls.load(.acquire);
    try std.testing.expect(!try indexOneRange(&role, retry_at - 1));
    try std.testing.expectEqual(calls, endpoints[0].calls.load(.acquire) + endpoints[1].calls.load(.acquire));
    try std.testing.expect(!try indexOneRange(&role, retry_at));
    try std.testing.expectEqualDeep(failed_forward, role.sequence_cursor.?.forward);
    try std.testing.expectEqual(@as(u32, 2), role.fetch_retry.consecutive_failures);
    try expectMetric(registry, "hyperlane_contract_sync_fetch_retries{data_type=\"merkle_tree_hook\",chain=\"evm-native-init\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 2);
    try expectMetric(registry, "hyperlane_contract_sync_fetch_backoff_seconds{data_type=\"merkle_tree_hook\",chain=\"evm-native-init\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 10);
    try std.testing.expectEqual(@as(?u64, retry_at + 10000), role.fetch_retry.retry_at_ms);
    for (&endpoints) |*endpoint| endpoint.failing.store(false, .release);
    try std.testing.expect(try indexOneRange(&role, retry_at + 10000));
    try std.testing.expectEqual(@as(u32, 0), role.fetch_retry.consecutive_failures);
    try expectMetric(registry, "hyperlane_contract_sync_fetch_backoff_seconds{data_type=\"merkle_tree_hook\",chain=\"evm-native-init\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"}", 0);
    // Exact Source initialization reads latest count/tip, tries the next healthy
    // endpoint within one attempt, and has a separate bounded startup policy.
    role.sequence_cursor.?.deinit();
    role.sequence_cursor = null;
    endpoints[0].tip_failing.store(true, .release);
    role.read_preferred = 0;
    try std.testing.expect(!critical.published);
    try std.testing.expect(try initialize(&role, 0));
    try std.testing.expect(critical.published and critical.reasons == 0);
    try std.testing.expectEqual(@as(u8, 0), role.cursor_initialization.failures);
    try std.testing.expectEqual(@as(usize, if (fault != null and fault.?.header != null) 0 else 1), endpoints[0].tip_calls.load(.acquire));
    try std.testing.expectEqual(@as(usize, 1), endpoints[1].tip_calls.load(.acquire));
    for (&clients) |*client| {
        try std.testing.expect(!client.options.indexer_tip_cache);
        try std.testing.expect(client.options.dynamic_tip_cache == null);
    }
    // Indexer latest-head entries may exist, but the shared client is restored
    // before a fresh safety/vote read and cannot consume that cache entry.
    const before_fresh = endpoints[1].header_calls.load(.acquire);
    _ = try clients[1].blockHeader(.latest);
    try std.testing.expectEqual(before_fresh + 1, endpoints[1].header_calls.load(.acquire));
    role.sequence_cursor.?.deinit();
    role.sequence_cursor = null;
    role.cursor_initialization = .{};
    endpoints[1].tip_failing.store(true, .release);
    for (0..10) |i| {
        const at = i * 2000;
        try std.testing.expect(!try initialize(&role, at));
        try std.testing.expectEqual(@as(u8, @intCast(i + 1)), role.cursor_initialization.failures);
        const before = endpoints[0].tip_calls.load(.acquire) + endpoints[1].tip_calls.load(.acquire);
        try std.testing.expect(!try initialize(&role, at + 1999));
        try std.testing.expectEqual(before, endpoints[0].tip_calls.load(.acquire) + endpoints[1].tip_calls.load(.acquire));
    }
    try std.testing.expect(critical.reasons == 0);
    try std.testing.expectError(error.ValidatorCursorInitializationExhausted, initialize(&role, 20000));
    try std.testing.expect(critical.reasons != 0);
    try std.testing.expect(role.sequence_cursor == null);
    if (use_native) {
        // Actual native curl code28 is a completed physical request timeout.
        // It must not be mistaken for an owner absolute deadline and retried forever.
        role.cursor_initialization = .{};
        for (&endpoints, &clients) |*endpoint, *client| {
            endpoint.tip_failing.store(false, .release);
            endpoint.tip_delay_ms.store(100, .release);
            client.options.timeout_ms = 20;
        }
        try std.testing.expect(!try initialize(&role, 0));
        try std.testing.expectEqual(@as(u8, 1), role.cursor_initialization.failures);
        for (&endpoints, &clients) |*endpoint, *client| {
            endpoint.tip_delay_ms.store(0, .release);
            client.options.timeout_ms = 3000;
        }
    }
    // Cancellation is never a completed initialization attempt.
    role.cursor_initialization = .{};
    var stop = std.atomic.Value(bool).init(true);
    role.runtime.cancel = &stop;
    try std.testing.expectError(error.RequestCancelled, initialize(&role, 0));
    try std.testing.expectEqual(@as(u8, 0), role.cursor_initialization.failures);
    role.runtime.cancel = null;
    for (&endpoints) |*endpoint| endpoint.tip_failing.store(false, .release);
    try std.testing.expect(try initialize(&role, 0));
    // A cooperative cursor yield is immediate, never a read of the inactive
    // sleep union payload (which would trap in ReleaseSafe).
    role.sequence_cursor.?.options.skip_budget = 1;
    _ = try role.store.storeInsertion(.{ .leaf_index = role.sequence_cursor.?.forward.sequence, .message_id = @splat(9) }, 5);
    try std.testing.expect(!try indexOneRange(&role, 30000));
    try std.testing.expectEqual(@as(?u64, 30000), role.index_due_ms);
}

pub fn genericInitialization(comptime Role: type, comptime initialize: anytype) !void {
    const logs = fixture.events();
    var readers: Readers = .{ .peers = .{ .{ .base = .{ .logs = &logs, .sequence = true }, .tip_failure = error.RpcHttpStatus }, .{ .base = .{ .logs = &logs, .sequence = true } } } };
    var chain: settings.Chain = undefined;
    chain.domain = 10;
    chain.contracts = .{ .mailbox = fixture.contracts.mailbox, .merkle_tree_hook = fixture.contracts.hook, .interchain_gas_paymaster = fixture.contracts.paymaster, .validator_announce = @splat(0) };
    chain.index = .{ .from = 0, .chunk = 5, .mode = .sequence, .interval = 1 };
    const database = try Database.open();
    defer database.deinit();
    var role: Role = undefined;
    role.allocator = a;
    role.chain = &chain;
    role.store = native.Store.init(a, &database.value, "validator-cursor-init");
    role.core = null;
    role.index_metrics = null;
    defer if (role.core) |*core| core.deinit();
    role.index_fallback = readers.wrapper();
    role.cycle_clock = .{};
    role.index_due_ms = null;
    role.runtime.cancel = null;
    role.runtime.critical = null;
    role.cursor_initialization = .{};
    try std.testing.expect(try initialize(&role, 0));
    try std.testing.expect(role.core.?.cursors[1] != null);
    try std.testing.expectEqual(@as(u8, 0), role.cursor_initialization.failures);
    try std.testing.expectEqual(@as(usize, 1), readers.rotations);
    // Fallback exhaustion belongs to ONE logical startup attempt.
    role.core.?.deinit();
    role.core = null;
    role.index_metrics = null;
    role.cursor_initialization = .{};
    readers.peers[1].tip_failure = error.RpcHttpStatus;
    try std.testing.expect(!try initialize(&role, 0));
    try std.testing.expectEqual(@as(u8, 1), role.cursor_initialization.failures);
    try std.testing.expectEqual(@as(?u64, 2000), role.index_due_ms);
    const rotations = readers.rotations;
    try std.testing.expect(!try initialize(&role, 1999));
    try std.testing.expectEqual(rotations, readers.rotations);
    for (&readers.peers) |*peer| peer.tip_failure = null;
    try std.testing.expect(try initialize(&role, 2000));
    try std.testing.expect(role.cursor_initialization.initialized);
    // Ordinary later fetch failures are not cursor initialization failures.
    try std.testing.expectEqual(@as(u8, 1), role.cursor_initialization.failures);
    role.core.?.deinit();
    role.core = null;
    role.index_metrics = null;
    role.cursor_initialization = .{};
    readers.peers[readers.selected].tip_failure = error.PendingReadIo;
    try std.testing.expectError(error.PendingReadIo, initialize(&role, 5000));
    try std.testing.expectEqual(@as(u8, 0), role.cursor_initialization.failures);
    for (&readers.peers) |*peer| peer.tip_failure = error.RequestDeadlineExceeded;
    role.index_fallback.native_timeouts = true;
    try std.testing.expect(!try initialize(&role, 5000));
    try std.testing.expectEqual(@as(u8, 1), role.cursor_initialization.failures);
}

fn expectMetric(registry: *@import("../../ops/metrics.zig").Registry, prefix: []const u8, expected: i64) !void {
    const wire = try registry.render(a);
    defer a.free(wire);
    var lines = std.mem.splitScalar(u8, wire, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, prefix)) continue;
        const at = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.InvalidMetricSample;
        return std.testing.expectEqual(expected, try std.fmt.parseInt(i64, line[at + 1 ..], 10));
    }
    std.debug.print("missing metric prefix: {s}\n{s}\n", .{ prefix, wire });
    return error.MissingMetricSample;
}
