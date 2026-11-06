const std = @import("std");
const fixture_curl_library = if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4";
const prepare = @import("agents/relayer/evm_prepare.zig");
const protocol = @import("protocol/root.zig");
const evm = @import("evm/root.zig");
const native = @import("agents/store.zig");
const relay_policy = @import("agents/relay_policy.zig");
const evm_source = @import("relayer/evm_source.zig");
const db = @import("db/root.zig");
const denylist = @import("ops/runtime_denylist.zig");
const settings = @import("settings/types.zig");
const metadata_parallel = @import("relayer/metadata_parallel.zig");
const Curl = @import("net/curl.zig");
const A = std.mem.Allocator;

fn word(comptime suffix: []const u8) []const u8 {
    const zeros = "00000000000000000000000000000000" ++ "00000000000000000000000000000000";
    return "\"0x" ++ zeros[0 .. 64 - suffix.len] ++ suffix ++ "\"";
}
fn quantity(comptime suffix: []const u8) []const u8 {
    return "\"0x" ++ suffix ++ "\"";
}
const zero_word = word("0");
const one_word = word("1");
const null_ism_word = word("6");
const ism_word = word("33");
const max_word = "\"0x" ++ "ffffffffffffffffffffffffffffffff" ++ "ffffffffffffffffffffffffffffffff\"";

const Step = struct {
    method: []const u8,
    result: ?[]const u8 = null,
    error_object: ?[]const u8 = null,
    failure: ?anyerror = null,
    raw: ?[]const u8 = null,
};

const Mock = struct {
    allocator: A,
    steps: []Step,
    index: usize = 0,
    methods: std.ArrayList([]u8) = .empty,
    requests: std.ArrayList([]u8) = .empty,

    fn init(allocator: A, steps: []const Step) !Mock {
        const copied = try allocator.alloc(Step, steps.len);
        @memset(copied, .{ .method = "" });
        errdefer {
            for (copied) |step| {
                if (step.result) |value| allocator.free(value);
                if (step.error_object) |value| allocator.free(value);
                if (step.raw) |value| allocator.free(value);
            }
            allocator.free(copied);
        }
        for (copied, steps) |*step, source| {
            step.* = .{ .method = source.method, .failure = source.failure };
            if (source.result) |value| step.result = try allocator.dupe(u8, value);
            if (source.error_object) |value| step.error_object = try allocator.dupe(u8, value);
            if (source.raw) |value| step.raw = try allocator.dupe(u8, value);
        }
        return .{ .allocator = allocator, .steps = copied };
    }

    fn deinit(self: *Mock) void {
        for (self.steps) |step| {
            if (step.result) |value| self.allocator.free(value);
            if (step.error_object) |value| self.allocator.free(value);
            if (step.raw) |value| self.allocator.free(value);
        }
        self.allocator.free(self.steps);
        for (self.methods.items) |value| self.allocator.free(value);
        for (self.requests.items) |value| self.allocator.free(value);
        self.methods.deinit(self.allocator);
        self.requests.deinit(self.allocator);
    }

    fn exchange(self: *Mock) evm.provider.Exchange {
        return .{ .context = self, .fetch_fn = fetch };
    }

    fn fetch(context: *anyopaque, allocator: A, body: []const u8, _: evm.provider.Options) anyerror!evm.provider.WireResponse {
        const self: *Mock = @ptrCast(@alignCast(context));
        if (self.index >= self.steps.len) return error.UnexpectedRpcCall;
        const step = self.steps[self.index];
        self.index += 1;
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
        defer parsed.deinit();
        if (parsed.value != .object) return error.InvalidRpcRequest;
        const method = parsed.value.object.get("method") orelse return error.InvalidRpcRequest;
        const id = parsed.value.object.get("id") orelse return error.InvalidRpcRequest;
        if (method != .string or id != .integer or !std.mem.eql(u8, method.string, step.method)) return error.UnexpectedRpcMethod;
        {
            const method_copy = try self.allocator.dupe(u8, method.string);
            errdefer self.allocator.free(method_copy);
            try self.methods.append(self.allocator, method_copy);
        }
        {
            const request_copy = try self.allocator.dupe(u8, body);
            errdefer self.allocator.free(request_copy);
            try self.requests.append(self.allocator, request_copy);
        }
        if (step.failure) |failure| return failure;
        const bytes = if (step.raw) |raw|
            try self.allocator.dupe(u8, raw)
        else if (step.error_object) |rpc_error|
            try std.fmt.allocPrint(self.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"error\":{s}}}", .{ id.integer, rpc_error })
        else
            try std.fmt.allocPrint(self.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id.integer, step.result orelse return error.MissingRpcResult });
        return .{ .bytes = bytes, .len = bytes.len };
    }

    fn expectDone(self: *const Mock) !void {
        try std.testing.expectEqual(self.steps.len, self.index);
        for (self.methods.items) |method| {
            try std.testing.expect(!std.mem.eql(u8, method, "eth_sendRawTransaction"));
            try std.testing.expect(!std.mem.eql(u8, method, "eth_sendTransaction"));
        }
    }
};

const Fixture = struct {
    allocator: A,
    mock: Mock,
    temporary: std.testing.TmpDir,
    database: db.rocks.Database,
    store: native.Store,
    policy: relay_policy.Policy,
    origin: evm_source.LocalOrigin,
    client: evm.RpcClient,

    fn init(allocator: A, steps: []const Step, policy_config: relay_policy.Config) !*Fixture {
        const self = try allocator.create(Fixture);
        errdefer allocator.destroy(self);
        self.allocator = allocator;
        self.mock = try Mock.init(allocator, steps);
        errdefer self.mock.deinit();
        self.temporary = std.testing.tmpDir(.{});
        errdefer self.temporary.cleanup();
        const parent = try self.temporary.dir.realpathAlloc(allocator, ".");
        defer allocator.free(parent);
        const path = try std.fs.path.join(allocator, &.{ parent, "evm-prepare" });
        defer allocator.free(path);
        self.database = try db.rocks.Database.open(allocator, path, .{ .sync = true });
        errdefer self.database.deinit();
        self.store = native.Store.init(allocator, &self.database, "origin");
        self.policy = try relay_policy.Policy.init(allocator, policy_config, null, null);
        errdefer self.policy.deinit();
        self.origin = .{ .allocator = allocator, .leaves = &.{}, .stores = &.{} };
        self.client = try evm.RpcClient.init(allocator, "http://127.0.0.1:1", .{ .exchange = self.mock.exchange() });
        errdefer self.client.deinit();
        return self;
    }

    fn deinit(self: *Fixture) void {
        self.client.deinit();
        self.policy.deinit();
        self.database.deinit();
        self.mock.deinit();
        self.temporary.cleanup();
        self.allocator.destroy(self);
    }

    fn preparer(self: *Fixture, config: prepare.Config) prepare.Preparer(evm_source.LocalOrigin) {
        return .{ .allocator = self.allocator, .client = &self.client, .origin = &self.origin, .policy = &self.policy, .config = config };
    }

    fn storeMessage(self: *Fixture, message: protocol.Message) !void {
        _ = try self.store.storeMessage(message, 1, null);
    }
};

const allow_gas: relay_policy.Config = .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .none }} };

fn testConfig() prepare.Config {
    var mailbox: [32]u8 = @splat(0);
    mailbox[31] = 0x42;
    return .{ .domain = 2000, .chain_id = 31337, .mailbox = mailbox, .relayer = @splat(0x11), .reorg = .{ .tag = "finalized" } };
}

fn testMessage() protocol.Message {
    var sender: [32]u8 = @splat(0);
    sender[31] = 1;
    var recipient: [32]u8 = @splat(0);
    recipient[0] = 0xff;
    @memset(recipient[12..], 0x22);
    return .{ .version = 3, .nonce = 7, .origin = 1000, .sender = sender, .destination = 2000, .recipient = recipient, .body = &.{ 0x11, 0x22, 0x33 } };
}

fn cachedSteps(estimate: []const u8, gas_price: []const u8) [5]Step {
    return .{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
        .{ .method = "eth_estimateGas", .result = estimate },
        .{ .method = "eth_gasPrice", .result = gas_price },
    };
}

fn metadataSteps(estimate: []const u8, gas_price: []const u8) [9]Step {
    return .{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
        .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
        .{ .method = "eth_call", .result = ism_word },
        .{ .method = "eth_call", .result = ism_word },
        .{ .method = "eth_call", .result = null_ism_word },
        .{ .method = "eth_estimateGas", .result = estimate },
        .{ .method = "eth_gasPrice", .result = gas_price },
    };
}

fn input(fixture: *Fixture, msg: protocol.Message, cached: ?[]const u8) prepare.Input {
    return .{ .store = &fixture.store, .message = msg, .uuid = @splat(7), .metadata = "fixture-message", .cached_metadata = cached };
}

fn jsonEqual(left: std.json.Value, right: std.json.Value) bool {
    if (std.meta.activeTag(left) != std.meta.activeTag(right)) return false;
    return switch (left) {
        .null => true,
        .bool => |value| value == right.bool,
        .integer => |value| value == right.integer,
        .float => |value| value == right.float,
        .number_string => |value| std.mem.eql(u8, value, right.number_string),
        .string => |value| std.mem.eql(u8, value, right.string),
        .array => |value| blk: {
            if (value.items.len != right.array.items.len) break :blk false;
            for (value.items, right.array.items) |a, b| if (!jsonEqual(a, b)) break :blk false;
            break :blk true;
        },
        .object => |value| blk: {
            if (value.count() != right.object.count()) break :blk false;
            var iterator = value.iterator();
            while (iterator.next()) |entry| {
                const other = right.object.get(entry.key_ptr.*) orelse break :blk false;
                if (!jsonEqual(entry.value_ptr.*, other)) break :blk false;
            }
            break :blk true;
        },
    };
}

fn fixtureText(allocator: A, value: std.json.Value) ![]u8 {
    if (value != .array) return error.InvalidFixture;
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);
    for (value.array.items) |part| {
        if (part != .string or part.string.len > 32) return error.InvalidFixture;
        try out.appendSlice(allocator, part.string);
    }
    return out.toOwnedSlice(allocator);
}

fn expectPair(allocator: A, actual: []const u8, fixture: std.json.Value) !void {
    const expected_text = try fixtureText(allocator, fixture);
    defer allocator.free(expected_text);
    var expected = try std.json.parseFromSlice(std.json.Value, allocator, expected_text, .{});
    defer expected.deinit();
    var observed = try std.json.parseFromSlice(std.json.Value, allocator, actual, .{});
    defer observed.deinit();
    if (!jsonEqual(expected.value, observed.value)) return error.PayloadPairMismatch;
}

test "ready matches unchanged Rust ethers process and delivered payload oracle with full u256 gas" {
    const a = std.testing.allocator;
    const steps = cachedSteps(max_word, max_word);
    var fixture = try Fixture.init(a, &steps, allow_gas);
    defer fixture.deinit();
    const msg = testMessage();
    try fixture.storeMessage(msg);
    var worker = fixture.preparer(testConfig());
    var outcome = try worker.prepare(input(fixture, msg, &.{ 0xab, 0xcd }));
    defer outcome.deinit();
    try std.testing.expect(outcome.value == .ready);
    const ready = outcome.value.ready;
    try std.testing.expectEqual(std.math.maxInt(u256), ready.payload.gas_limit);
    try std.testing.expectEqual(std.math.maxInt(u256), ready.diagnostics.estimate.?.gas_price);
    const document = std.json.parseFromSlice(std.json.Value, a, @embedFile("agents/relayer/evm_prepare_fixtures/payload.json"), .{}) catch unreachable;
    defer document.deinit();
    try expectPair(a, ready.payload.data_json, document.value.object.get("process").?);
    try expectPair(a, ready.payload.success_criteria_json.?, document.value.object.get("delivered").?);
    try fixture.mock.expectDone();
}

test "source order builds real null ISM metadata and paid allowance uses remaining gas" {
    const a = std.testing.allocator;
    const steps = metadataSteps(quantity("1f4"), quantity("2"));
    const policy: relay_policy.Config = .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .{ .minimum = 1 } }} };
    var fixture = try Fixture.init(a, &steps, policy);
    defer fixture.deinit();
    const msg = testMessage();
    try fixture.storeMessage(msg);
    _ = try fixture.store.storePayment(.{ .message_id = msg.id(), .destination = msg.destination, .gas_amount = 1000, .payment = 1 }, .{ .transaction_id = @splat(3), .log_index = 0 });
    try fixture.store.addExpenditure(msg.id(), .{ .gas_used = 200, .tokens_used = 0 });
    var worker = fixture.preparer(testConfig());
    var outcome = try worker.prepare(input(fixture, msg, null));
    defer outcome.deinit();
    try std.testing.expect(outcome.value == .ready);
    try std.testing.expectEqual(@as(u256, 800), outcome.value.ready.payload.gas_limit);
    try std.testing.expectEqual(@as(usize, 0), outcome.value.ready.metadata_bytes.len);
    const expected = [_][]const u8{ "eth_chainId", "eth_call", "eth_getCode", "eth_blockNumber", "eth_call", "eth_call", "eth_call", "eth_estimateGas", "eth_gasPrice" };
    try std.testing.expectEqual(expected.len, fixture.mock.methods.items.len);
    for (expected, fixture.mock.methods.items) |wanted, actual| try std.testing.expectEqualStrings(wanted, actual);
    try fixture.mock.expectDone();
}

test "metadata executor forwards shared root through builder" {
    const a = std.testing.allocator;
    const steps = metadataSteps(quantity("1f4"), quantity("2"));
    var fixture = try Fixture.init(a, &steps, allow_gas);
    defer fixture.deinit();
    const msg = testMessage();
    try fixture.storeMessage(msg);
    const root = try metadata_parallel.Root.start(a, .{ .workers = 1, .max_retained_jobs = 8, .max_output_bytes = 1024 });
    defer root.deinit();
    var worker = fixture.preparer(testConfig());
    worker.executor = &root.executor;
    var outcome = try worker.prepare(input(fixture, msg, null));
    defer outcome.deinit();
    try std.testing.expect(outcome.value == .ready);
    try std.testing.expectEqual(@as(usize, 0), root.executor.retainedJobs());
    try std.testing.expectEqual(@as(usize, 0), root.executor.retainedOutputBytes());
    try fixture.mock.expectDone();
}

const PendingHandler = struct {
    failure: anyerror,
    fn fetch(context: *anyopaque, _: [20]u8, _: protocol.Message) anyerror![]u8 {
        const self: *PendingHandler = @ptrCast(@alignCast(context));
        return self.failure;
    }
};

const Delay = struct {
    value: u64,
    fn delay(context: *anyopaque) u64 {
        const self: *Delay = @ptrCast(@alignCast(context));
        return self.value;
    }
};

fn ccipSteps() [7]Step {
    return .{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
        .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
        .{ .method = "eth_call", .result = ism_word },
        .{ .method = "eth_call", .result = ism_word },
        .{ .method = "eth_call", .result = word("7") },
    };
}

test "CCIP pending uses source delay without retry increment and preserves control errors" {
    const a = std.testing.allocator;
    const msg = testMessage();
    for ([_]?u64{ 250, null }) |configured| {
        const steps = ccipSteps();
        var fixture = try Fixture.init(a, &steps, allow_gas);
        defer fixture.deinit();
        try fixture.storeMessage(msg);
        var handler: PendingHandler = .{ .failure = error.CcipReadPending };
        var delay: Delay = .{ .value = configured orelse 0 };
        var worker = fixture.preparer(testConfig());
        worker.ccip_handler = .{ .context = &handler, .fetch_fn = PendingHandler.fetch };
        if (configured != null) worker.pending_delay = .{ .context = &delay, .delay_ms_fn = Delay.delay };
        var request = input(fixture, msg, null);
        request.retry_state = .{ .ica_reveal_attempts = 3, .origin_lookup_failures = 2, .origin_hash_waited = true, .origin_lookup_skip_until_ms = 999 };
        var outcome = try worker.prepare(request);
        defer outcome.deinit();
        try std.testing.expectEqual(prepare.RetryReason.metadata, outcome.value.retry.reason);
        try std.testing.expectEqual(@as(?u64, configured orelse 1000), outcome.value.retry.delay_ms);
        try std.testing.expectEqual(request.retry_state, outcome.value.retry.retry_state);
        try std.testing.expectEqualStrings("CcipReadPending", outcome.value.retry.failure.?);
        try fixture.mock.expectDone();
    }
    for ([_]anyerror{ error.MessageMetadataRefused, error.OutOfMemory, error.PendingReadIo, error.RequestCancelled }) |failure| {
        const steps = ccipSteps();
        var fixture = try Fixture.init(a, &steps, allow_gas);
        defer fixture.deinit();
        try fixture.storeMessage(msg);
        var handler: PendingHandler = .{ .failure = failure };
        var worker = fixture.preparer(testConfig());
        worker.ccip_handler = .{ .context = &handler, .fetch_fn = PendingHandler.fetch };
        try std.testing.expectError(failure, worker.prepare(input(fixture, msg, null)));
        try fixture.mock.expectDone();
    }
}

test "finalized delivery is distinguishable from unfinalized delivery and stops preparation" {
    const a = std.testing.allocator;
    for ([_]bool{ false, true }) |finalized| {
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = one_word },
            .{ .method = "eth_call", .result = if (finalized) one_word else zero_word },
        };
        var fixture = try Fixture.init(a, &steps, allow_gas);
        defer fixture.deinit();
        const msg = testMessage();
        try fixture.storeMessage(msg);
        var worker = fixture.preparer(testConfig());
        var outcome = try worker.prepare(input(fixture, msg, null));
        defer outcome.deinit();
        try std.testing.expect(outcome.value == .finality_wait);
        try std.testing.expectEqual(finalized, outcome.value.finality_wait.delivered);
        try fixture.mock.expectDone();
    }
}

test "configured block delivery finality uses head minus depth without finalized tag" {
    const a = std.testing.allocator;
    for ([_]bool{ false, true }) |finalized| {
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = one_word },
            .{ .method = "eth_blockNumber", .result = "\"0x64\"" },
            .{ .method = "eth_call", .result = if (finalized) one_word else zero_word },
        };
        var fixture = try Fixture.init(a, &steps, allow_gas);
        defer fixture.deinit();
        const msg = testMessage();
        try fixture.storeMessage(msg);
        var cfg = testConfig();
        cfg.reorg = .{ .blocks = 6 };
        var worker = fixture.preparer(cfg);
        var outcome = try worker.prepare(input(fixture, msg, null));
        defer outcome.deinit();
        try std.testing.expect(outcome.value == .finality_wait);
        try std.testing.expectEqual(finalized, outcome.value.finality_wait.delivered);
        try std.testing.expect(std.mem.indexOf(u8, fixture.mock.requests.items[3], "\"0x5e\"") != null);
        try std.testing.expect(std.mem.indexOf(u8, fixture.mock.requests.items[3], "finalized") == null);
        try fixture.mock.expectDone();
    }
}

test "unpaid and matching denied messages never request metadata or gas estimation" {
    const a = std.testing.allocator;
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
    };
    const minimum: relay_policy.Config = .{ .gas_payment_enforcement = &.{.{ .matching_list = &.{}, .policy = .{ .minimum = 1 } }} };
    var unpaid = try Fixture.init(a, &steps, minimum);
    defer unpaid.deinit();
    const msg = testMessage();
    try unpaid.storeMessage(msg);
    var unpaid_worker = unpaid.preparer(testConfig());
    var unpaid_outcome = try unpaid_worker.prepare(input(unpaid, msg, null));
    defer unpaid_outcome.deinit();
    try std.testing.expectEqual(prepare.RetryReason.gas_payment_not_found, unpaid_outcome.value.retry.reason);
    try unpaid.mock.expectDone();

    const denied_policy: relay_policy.Config = .{ .whitelist = &.{.{ .origin_domain = .{ .values = &.{999} } }}, .gas_payment_enforcement = allow_gas.gas_payment_enforcement };
    var denied = try Fixture.init(a, &steps, denied_policy);
    defer denied.deinit();
    try denied.storeMessage(msg);
    var denied_worker = denied.preparer(testConfig());
    var denied_outcome = try denied_worker.prepare(input(denied, msg, null));
    defer denied_outcome.deinit();
    try std.testing.expect(denied_outcome.value == .denied);
    try std.testing.expectEqual(relay_policy.Denial.not_whitelisted, denied_outcome.value.denied.denial);
    try denied.mock.expectDone();
}

test "not contract malformed code ISM and gas responses stay unsigned typed outcomes" {
    const a = std.testing.allocator;
    const msg = testMessage();
    const no_code = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x\"" },
    };
    var fixture = try Fixture.init(a, &no_code, allow_gas);
    defer fixture.deinit();
    try fixture.storeMessage(msg);
    var worker = fixture.preparer(testConfig());
    var outcome = try worker.prepare(input(fixture, msg, null));
    defer outcome.deinit();
    try std.testing.expect(outcome.value == .not_contract);
    try fixture.mock.expectDone();

    const malformed_code = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0xzz\"" },
    };
    var bad_code = try Fixture.init(a, &malformed_code, allow_gas);
    defer bad_code.deinit();
    try bad_code.storeMessage(msg);
    var bad_code_worker = bad_code.preparer(testConfig());
    var bad_code_outcome = try bad_code_worker.prepare(input(bad_code, msg, null));
    defer bad_code_outcome.deinit();
    try std.testing.expectEqual(prepare.RetryReason.recipient_contract, bad_code_outcome.value.retry.reason);

    const malformed_ism = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
        .{ .method = "eth_blockNumber", .result = "\"0x10\"" },
        .{ .method = "eth_call", .result = ism_word },
        .{ .method = "eth_call", .result = ism_word },
        .{ .method = "eth_call", .result = "\"0x01\"" },
    };
    var bad_ism = try Fixture.init(a, &malformed_ism, allow_gas);
    defer bad_ism.deinit();
    try bad_ism.storeMessage(msg);
    var bad_ism_worker = bad_ism.preparer(testConfig());
    var bad_ism_outcome = try bad_ism_worker.prepare(input(bad_ism, msg, null));
    defer bad_ism_outcome.deinit();
    try std.testing.expectEqual(prepare.RetryReason.metadata, bad_ism_outcome.value.retry.reason);

    const malformed_gas = metadataSteps("\"0x01\"", quantity("2"));
    var bad_gas = try Fixture.init(a, &malformed_gas, allow_gas);
    defer bad_gas.deinit();
    try bad_gas.storeMessage(msg);
    var bad_gas_worker = bad_gas.preparer(testConfig());
    var bad_gas_outcome = try bad_gas_worker.prepare(input(bad_gas, msg, null));
    defer bad_gas_outcome.deinit();
    try std.testing.expectEqual(prepare.RetryReason.estimation, bad_gas_outcome.value.retry.reason);
}

test "hard reorg cancellation and wrong chain propagate without payload effects" {
    const a = std.testing.allocator;
    const msg = testMessage();
    for ([_]anyerror{ error.ValidatorReorg, error.RequestCancelled }) |failure| {
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .failure = failure },
        };
        var fixture = try Fixture.init(a, &steps, allow_gas);
        defer fixture.deinit();
        try fixture.storeMessage(msg);
        var worker = fixture.preparer(testConfig());
        try std.testing.expectError(failure, worker.prepare(input(fixture, msg, null)));
        try fixture.mock.expectDone();
    }
    const wrong = [_]Step{.{ .method = "eth_chainId", .result = "\"0x1\"" }};
    var fixture = try Fixture.init(a, &wrong, allow_gas);
    defer fixture.deinit();
    try fixture.storeMessage(msg);
    var worker = fixture.preparer(testConfig());
    try std.testing.expectError(error.WrongChain, worker.prepare(input(fixture, msg, null)));
}

test "Arbitrum retryable estimate supplies enforceable L2 gas and failed retryable uses direct fallback" {
    const a = std.testing.allocator;
    for ([_]bool{ false, true }) |fallback| {
        const steps = [_]Step{
            .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
            .{ .method = "eth_call", .result = zero_word },
            .{ .method = "eth_getCode", .result = "\"0x01\"" },
            .{ .method = "eth_estimateGas", .result = quantity("3e8") },
            .{ .method = "eth_estimateGas", .result = if (fallback) null else quantity("c8"), .error_object = if (fallback) "{\"code\":-32000,\"message\":\"revert\"}" else null },
            .{ .method = "eth_gasPrice", .result = max_word },
        };
        var fixture = try Fixture.init(a, &steps, allow_gas);
        defer fixture.deinit();
        const msg = testMessage();
        try fixture.storeMessage(msg);
        var cfg = testConfig();
        cfg.arbitrum_nitro = true;
        var worker = fixture.preparer(cfg);
        var outcome = try worker.prepare(input(fixture, msg, &.{ 0xab, 0xcd }));
        defer outcome.deinit();
        const diagnostics = outcome.value.ready.diagnostics;
        try std.testing.expectEqual(fallback, diagnostics.arbitrum_l2_fallback);
        try std.testing.expectEqual(if (fallback) null else @as(?u256, 200), diagnostics.estimate.?.l2_gas_limit);
        try std.testing.expectEqual(@as(u256, 1000), outcome.value.ready.payload.gas_limit);
        try std.testing.expect(std.mem.indexOf(u8, fixture.mock.requests.items[3], "estimateRetryableTicket") == null);
        try std.testing.expect(std.mem.indexOf(u8, fixture.mock.requests.items[4], "00000000000000000000000000000000000000c8") != null);
        try fixture.mock.expectDone();
    }
}

test "direct process RPC ICA reveal error uses injected retry state without rebuilding metadata" {
    const a = std.testing.allocator;
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
        .{ .method = "eth_estimateGas", .error_object = "{\"code\":-32000,\"message\":\"execution reverted: ICA: Invalid Reveal\"}" },
    };
    var fixture = try Fixture.init(a, &steps, allow_gas);
    defer fixture.deinit();
    var msg = testMessage();
    msg.body = &.{ 2, 0x11, 0x22 };
    try fixture.storeMessage(msg);
    var worker = fixture.preparer(testConfig());
    var outcome = try worker.prepare(input(fixture, msg, &.{ 0xab, 0xcd }));
    defer outcome.deinit();
    try std.testing.expectEqual(prepare.RetryReason.awaiting_ica_reveal, outcome.value.retry.reason);
    try std.testing.expectEqual(@as(u32, 1), outcome.value.retry.retry_state.ica_reveal_attempts);
    try std.testing.expectEqualSlices(u8, &.{ 0xab, 0xcd }, outcome.value.retry.cached_metadata.?);
    try fixture.mock.expectDone();
}

const Protected = struct {
    calls: usize = 0,
    fail: bool = true,
    fn estimate(context: *anyopaque, _: A, _: protocol.Message, _: []const u8, _: []const u8, _: [20]u8, _: bool) anyerror!prepare.Estimate {
        const self: *Protected = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (self.fail) return error.IcaInvalidReveal;
        return .{ .gas_limit = std.math.maxInt(u256), .gas_price = std.math.maxInt(u256), .l2_gas_limit = 200 };
    }
};

test "matching private reveal never uses public gas and ICA state retains metadata across retry" {
    const a = std.testing.allocator;
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
    };
    var fixture = try Fixture.init(a, &steps, allow_gas);
    defer fixture.deinit();
    var msg = testMessage();
    msg.body = &.{ 2, 0x11, 0x22 };
    try fixture.storeMessage(msg);
    var cfg = testConfig();
    cfg.canonical_ica_router = msg.recipient;
    var protected: Protected = .{};
    var worker = fixture.preparer(cfg);
    worker.private_estimator = .{ .context = &protected, .estimate_fn = Protected.estimate };
    var first = try worker.prepare(input(fixture, msg, &.{ 0xab, 0xcd }));
    defer first.deinit();
    try std.testing.expectEqual(prepare.RetryReason.awaiting_ica_reveal, first.value.retry.reason);
    try std.testing.expectEqual(@as(u32, 1), first.value.retry.retry_state.ica_reveal_attempts);
    try std.testing.expectEqual(@as(?u64, 1000), first.value.retry.delay_ms);
    try std.testing.expectEqualSlices(u8, &.{ 0xab, 0xcd }, first.value.retry.cached_metadata.?);
    protected.fail = false;
    fixture.mock.index = 0;
    var retry_input = input(fixture, msg, first.value.retry.cached_metadata);
    retry_input.retry_state = first.value.retry.retry_state;
    var second = try worker.prepare(retry_input);
    defer second.deinit();
    try std.testing.expect(second.value == .ready);
    try std.testing.expectEqual(prepare.Estimator.protected, second.value.ready.diagnostics.estimator.?);
    try std.testing.expectEqual(@as(u32, 0), second.value.ready.retry_state.ica_reveal_attempts);
    try std.testing.expectEqual(@as(usize, 2), protected.calls);
    try fixture.mock.expectDone();
}

test "missing protected estimator fails closed without public fallback and max gas is exact" {
    const a = std.testing.allocator;
    const steps = metadataSteps(quantity("64"), quantity("2"));
    var fixture = try Fixture.init(a, steps[0..7], allow_gas);
    defer fixture.deinit();
    var msg = testMessage();
    msg.body = &.{ 2, 0x11, 0x22 };
    try fixture.storeMessage(msg);
    var cfg = testConfig();
    cfg.canonical_ica_router = msg.recipient;
    var worker = fixture.preparer(cfg);
    var outcome = try worker.prepare(input(fixture, msg, null));
    defer outcome.deinit();
    try std.testing.expectEqual(prepare.RetryReason.estimation, outcome.value.retry.reason);
    try std.testing.expectEqualStrings("MissingProtectedEstimator", outcome.value.retry.failure.?);
    try fixture.mock.expectDone();

    const public_steps = cachedSteps(quantity("3e8"), quantity("2"));
    var limited = try Fixture.init(a, &public_steps, allow_gas);
    defer limited.deinit();
    try limited.storeMessage(msg);
    var limited_config = testConfig();
    limited_config.transaction_gas_limit = 999;
    var limited_worker = limited.preparer(limited_config);
    var limited_outcome = try limited_worker.prepare(input(limited, msg, &.{ 0xab, 0xcd }));
    defer limited_outcome.deinit();
    try std.testing.expectEqual(prepare.RetryReason.exceeds_max_gas_limit, limited_outcome.value.retry.reason);
}

test "metadata size cap rejects cached bytes before process estimation" {
    const a = std.testing.allocator;
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
    };
    var fixture = try Fixture.init(a, &steps, allow_gas);
    defer fixture.deinit();
    const msg = testMessage();
    try fixture.storeMessage(msg);
    var cfg = testConfig();
    cfg.max_metadata_bytes = 1;
    var worker = fixture.preparer(cfg);
    var outcome = try worker.prepare(input(fixture, msg, &.{ 0xab, 0xcd }));
    defer outcome.deinit();
    try std.testing.expectEqual(prepare.RetryReason.metadata, outcome.value.retry.reason);
    try std.testing.expectEqualStrings("MetadataTooLarge", outcome.value.retry.failure.?);
    try fixture.mock.expectDone();
}

const Signers = struct {
    fn fetch(context: *anyopaque, allocator: A, _: *native.Store, _: protocol.Message, _: bool) anyerror!prepare.SignerLookup {
        _ = context;
        const values = try allocator.alloc([32]u8, 1);
        values[0] = @splat(0x11);
        return .{ .signers = values };
    }
};

const Feed = struct {
    body: []const u8,
    fn fetch(context: *anyopaque, allocator: A, _: []const u8, _: usize) !denylist.Fetched {
        const self: *Feed = @ptrCast(@alignCast(context));
        return .{ .allocator = allocator, .status = 200, .bytes = try allocator.dupe(u8, self.body) };
    }
    fn now(_: *anyopaque) i64 {
        return 0;
    }
};

test "origin signer runtime denial follows paid preflight and skips metadata" {
    const a = std.testing.allocator;
    const steps = [_]Step{
        .{ .method = "eth_chainId", .result = "\"0x7a69\"" },
        .{ .method = "eth_call", .result = zero_word },
        .{ .method = "eth_getCode", .result = "\"0x01\"" },
    };
    var fixture = try Fixture.init(a, &steps, allow_gas);
    defer fixture.deinit();
    fixture.policy.deinit();
    const parent = try fixture.temporary.dir.realpathAlloc(a, ".");
    defer a.free(parent);
    const cache = try std.fs.path.join(a, &.{ parent, "denylist-cache" });
    defer a.free(cache);
    var feed: Feed = .{ .body = "{\"rules\":[{\"address\":\"0x" ++ "11111111111111111111111111111111" ++ "11111111111111111111111111111111" ++ "\",\"reason\":\"blocked\",\"addedBy\":\"fixture\"}]}" };
    var runtime = try denylist.RuntimeDenylist.init(a, null);
    defer runtime.deinit();
    runtime.config = .{ .url = "https://example.test/feed", .cache_path = cache, .poll_interval_ms = 60000 };
    runtime.transport = .{ .context = &feed, .fetch = Feed.fetch };
    _ = try runtime.refresh(.{ .context = &feed, .now_unix = Feed.now });
    fixture.policy = try relay_policy.Policy.init(a, allow_gas, null, &runtime);
    const msg = testMessage();
    try fixture.storeMessage(msg);
    var worker = fixture.preparer(testConfig());
    var ignored: u8 = 0;
    worker.origin_sender = .{ .context = &ignored, .fetch_fn = Signers.fetch };
    var outcome = try worker.prepare(input(fixture, msg, null));
    defer outcome.deinit();
    try std.testing.expect(outcome.value == .denied);
    try std.testing.expectEqual(relay_policy.Denial.runtime_denylisted, outcome.value.denied.denial);
    try fixture.mock.expectDone();
}

fn allocationSweep(a: A) !void {
    const steps = cachedSteps(quantity("64"), max_word);
    var fixture = try Fixture.init(a, &steps, allow_gas);
    defer fixture.deinit();
    const msg = testMessage();
    try fixture.storeMessage(msg);
    var worker = fixture.preparer(testConfig());
    var outcome = try worker.prepare(input(fixture, msg, &.{ 0xab, 0xcd }));
    defer outcome.deinit();
    try std.testing.expect(outcome.value == .ready);
    try fixture.mock.expectDone();
}

test "preparation and outcome ownership survive allocation failure sweep" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}

test {
    _ = @import("db/bzip2_glue.zig");
}

test "opt-in loopback prepares actual repo Solidity without delivery or nonce mutation" {
    const a = std.testing.allocator;
    const enabled = std.process.getEnvVarOwned(a, "ZIG_EVM_PREPARE_LOOPBACK") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(enabled);
    if (!std.mem.eql(u8, enabled, "1")) return error.SkipZigTest;
    const path = "zig/src/agents/relayer/evm_prepare_fixtures/loopback.json";
    const bytes = try std.fs.cwd().readFileAlloc(a, path, 64 * 1024);
    defer a.free(bytes);
    var document = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
    defer document.deinit();
    const root = document.value.object;
    const raw_message = try fixtureText(a, root.get("message").?);
    defer a.free(raw_message);
    const wire = try evm.codecs.decodeHex(try a.alloc(u8, (raw_message.len - 2) / 2), raw_message);
    defer a.free(wire);
    const msg = try protocol.Message.decode(wire);
    var fixture = try Fixture.init(a, &.{}, allow_gas);
    defer fixture.deinit();
    try fixture.storeMessage(msg);
    fixture.client.deinit();
    var native_curl = try Curl.Client.init(a, fixture_curl_library);
    defer native_curl.deinit();
    fixture.client = try evm.RpcClient.init(a, root.get("rpc_url").?.string, .{ .native_transport = &native_curl });
    const mailbox20 = try evm.codecs.fixedHex(20, root.get("mailbox").?.string);
    var mailbox32: [32]u8 = @splat(0);
    @memcpy(mailbox32[12..], &mailbox20);
    const relayer = try evm.codecs.fixedHex(20, root.get("relayer").?.string);
    const cfg: prepare.Config = .{ .domain = msg.destination, .chain_id = 31337, .mailbox = mailbox32, .relayer = relayer, .reorg = .{ .blocks = 1 } };
    const relayer_text = try evm.codecs.hexAlloc(a, &relayer);
    defer a.free(relayer_text);
    var nonce_before_response = try fixture.client.call("eth_getTransactionCount", .{ relayer_text, "latest" });
    defer nonce_before_response.deinit();
    const nonce_before = try evm.codecs.quantityAs(u256, try evm.provider.string(nonce_before_response.value()));
    var worker = fixture.preparer(cfg);
    var outcome = try worker.prepare(input(fixture, msg, null));
    defer outcome.deinit();
    try std.testing.expect(outcome.value == .ready);
    try std.testing.expect(outcome.value.ready.payload.gas_limit > 0);
    try std.testing.expect(!(try fixture.client.delivered(mailbox20, msg.id(), .latest)));
    var nonce_after_response = try fixture.client.call("eth_getTransactionCount", .{ relayer_text, "latest" });
    defer nonce_after_response.deinit();
    const nonce_after = try evm.codecs.quantityAs(u256, try evm.provider.string(nonce_after_response.value()));
    try std.testing.expectEqual(nonce_before, nonce_after);
}

test "settings resolve Arbitrum protected routers and skipped maximum gas" {
    const overrides = std.mem.zeroes(settings.TransactionOverrides);
    const chain: settings.Chain = .{
        .name = "arbitrum",
        .domain = 42161,
        .protocol = .ethereum,
        .chain_id = "42161",
        .technical_stack = .arbitrumnitro,
        .rpc_urls = &.{},
        .grpc_urls = &.{},
        .contracts = .{ .mailbox = @splat(1), .interchain_gas_paymaster = @splat(2), .validator_announce = @splat(3), .merkle_tree_hook = @splat(4) },
        .index = .{},
        .signer = null,
        .identity = null,
        .ccs_signer = null,
        .reorg = .{ .blocks = 1 },
        .confirmations = 1,
        .estimated_block_time = 1,
        .native_token = .{ .decimals = 18, .symbol = "ETH", .denom = "" },
        .connection = .{ .ethereum = .{
            .consensus = .single,
            .consider_null_transaction_receipt = false,
            .fallback_hedge_delay_ms = null,
            .fallback_hedge_timeout_ms = null,
            .transaction_overrides = overrides,
            .mev_submission = .{ .rpc_urls = &.{}, .ica_router = @splat(5), .additional_ica_routers = &.{@splat(6)} },
        } },
        .submitter = .lander,
        .max_batch_size = 1,
        .batch_contract_address = null,
        .bypass_batch_simulation = false,
        .max_submit_queue_length = null,
        .ignore_reorg_reports = false,
    };
    var cfg = try prepare.Config.fromSettings(&chain, @splat(0x11), 1000, &.{42161});
    try std.testing.expect(cfg.arbitrum_nitro);
    try std.testing.expectEqual(@as(?u256, null), cfg.transaction_gas_limit);
    try std.testing.expectEqual(@as(u256, 42161), cfg.chain_id);
    try std.testing.expectEqualDeep(chain.reorg, cfg.reorg);
    try std.testing.expectEqual(@as(?[32]u8, @splat(5)), cfg.canonical_ica_router);
    try std.testing.expectEqual(@as(usize, 1), cfg.protected_ica_routers.len);
    cfg = try prepare.Config.fromSettings(&chain, @splat(0x11), 1000, &.{});
    try std.testing.expectEqual(@as(?u256, 1000), cfg.transaction_gas_limit);
}
