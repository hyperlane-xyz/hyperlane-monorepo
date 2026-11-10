const std = @import("std");
const fixture_curl_library = if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4";
comptime {
    _ = @import("db/bzip2_glue.zig");
}
const public_relay = @import("agents/relayer/public_relay.zig");
const control = @import("agents/relayer/control.zig");
const settings = @import("settings/root.zig");
const types = @import("settings/types.zig");
const protocol = @import("protocol/root.zig");
const native = @import("agents/store.zig");
const loader = @import("agents/loader.zig");
const relay_policy = @import("agents/relay_policy.zig");
const origin_signers = @import("agents/origin_signers.zig");
const origin_tasks = @import("agents/origin_tasks.zig");
const denylist = @import("ops/runtime_denylist.zig");
const relay_api = @import("ops/admin/relay_api.zig");
const admin_json = @import("ops/admin/json.zig");
const resources = @import("agents/chain_source.zig");
const abi = @import("evm/codecs.zig");
const db = @import("db/root.zig");
const metrics = @import("ops/metrics.zig");
const metric_schema = @import("ops/metrics_schema.zig");
const http = @import("ops/http.zig");
const admin_testing = @import("ops/admin/testing.zig");
const A = std.mem.Allocator;

fn relayerSettings() types.Relayer {
    return .{
        .gas_payment_enforcement = &.{},
        .whitelist = &.{},
        .blacklist = &.{},
        .address_blacklist = &.{},
        .metric_app_contexts = &.{},
        .ism_cache_configs = &.{},
        .relay_api_rate_limit_max_requests = null,
        .relay_api_rate_limit_window_secs = null,
        .relay_api_cors_origins = &.{},
        .relay_chains = &.{"origin"},
        .db = "unused",
        .transaction_gas_limit = null,
        .skip_transaction_gas_limit_for = &.{},
        .allow_local_checkpoint_syncers = false,
        .allow_contract_call_caching = false,
        .max_message_retries = 10,
        .tx_id_indexing_enabled = false,
        .igp_indexing_enabled = true,
        .runtime_denylist_url = null,
        .runtime_denylist_poll_interval_seconds = 60,
        .websocket_url = null,
        .websocket_authority_enabled = false,
        .relay_api_enabled = true,
        .relay_api_port = null,
    };
}

fn evmAddress32(byte: u8) [32]u8 {
    var result: [32]u8 = @splat(0);
    result[12..32].* = @splat(byte);
    return result;
}

fn testChain(name: []const u8, domain: u32, url: []const u8) types.Chain {
    return .{
        .name = name,
        .domain = domain,
        .protocol = .ethereum,
        .chain_id = "1",
        .technical_stack = .other,
        .rpc_urls = &.{url},
        .grpc_urls = &.{},
        .contracts = .{ .mailbox = evmAddress32(1), .interchain_gas_paymaster = evmAddress32(2), .validator_announce = evmAddress32(3), .merkle_tree_hook = evmAddress32(4) },
        .index = .{},
        .signer = null,
        .identity = null,
        .ccs_signer = null,
        .reorg = .{ .blocks = 0 },
        .confirmations = 0,
        .estimated_block_time = 1,
        .native_token = .{ .decimals = 18, .symbol = "TEST", .denom = "test" },
        .connection = .{ .ethereum = .{
            .consensus = .single,
            .consider_null_transaction_receipt = false,
            .fallback_hedge_delay_ms = null,
            .fallback_hedge_timeout_ms = null,
            .transaction_overrides = std.mem.zeroes(types.TransactionOverrides),
            .mev_submission = null,
        } },
        .submitter = .classic,
        .max_batch_size = 1,
        .batch_contract_address = null,
        .bypass_batch_simulation = false,
        .max_submit_queue_length = null,
        .ignore_reorg_reports = false,
    };
}

const TestOriginLane = struct { loader: ?loader.Loader = null, policy: ?relay_policy.Policy = null };
const TestActive = struct {
    origin_index: usize,
    message: native.OwnedMessage,
    next_ms: u64 = 0,
    retained_bytes: usize,
    signer_prepare: origin_signers.Prepare = .{},
};
const TestHandle = struct { chain: *const types.Chain, store: *native.Store };
const TestSlot = struct {
    chain: *const types.Chain,
    store: *native.Store,
    pub fn handle(self: *TestSlot) ?TestHandle {
        return .{ .chain = self.chain, .store = self.store };
    }
};
const TestOrigins = struct { slots: []TestSlot };
const TestOptions = struct {
    max_active: usize = 64,
    max_active_bytes: usize = 1024 * 1024,
    max_retained_bytes: usize = 1024 * 1024,
};
const TestOwner = struct {
    allocator: A,
    settings: *const settings.Settings,
    origins: *TestOrigins,
    options: TestOptions = .{},
    memory_mutex: std.Thread.Mutex = .{},
    retained_bytes: usize = 0,
    denylist_ready: std.atomic.Value(bool) = .init(true),
    effects_halted: std.atomic.Value(bool) = .init(false),
};
const TestNonceManager = struct {
    scan_resume: ?u256 = null,
    pub fn overwriteUpper(_: *TestNonceManager, _: A, _: ?u256) !void {}
};
const TestLanderStore = struct {
    pub fn highestTransactionIndex(_: *TestLanderStore, _: A) !u32 {
        return 0;
    }
};
const TestService = struct {
    nonces: TestNonceManager = .{},
    store: TestLanderStore = .{},
    scan_cursor: u32 = 0,
    queued_transactions: u32 = 0,
    recovery_complete: bool = true,
    recovery_blocked: bool = false,
};
const TestLane = struct {
    owner: *TestOwner,
    chain: *const types.Chain,
    origins: []TestOriginLane,
    active: std.ArrayList(*TestActive) = .empty,
    active_bytes: usize = 0,
    transactions: ?TestService = null,
};
const TestAuthority = struct {
    chain: *const types.Chain,
    store: *native.Store,
    fn handle(context: *anyopaque, domain: u32) ?origin_tasks.Handle {
        const self: *TestAuthority = @ptrCast(@alignCast(context));
        if (domain != self.chain.domain) return null;
        return .{ .chain = self.chain, .store = self.store, .history = undefined };
    }
};

const NativeFixture = struct {
    configured: settings.Settings,
    environment: std.process.EnvMap,
    runtime: denylist.RuntimeDenylist,
    database: db.rocks.Database,
    store: native.Store,
    authority: TestAuthority,
    hub: control.Hub,
    controls: [2]*control.Control,
    origin_slots: [1]TestSlot,
    origin_set: TestOrigins,
    origin_lanes: [2][1]TestOriginLane,
    owner: TestOwner,
    lanes: [2]TestLane,
    public: *public_relay.PublicRelay,
    rpc_urls: [][]const u8,
    cancel: std.atomic.Value(bool) = .init(false),

    fn init(a: A, path: []const u8, url: []const u8) !*NativeFixture {
        const self = try a.create(NativeFixture);
        errdefer a.destroy(self);
        const chains = try a.alloc(types.Chain, 3);
        errdefer a.free(chains);
        chains[0] = testChain("origin", 1, url);
        chains[1] = testChain("destination-a", 2, url);
        chains[2] = testChain("destination-b", 3, url);
        const rpc_urls = try a.alloc([]const u8, 3);
        errdefer a.free(rpc_urls);
        for (chains, 0..) |*chain, index| {
            rpc_urls[index] = url;
            chain.rpc_urls = rpc_urls[index .. index + 1];
        }
        self.* = .{
            .configured = undefined,
            .environment = std.process.EnvMap.init(a),
            .runtime = try denylist.RuntimeDenylist.init(a, null),
            .database = try db.rocks.Database.open(a, path, .{ .sync = true }),
            .store = undefined,
            .authority = undefined,
            .hub = undefined,
            .controls = undefined,
            .origin_slots = undefined,
            .origin_set = undefined,
            .origin_lanes = .{ .{.{}}, .{.{}} },
            .owner = undefined,
            .lanes = undefined,
            .public = undefined,
            .rpc_urls = rpc_urls,
        };
        errdefer self.environment.deinit();
        errdefer self.runtime.deinit();
        errdefer self.database.deinit();
        self.configured.chains = chains;
        self.configured.role = .{ .relayer = relayerSettings() };
        self.store = native.Store.init(a, &self.database, "origin");
        self.authority = .{ .chain = &chains[0], .store = &self.store };
        self.origin_slots[0] = .{ .chain = &chains[0], .store = &self.store };
        self.origin_set = .{ .slots = &self.origin_slots };
        self.owner = .{ .allocator = a, .settings = &self.configured, .origins = &self.origin_set };
        for (&self.lanes, &self.origin_lanes, 0..) |*lane, *origin_lanes, index| lane.* = .{ .owner = &self.owner, .chain = &chains[index + 1], .origins = origin_lanes };
        self.hub = try control.Hub.init(a, &self.configured, &self.environment, undefined, undefined, null, &self.runtime);
        errdefer self.hub.deinit();
        self.controls[0] = try control.Control.init(&self.hub, &chains[1]);
        errdefer self.controls[0].deinit();
        self.controls[1] = try control.Control.init(&self.hub, &chains[2]);
        errdefer self.controls[1].deinit();
        const options: resources.Options = .{ .curl_library = fixture_curl_library, .allow_insecure_loopback = true };
        self.public = try public_relay.PublicRelay.initWithAuthority(a, &self.configured, &self.environment, .{ .context = &self.authority, .handle_fn = TestAuthority.handle }, &self.hub, options);
        return self;
    }

    fn deinit(self: *NativeFixture, a: A) void {
        self.public.deinit();
        for (&self.lanes) |*lane| {
            for (lane.active.items) |item| {
                self.owner.retained_bytes -= item.retained_bytes;
                item.message.deinit();
                a.destroy(item);
            }
            lane.active.deinit(a);
        }
        self.controls[0].deinit();
        self.controls[1].deinit();
        std.debug.assert(self.owner.retained_bytes == 0);
        self.hub.deinit();
        for (&self.origin_lanes) |*lanes| for (lanes) |*origin| {
            if (origin.loader) |*value| value.deinit();
            if (origin.policy) |*value| value.deinit();
        };
        self.database.deinit();
        self.runtime.deinit();
        self.environment.deinit();
        a.free(self.rpc_urls);
        a.free(self.configured.chains);
        a.destroy(self);
    }

    fn drain(self: *NativeFixture) !void {
        for (self.controls, &self.lanes) |lane_control, *lane| _ = try lane_control.drain(lane, .{ .unix_ms = 1000, .monotonic_ms = 100 }, &self.cancel);
    }

    fn drainUntil(self: *NativeFixture, done: *const std.atomic.Value(bool)) !void {
        var attempts: usize = 0;
        while (!done.load(.acquire)) {
            try self.drain();
            attempts += 1;
            if (attempts > 5000) return error.FixtureWorkerStalled;
            std.Thread.sleep(std.time.ns_per_ms);
        }
    }
};

const SubmitCaller = struct {
    owner: relay_api.SubmissionOwner,
    origin: []const u8,
    hash: []const u8,
    arena: std.heap.ArenaAllocator,
    cancel: std.atomic.Value(bool) = .init(false),
    done: std.atomic.Value(bool) = .init(false),
    result: ?relay_api.RelayResult = null,
    failure: ?anyerror = null,

    fn run(self: *SubmitCaller) void {
        const result = self.owner.submit_fn(self.owner.context, self.arena.allocator(), self.origin, self.hash, &self.cancel) catch |err| {
            self.failure = err;
            self.done.store(true, .release);
            return;
        };
        self.result = result;
        self.done.store(true, .release);
    }
};

const TestClock = struct {
    now_ns: u64 = 0,
    fn monotonic(context: *anyopaque) u64 {
        const self: *TestClock = @ptrCast(@alignCast(context));
        return self.now_ns;
    }
    fn unix(context: *anyopaque) i64 {
        const self: *TestClock = @ptrCast(@alignCast(context));
        return @intCast(self.now_ns / std.time.ns_per_s);
    }
    fn interface(self: *TestClock) relay_api.Clock {
        return .{ .context = self, .monotonic_ns = monotonic, .unix_seconds = unix };
    }
};

const RelayHttpCaller = struct {
    handler: http.Handler,
    request: admin_testing.TestRequest,
    arena: std.heap.ArenaAllocator,
    cancel: std.atomic.Value(bool) = .init(false),
    done: std.atomic.Value(bool) = .init(false),
    response: ?http.Response = null,
    failure: ?anyerror = null,

    fn init(a: A, handler: http.Handler, origin: []const u8, hash: []const u8) !RelayHttpCaller {
        const body = try std.fmt.allocPrint(a, "{{\"origin_chain\":\"{s}\",\"tx_hash\":\"{s}\"}}", .{ origin, hash });
        defer a.free(body);
        return .{ .handler = handler, .request = try admin_testing.TestRequest.init(a, "POST", "/relay", body), .arena = std.heap.ArenaAllocator.init(a) };
    }

    fn run(self: *RelayHttpCaller) void {
        const response = self.handler.handle_fn(self.handler.context, self.arena.allocator(), self.request.value, &self.cancel) catch |err| {
            self.failure = err;
            self.done.store(true, .release);
            return;
        };
        self.response = response;
        self.done.store(true, .release);
    }

    fn deinit(self: *RelayHttpCaller) void {
        if (self.response) |*response| response.deinit();
        self.request.deinit();
        self.arena.deinit();
    }
};

const RpcFixture = struct {
    server: std.net.Server,
    receipt: []const u8,
    stall_ms: u64 = 0,
    optional_tail: bool = false,
    requests: usize = 0,
    failure: ?anyerror = null,

    fn serve(self: *RpcFixture, count: usize) void {
        for (0..count) |index| {
            // An extraction may expire after its chain check, before it can
            // send the next RPC. The disposable server must not wait forever
            // for a request the successfully canceled client will never send.
            if (self.optional_tail) {
                var fd = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
                if ((std.posix.poll(&fd, if (index == 0) 5000 else 1000) catch |err| {
                    self.failure = err;
                    return;
                }) == 0) return;
            }
            self.serveOne() catch |err| {
                if (self.optional_tail and self.requests > 0 and (err == error.FixtureUnexpectedEof or err == error.BrokenPipe or err == error.ConnectionResetByPeer)) return;
                self.failure = err;
                return;
            };
        }
    }

    fn serveOne(self: *RpcFixture) !void {
        const connection = try self.server.accept();
        defer connection.stream.close();
        var request: [1024 * 1024]u8 = undefined;
        var used: usize = 0;
        var body: []const u8 = "";
        while (true) {
            const read = try connection.stream.read(request[used..]);
            if (read == 0) return error.FixtureUnexpectedEof;
            used += read;
            if (std.mem.indexOf(u8, request[0..used], "\r\n\r\n")) |header_end| {
                const start = std.ascii.indexOfIgnoreCase(request[0..header_end], "content-length: ") orelse return error.FixtureMissingLength;
                const value_start = start + "content-length: ".len;
                const value_end = std.mem.indexOfPos(u8, request[0..used], value_start, "\r\n") orelse return error.FixtureMissingLength;
                const length = try std.fmt.parseInt(usize, request[value_start..value_end], 10);
                if (used < header_end + 4 + length) continue;
                body = request[header_end + 4 ..][0..length];
                break;
            }
        }
        var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, body, .{});
        defer parsed.deinit();
        const method = parsed.value.object.get("method") orelse return error.FixtureMissingMethod;
        const id = parsed.value.object.get("id") orelse return error.FixtureMissingId;
        var out = std.Io.Writer.Allocating.init(std.testing.allocator);
        defer out.deinit();
        try out.writer.writeAll("{\"jsonrpc\":\"2.0\",\"id\":");
        try std.json.Stringify.value(id, .{}, &out.writer);
        if (method == .string and std.mem.eql(u8, method.string, "eth_chainId")) {
            try out.writer.writeAll(",\"result\":\"0x1\"}");
        } else if (method == .string and std.mem.eql(u8, method.string, "eth_getTransactionReceipt")) {
            try out.writer.writeAll(",\"result\":");
            try out.writer.writeAll(self.receipt);
            try out.writer.writeByte('}');
        } else return error.FixtureUnexpectedMethod;
        self.requests += 1;
        if (self.stall_ms > 0) std.Thread.sleep(self.stall_ms * std.time.ns_per_ms);
        var header_buffer: [160]u8 = undefined;
        const header = try std.fmt.bufPrint(&header_buffer, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{out.written().len});
        try connection.stream.writeAll(header);
        try connection.stream.writeAll(out.written());
    }
};

fn word(value: u256) [32]u8 {
    var result: [32]u8 = undefined;
    std.mem.writeInt(u256, &result, value, .big);
    return result;
}

fn dispatchData(a: A, message: protocol.Message) ![]u8 {
    const encoded = try message.encodeAlloc(a);
    defer a.free(encoded);
    const padded = (encoded.len + 31) / 32 * 32;
    const result = try a.alloc(u8, 64 + padded);
    @memset(result, 0);
    result[0..32].* = word(32);
    result[32..64].* = word(encoded.len);
    @memcpy(result[64..][0..encoded.len], encoded);
    return result;
}

fn writeLog(out: *std.Io.Writer.Allocating, a: A, address: [20]u8, topics: []const [32]u8, data: []const u8, log_index: usize, transaction: [32]u8) !void {
    const address_text = try abi.hexAlloc(a, &address);
    defer a.free(address_text);
    const transaction_text = try abi.hexAlloc(a, &transaction);
    defer a.free(transaction_text);
    const block_hash = try abi.hexAlloc(a, &@as([32]u8, @splat(9)));
    defer a.free(block_hash);
    const data_text = try abi.hexAlloc(a, data);
    defer a.free(data_text);
    try out.writer.writeAll("{\"address\":");
    try admin_json.writeString(&out.writer, address_text);
    try out.writer.writeAll(",\"topics\":[");
    for (topics, 0..) |topic, index| {
        if (index != 0) try out.writer.writeByte(',');
        const text = try abi.hexAlloc(a, &topic);
        defer a.free(text);
        try admin_json.writeString(&out.writer, text);
    }
    try out.writer.writeAll("],\"data\":");
    try admin_json.writeString(&out.writer, data_text);
    try out.writer.print(",\"blockNumber\":\"0x1\",\"blockHash\":", .{});
    try admin_json.writeString(&out.writer, block_hash);
    try out.writer.writeAll(",\"transactionHash\":");
    try admin_json.writeString(&out.writer, transaction_text);
    try out.writer.print(",\"transactionIndex\":\"0x0\",\"logIndex\":\"0x{x}\",\"removed\":false}}", .{log_index});
}

fn makeReceipt(a: A, transaction: [32]u8, messages: []const protocol.Message, cctp: bool) ![]u8 {
    var out = std.Io.Writer.Allocating.init(a);
    errdefer out.deinit();
    const transaction_text = try abi.hexAlloc(a, &transaction);
    defer a.free(transaction_text);
    try out.writer.writeAll("{\"transactionHash\":");
    try admin_json.writeString(&out.writer, transaction_text);
    try out.writer.writeAll(",\"logs\":[");
    var index: usize = 0;
    for (messages) |message| {
        if (index != 0) try out.writer.writeByte(',');
        const data = try dispatchData(a, message);
        defer a.free(data);
        const topics = [_][32]u8{ abi.dispatch_topic, message.sender, word(message.destination), message.recipient };
        try writeLog(&out, a, evmAddress32(1)[12..32].*, &topics, data, index, transaction);
        index += 1;
    }
    if (messages.len > 0) {
        const gas_data = try a.alloc(u8, 64);
        defer a.free(gas_data);
        gas_data[0..32].* = word(200);
        gas_data[32..64].* = word(100);
        const topics = [_][32]u8{ abi.gas_payment_topic, messages[0].id(), word(messages[0].destination) };
        try out.writer.writeByte(',');
        try writeLog(&out, a, evmAddress32(2)[12..32].*, &topics, gas_data, index, transaction);
        index += 1;
    }
    if (cctp) for (messages) |_| {
        const topics = [_][32]u8{abi.topic("MessageSent(bytes)")};
        try out.writer.writeByte(',');
        try writeLog(&out, a, .{ 0x81, 0xD4, 0x0F, 0x21, 0xF1, 0x2A, 0x8F, 0x0E, 0x32, 0x52, 0xBc, 0xcb, 0x95, 0x4D, 0x72, 0x2d, 0x4c, 0x46, 0x4B, 0x64 }, &topics, "", index, transaction);
        index += 1;
    };
    try out.writer.writeAll("]}");
    return admin_json.finish(&out, a);
}

fn fixtureMessage(nonce: u32, destination: u32, body: []const u8) protocol.Message {
    return .{ .version = 3, .nonce = nonce, .origin = 1, .destination = destination, .sender = evmAddress32(1), .recipient = evmAddress32(2), .body = body };
}

fn temporaryDatabase(a: A, temp: *std.testing.TmpDir) ![]u8 {
    const parent = try temp.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    return std.fs.path.join(a, &.{ parent, "rocks" });
}

fn startRpc(a: A, receipt: []const u8) !struct { fixture: *RpcFixture, url: []u8, thread: std.Thread } {
    const fixture = try a.create(RpcFixture);
    fixture.* = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .receipt = receipt };
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{fixture.server.listen_address.getPort()});
    return .{ .fixture = fixture, .url = url, .thread = undefined };
}

test "native public relay extracts sidecars preserves canonical rows and deduplicates IGP" {
    const a = std.testing.allocator;
    const transaction: [32]u8 = @splat(7);
    const hash_text = try abi.hexAlloc(a, &transaction);
    defer a.free(hash_text);
    const messages = [_]protocol.Message{ fixtureMessage(7, 2, "receipt-a"), fixtureMessage(8, 3, "receipt-b") };
    const receipt = try makeReceipt(a, transaction, &messages, true);
    defer a.free(receipt);
    var rpc = try startRpc(a, receipt);
    defer a.free(rpc.url);
    defer {
        rpc.fixture.server.deinit();
        a.destroy(rpc.fixture);
    }
    rpc.thread = try std.Thread.spawn(.{}, RpcFixture.serve, .{ rpc.fixture, 3 });
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path, rpc.url);
    defer fixture.deinit(a);
    const canonical = fixtureMessage(7, 2, "indexed");
    _ = try fixture.store.storeMessage(canonical, 50, null);
    try fixture.store.storeGasWatermark(77);
    var clock: TestClock = .{};
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = metric_schema.baselib_version });
    defer registry.deinit();
    var cache = try relay_api.TxHashCache.init(a, 100, std.time.ns_per_ms, clock.interface());
    defer cache.deinit();
    var api_state: relay_api.RelayApi = .{ .owner = fixture.public.submissionOwner(), .registry = registry, .rate_limiter = null, .tx_cache = &cache, .clock = clock.interface(), .cors_origins = &.{} };
    var caller = try RelayHttpCaller.init(a, api_state.handler(), "origin", hash_text);
    defer caller.deinit();
    const thread = try std.Thread.spawn(.{}, RelayHttpCaller.run, .{&caller});
    try fixture.drainUntil(&caller.done);
    thread.join();
    try std.testing.expect(caller.failure == null);
    try std.testing.expectEqual(@as(u16, 200), caller.response.?.status);
    try std.testing.expectEqual(@as(usize, 1), fixture.lanes[0].active.items.len);
    try std.testing.expectEqual(@as(usize, 1), fixture.lanes[1].active.items.len);
    var current = (try fixture.store.messageByNonce(7)).?;
    defer current.deinit();
    try std.testing.expectEqualSlices(u8, &canonical.id(), &current.value.id());
    try std.testing.expectEqualStrings("indexed", current.value.body);
    try std.testing.expect((try fixture.store.messageByNonce(8)) == null);
    try std.testing.expectEqual(@as(?u32, 7), try fixture.store.highestSeenNonce());
    try std.testing.expectEqual(@as(?u64, 50), try fixture.store.messageBlock(7));
    try std.testing.expectEqual(@as(?u32, 77), try fixture.store.gasWatermark());
    try std.testing.expect(try fixture.store.operationMessageAuthorized(messages[0]));
    var admitted = (try fixture.store.messageById(messages[0].id())).?;
    defer admitted.deinit();
    try std.testing.expectEqualStrings("receipt-a", admitted.value.body);
    try std.testing.expectEqual(@as(?u256, 100), (try fixture.store.payment(.{ .message_id = messages[0].id(), .destination = 2 })).?.payment);

    var second_caller = try RelayHttpCaller.init(a, api_state.handler(), "origin", hash_text);
    defer second_caller.deinit();
    const second = try std.Thread.spawn(.{}, RelayHttpCaller.run, .{&second_caller});
    try fixture.drainUntil(&second_caller.done);
    second.join();
    try std.testing.expect(second_caller.failure == null);
    try std.testing.expectEqual(@as(u16, 429), second_caller.response.?.status);
    try std.testing.expectEqual(@as(usize, 2), fixture.lanes[0].active.items.len + fixture.lanes[1].active.items.len);
    clock.now_ns += 2 * std.time.ns_per_ms;
    var third_caller = try RelayHttpCaller.init(a, api_state.handler(), "origin", hash_text);
    defer third_caller.deinit();
    const third = try std.Thread.spawn(.{}, RelayHttpCaller.run, .{&third_caller});
    try fixture.drainUntil(&third_caller.done);
    third.join();
    try std.testing.expect(third_caller.failure == null);
    try std.testing.expectEqual(@as(u16, 200), third_caller.response.?.status);
    try std.testing.expectEqual(@as(usize, 4), fixture.lanes[0].active.items.len + fixture.lanes[1].active.items.len);
    try std.testing.expectEqual(@as(?u256, 100), (try fixture.store.payment(.{ .message_id = messages[0].id(), .destination = 2 })).?.payment);
    try std.testing.expectEqual(@as(u256, 200), (try fixture.store.payment(.{ .message_id = messages[0].id(), .destination = 2 })).?.gas_amount);
    rpc.thread.join();
    try std.testing.expect(rpc.fixture.failure == null);
}

test "native public relay rejects non-CCTP without Active or gas writes" {
    const a = std.testing.allocator;
    const transaction: [32]u8 = @splat(8);
    const hash_text = try abi.hexAlloc(a, &transaction);
    defer a.free(hash_text);
    const messages = [_]protocol.Message{fixtureMessage(4, 2, "not-cctp")};
    const receipt = try makeReceipt(a, transaction, &messages, false);
    defer a.free(receipt);
    var rpc = try startRpc(a, receipt);
    defer a.free(rpc.url);
    defer {
        rpc.fixture.server.deinit();
        a.destroy(rpc.fixture);
    }
    rpc.thread = try std.Thread.spawn(.{}, RpcFixture.serve, .{ rpc.fixture, 2 });
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path, rpc.url);
    defer fixture.deinit(a);
    var caller: SubmitCaller = .{ .owner = fixture.public.submissionOwner(), .origin = "origin", .hash = hash_text, .arena = std.heap.ArenaAllocator.init(a) };
    defer caller.arena.deinit();
    const thread = try std.Thread.spawn(.{}, SubmitCaller.run, .{&caller});
    try fixture.drainUntil(&caller.done);
    thread.join();
    try std.testing.expect(caller.failure == null);
    try std.testing.expectEqual(relay_api.FailureMetric.not_cctp_v2, caller.result.?.failure.?.metric);
    try std.testing.expectEqual(@as(usize, 0), fixture.lanes[0].active.items.len + fixture.lanes[1].active.items.len);
    try std.testing.expect((try fixture.store.payment(.{ .message_id = messages[0].id(), .destination = 2 })) == null);
    rpc.thread.join();
    try std.testing.expect(rpc.fixture.failure == null);
}

fn addOccupied(fixture: *NativeFixture, lane_index: usize, message: protocol.Message) !void {
    const a = fixture.owner.allocator;
    const lane = &fixture.lanes[lane_index];
    const bytes = try message.encodeAlloc(a);
    errdefer a.free(bytes);
    const item = try a.create(TestActive);
    errdefer a.destroy(item);
    const retained = message.body.len + @sizeOf(TestActive);
    item.* = .{ .origin_index = 0, .message = .{ .allocator = a, .bytes = bytes, .value = try protocol.Message.decode(bytes) }, .retained_bytes = retained };
    const lane_control = fixture.controls[lane_index];
    lane_control.bindSnapshotBudget(&fixture.owner);
    try lane_control.ensurePolicy(lane, 0);
    try lane.active.ensureUnusedCapacity(a, 1);
    try lane_control.snapshot.ensureCapacity(lane.active.items.len + 1);
    const row = try lane_control.prepareSnapshotRow(lane, 0, message);
    lane_control.snapshot.beginPublish();
    lane.active.appendAssumeCapacity(item);
    lane.active_bytes += retained;
    fixture.owner.retained_bytes += retained;
    lane_control.snapshot.appendLocked(row);
    lane_control.snapshot.finishPublish();
}

test "native public relay cross-destination saturation aborts earlier reservations" {
    const a = std.testing.allocator;
    const transaction: [32]u8 = @splat(10);
    const hash_text = try abi.hexAlloc(a, &transaction);
    defer a.free(hash_text);
    const messages = [_]protocol.Message{ fixtureMessage(20, 2, "new-a"), fixtureMessage(21, 3, "new-b") };
    const receipt = try makeReceipt(a, transaction, &messages, true);
    defer a.free(receipt);
    var rpc = try startRpc(a, receipt);
    defer a.free(rpc.url);
    defer {
        rpc.fixture.server.deinit();
        a.destroy(rpc.fixture);
    }
    rpc.thread = try std.Thread.spawn(.{}, RpcFixture.serve, .{ rpc.fixture, 2 });
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path, rpc.url);
    defer fixture.deinit(a);
    fixture.owner.options.max_active = 1;
    try addOccupied(fixture, 1, fixtureMessage(99, 3, "occupied"));
    var caller: SubmitCaller = .{ .owner = fixture.public.submissionOwner(), .origin = "origin", .hash = hash_text, .arena = std.heap.ArenaAllocator.init(a) };
    defer caller.arena.deinit();
    const thread = try std.Thread.spawn(.{}, SubmitCaller.run, .{&caller});
    try fixture.drainUntil(&caller.done);
    thread.join();
    try std.testing.expect(caller.failure == null);
    try std.testing.expectEqual(relay_api.FailureMetric.processor_saturated, caller.result.?.failure.?.metric);
    try std.testing.expectEqual(@as(usize, 0), fixture.lanes[0].active.items.len);
    try std.testing.expectEqual(@as(usize, 1), fixture.lanes[1].active.items.len);
    try std.testing.expect((try fixture.store.messageById(messages[0].id())) == null);
    try std.testing.expect((try fixture.store.messageById(messages[1].id())) == null);
    rpc.thread.join();
    try std.testing.expect(rpc.fixture.failure == null);
}

test "native public relay queued cancellation leaves no Active or sidecar" {
    const a = std.testing.allocator;
    const transaction: [32]u8 = @splat(11);
    const hash_text = try abi.hexAlloc(a, &transaction);
    defer a.free(hash_text);
    const messages = [_]protocol.Message{fixtureMessage(30, 2, "cancel-queued")};
    const receipt = try makeReceipt(a, transaction, &messages, true);
    defer a.free(receipt);
    var rpc = try startRpc(a, receipt);
    defer a.free(rpc.url);
    defer {
        rpc.fixture.server.deinit();
        a.destroy(rpc.fixture);
    }
    rpc.thread = try std.Thread.spawn(.{}, RpcFixture.serve, .{ rpc.fixture, 2 });
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path, rpc.url);
    defer fixture.deinit(a);
    var caller: SubmitCaller = .{ .owner = fixture.public.submissionOwner(), .origin = "origin", .hash = hash_text, .arena = std.heap.ArenaAllocator.init(a) };
    defer caller.arena.deinit();
    const thread = try std.Thread.spawn(.{}, SubmitCaller.run, .{&caller});
    while (!fixture.controls[0].wake.load(.acquire) and !caller.done.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    caller.cancel.store(true, .release);
    std.Thread.sleep(20 * std.time.ns_per_ms);
    try fixture.drainUntil(&caller.done);
    thread.join();
    try std.testing.expectEqual(error.RequestCancelled, caller.failure.?);
    try std.testing.expectEqual(@as(usize, 0), fixture.lanes[0].active.items.len + fixture.lanes[1].active.items.len);
    try std.testing.expect((try fixture.store.messageById(messages[0].id())) == null);
    // Only the published View pointer capacity remains; aborted handoff owns no bytes.
    try std.testing.expectEqual(fixture.controls[0].snapshot.retainedBytes() + fixture.controls[1].snapshot.retainedBytes(), fixture.owner.retained_bytes);
    try std.testing.expect(fixture.controls[0].relay_reservation == null and fixture.controls[1].relay_reservation == null);
    try std.testing.expectEqual(@as(usize, 0), fixture.controls[0].snapshot.rows.items.len + fixture.controls[1].snapshot.rows.items.len);
    rpc.thread.join();
    try std.testing.expect(rpc.fixture.failure == null);
}

test "native public relay running reserve timeout aborts without partial handoff" {
    const a = std.testing.allocator;
    const transaction: [32]u8 = @splat(12);
    const hash_text = try abi.hexAlloc(a, &transaction);
    defer a.free(hash_text);
    const messages = [_]protocol.Message{fixtureMessage(31, 2, "cancel-running")};
    const receipt = try makeReceipt(a, transaction, &messages, true);
    defer a.free(receipt);
    var rpc = try startRpc(a, receipt);
    defer a.free(rpc.url);
    defer {
        rpc.fixture.server.deinit();
        a.destroy(rpc.fixture);
    }
    rpc.thread = try std.Thread.spawn(.{}, RpcFixture.serve, .{ rpc.fixture, 2 });
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path, rpc.url);
    defer fixture.deinit(a);
    fixture.owner.memory_mutex.lock();
    var memory_locked = true;
    defer if (memory_locked) fixture.owner.memory_mutex.unlock();
    var caller: SubmitCaller = .{ .owner = fixture.public.submissionOwner(), .origin = "origin", .hash = hash_text, .arena = std.heap.ArenaAllocator.init(a) };
    defer caller.arena.deinit();
    const thread = try std.Thread.spawn(.{}, SubmitCaller.run, .{&caller});
    while (!fixture.controls[0].wake.load(.acquire) and !caller.done.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    const DrainWorker = struct {
        fixture: *NativeFixture,
        failure: ?anyerror = null,
        fn run(self: *@This()) void {
            self.fixture.drain() catch |err| {
                self.failure = err;
            };
        }
    };
    var worker: DrainWorker = .{ .fixture = fixture };
    const owner_thread = try std.Thread.spawn(.{}, DrainWorker.run, .{&worker});
    std.Thread.sleep(300 * std.time.ns_per_ms);
    fixture.owner.memory_mutex.unlock();
    memory_locked = false;
    owner_thread.join();
    try std.testing.expect(worker.failure == null);
    try fixture.drainUntil(&caller.done);
    thread.join();
    try std.testing.expect(caller.failure == null);
    try std.testing.expectEqual(relay_api.FailureMetric.processor_saturated, caller.result.?.failure.?.metric);
    try std.testing.expectEqual(@as(usize, 0), fixture.lanes[0].active.items.len + fixture.lanes[1].active.items.len);
    try std.testing.expect((try fixture.store.messageById(messages[0].id())) == null);
    // Only the published View pointer capacity remains; aborted handoff owns no bytes.
    try std.testing.expectEqual(fixture.controls[0].snapshot.retainedBytes() + fixture.controls[1].snapshot.retainedBytes(), fixture.owner.retained_bytes);
    try std.testing.expect(fixture.controls[0].relay_reservation == null and fixture.controls[1].relay_reservation == null);
    try std.testing.expectEqual(@as(usize, 0), fixture.controls[0].snapshot.rows.items.len + fixture.controls[1].snapshot.rows.items.len);
    rpc.thread.join();
    try std.testing.expect(rpc.fixture.failure == null);
}

test "native public relay chain check and receipt share one whole extraction deadline" {
    const a = std.testing.allocator;
    const transaction: [32]u8 = @splat(13);
    const hash_text = try abi.hexAlloc(a, &transaction);
    defer a.free(hash_text);
    const messages = [_]protocol.Message{fixtureMessage(40, 2, "whole-deadline")};
    const receipt = try makeReceipt(a, transaction, &messages, true);
    defer a.free(receipt);
    var rpc = try startRpc(a, receipt);
    defer a.free(rpc.url);
    defer {
        rpc.fixture.server.deinit();
        a.destroy(rpc.fixture);
    }
    rpc.fixture.stall_ms = 40;
    rpc.fixture.optional_tail = true;
    rpc.thread = try std.Thread.spawn(.{}, RpcFixture.serve, .{ rpc.fixture, 2 });
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path, rpc.url);
    defer fixture.deinit(a);
    fixture.public.extraction_timeout_ms = 50;
    var caller: SubmitCaller = .{ .owner = fixture.public.submissionOwner(), .origin = "origin", .hash = hash_text, .arena = std.heap.ArenaAllocator.init(a) };
    defer caller.arena.deinit();
    const thread = try std.Thread.spawn(.{}, SubmitCaller.run, .{&caller});
    thread.join();
    try std.testing.expect(caller.failure == null);
    try std.testing.expectEqual(relay_api.FailureKind.request_timeout, caller.result.?.failure.?.kind);
    try std.testing.expectEqual(relay_api.FailureMetric.timeout, caller.result.?.failure.?.metric);
    try std.testing.expectEqual(@as(usize, 0), fixture.lanes[0].active.items.len + fixture.lanes[1].active.items.len);
    rpc.thread.join();
    try std.testing.expect(rpc.fixture.failure == null);
    try std.testing.expect(rpc.fixture.requests >= 1 and rpc.fixture.requests <= 2);
}

test "native public relay source gate wait observes cancellation" {
    const a = std.testing.allocator;
    const transaction: [32]u8 = @splat(14);
    const hash_text = try abi.hexAlloc(a, &transaction);
    defer a.free(hash_text);
    const messages = [_]protocol.Message{fixtureMessage(41, 2, "source-gate")};
    const receipt = try makeReceipt(a, transaction, &messages, true);
    defer a.free(receipt);
    var rpc = try startRpc(a, receipt);
    defer a.free(rpc.url);
    defer {
        rpc.fixture.server.deinit();
        a.destroy(rpc.fixture);
    }
    rpc.thread = try std.Thread.spawn(.{}, RpcFixture.serve, .{ rpc.fixture, 0 });
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path, rpc.url);
    defer fixture.deinit(a);
    fixture.public.sources[0].gate.mutex.lock();
    var caller: SubmitCaller = .{ .owner = fixture.public.submissionOwner(), .origin = "origin", .hash = hash_text, .arena = std.heap.ArenaAllocator.init(a) };
    defer caller.arena.deinit();
    const thread = try std.Thread.spawn(.{}, SubmitCaller.run, .{&caller});
    std.Thread.sleep(20 * std.time.ns_per_ms);
    caller.cancel.store(true, .release);
    thread.join();
    fixture.public.sources[0].gate.mutex.unlock();
    try std.testing.expectEqual(error.RequestCancelled, caller.failure.?);
    try std.testing.expect(fixture.public.sources[0].network == null);
    rpc.thread.join();
    try std.testing.expect(rpc.fixture.failure == null);
}

test "native public relay admission gate wait observes cancellation" {
    const a = std.testing.allocator;
    const transaction: [32]u8 = @splat(15);
    const hash_text = try abi.hexAlloc(a, &transaction);
    defer a.free(hash_text);
    const messages = [_]protocol.Message{fixtureMessage(42, 2, "admission-gate")};
    const receipt = try makeReceipt(a, transaction, &messages, true);
    defer a.free(receipt);
    var rpc = try startRpc(a, receipt);
    defer a.free(rpc.url);
    defer {
        rpc.fixture.server.deinit();
        a.destroy(rpc.fixture);
    }
    rpc.thread = try std.Thread.spawn(.{}, RpcFixture.serve, .{ rpc.fixture, 2 });
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const path = try temporaryDatabase(a, &temp);
    defer a.free(path);
    var fixture = try NativeFixture.init(a, path, rpc.url);
    defer fixture.deinit(a);
    fixture.public.admission_gate.mutex.lock();
    var caller: SubmitCaller = .{ .owner = fixture.public.submissionOwner(), .origin = "origin", .hash = hash_text, .arena = std.heap.ArenaAllocator.init(a) };
    defer caller.arena.deinit();
    const thread = try std.Thread.spawn(.{}, SubmitCaller.run, .{&caller});
    std.Thread.sleep(50 * std.time.ns_per_ms);
    caller.cancel.store(true, .release);
    thread.join();
    fixture.public.admission_gate.mutex.unlock();
    try std.testing.expectEqual(error.RequestCancelled, caller.failure.?);
    try std.testing.expectEqual(@as(usize, 0), fixture.lanes[0].active.items.len + fixture.lanes[1].active.items.len);
    rpc.thread.join();
    try std.testing.expect(rpc.fixture.failure == null);
}

test {
    _ = @import("agents/relayer/public_relay_test.zig");
}
