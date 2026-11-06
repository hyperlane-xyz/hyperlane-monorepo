//! Real SVM MetadataSpec simulation, native read forks and production Registry.
const std = @import("std");
const source = @import("source_metadata.zig");
const resources = @import("../chain_source.zig");
const protocol = @import("../../protocol/root.zig");
const parallel = @import("../../relayer/metadata_parallel.zig");
const metadata = @import("../../relayer/metadata.zig");
const quorum = @import("../../relayer/quorum.zig");
const objects = @import("../../storage/objects.zig");
const observe = @import("../../ops/validator_observability.zig");
const metrics = @import("../../ops/metrics.zig");
const fixture = @import("../../evm/pool_testing.zig");
const A = std.mem.Allocator;
const Hash = [32]u8;
const Address = [20]u8;
const Cancel = *const std.atomic.Value(bool);
const signer: Address = .{ 0x19, 0xe7, 0xe3, 0x76, 0xe7, 0xc2, 0x13, 0xb7, 0xe7, 0xe7, 0xe4, 0x6c, 0xc7, 0x0a, 0x5d, 0xd0, 0x86, 0xda, 0xff, 0x2a };
const validators = [_]Address{ signer, @splat(2), @splat(3) };
const module: Hash = @splat(9);
const app_context = "root-classified-app";
const ProductionCompositeSpec = struct {
    fn spec(a: A) ![]u8 {
        var bytes: std.ArrayList(u8) = .empty;
        errdefer bytes.deinit(a);
        // Some(Aggregation2[MessageIdMultisig1, Aggregation1[Multisig1,Null],Null]).
        try bytes.appendSlice(a, &.{ 1, 2, 2, 3, 0, 0, 0 });
        try leaf(a, &bytes);
        try bytes.appendSlice(a, &.{ 2, 1, 2, 0, 0, 0 });
        try leaf(a, &bytes);
        try bytes.appendSlice(a, &.{ 0, 0, 0, 0, 0, 0, 255 });
        return bytes.toOwnedSlice(a);
    }
    fn leaf(a: A, bytes: *std.ArrayList(u8)) !void {
        try bytes.appendSlice(a, &.{ 1, 3, 0, 0, 0 });
        for (validators) |validator| try bytes.appendSlice(a, &validator);
        try bytes.append(a, 1);
    }
    fn reply(a: A, body: []const u8) ![]u8 {
        const ix = @import("../../sealevel/instructions.zig");
        var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
        defer parsed.deinit();
        const object = parsed.value.object;
        try std.testing.expectEqualStrings("simulateTransaction", object.get("method").?.string);
        const encoded = object.get("params").?.array.items[0].string;
        const wire = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(encoded));
        defer a.free(wire);
        try std.base64.standard.Decoder.decode(wire, encoded);
        const is_type = std.mem.indexOf(u8, wire, &ix.type_discriminator) != null;
        if (!is_type and std.mem.indexOf(u8, wire, &ix.verify_spec_discriminator) == null) return error.UnexpectedCompositeSimulation;
        const bytes = if (is_type) try a.dupe(u8, &.{ 13, 0, 0, 0, 255 }) else try spec(a);
        defer a.free(bytes);
        const data = try a.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len));
        defer a.free(data);
        _ = std.base64.standard.Encoder.encode(data, bytes);
        const program = try @import("../../altvm/base58.zig").encode(a, &module);
        defer a.free(program);
        return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = object.get("id").?, .result = .{ .context = .{ .slot = 20 }, .value = .{ .err = @as(?u8, null), .unitsConsumed = 1000, .returnData = .{ .programId = program, .data = .{ data, "base64" } } } } }, .{});
    }
};
const History = struct {
    signed: objects.SignedCheckpoint,
    stop: Cancel,
    latest_ready: std.atomic.Value(bool) = .init(false),
    quorum_ready: std.atomic.Value(bool) = .init(true),
    quorum_calls: std.atomic.Value(usize) = .init(0),
    quorum_successes: std.atomic.Value(usize) = .init(0),
    latest_calls: std.atomic.Value(usize) = .init(0),
    latest_successes: std.atomic.Value(usize) = .init(0),
    latest_cancelled: std.atomic.Value(usize) = .init(0),
    wrong_latest_token: std.atomic.Value(bool) = .init(false),
    pub fn leafIndex(_: *@This(), _: Hash) !?u32 {
        return 7;
    }
    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return 7;
    }
    pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.NoProof;
    }
    pub fn fetchCheckpoint(self: *@This(), _: Address, _: u32) !?objects.SignedCheckpoint {
        return self.signed;
    }
    pub fn latestIndex(_: *@This(), _: Address) !?u32 {
        return error.UseCompleteConfiguredSet;
    }
    pub fn fetchQuorum(self: *@This(), a: A, set: []const Address, threshold: usize, index: u32, _: *usize, cancel: ?Cancel) anyerror!?quorum.Quorum {
        if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        try std.testing.expectEqualSlices(Address, &validators, set);
        try std.testing.expectEqual(@as(usize, 1), threshold);
        try std.testing.expectEqual(@as(u32, 7), index);
        const calls = self.quorum_calls.fetchAdd(1, .acq_rel);
        if (calls < 20 or !self.quorum_ready.load(.acquire)) return error.PendingReadIo;
        _ = self.quorum_successes.fetchAdd(1, .acq_rel);
        return .{ .allocator = a, .checkpoint = self.signed.value, .signatures = try a.dupe(objects.Signature, &.{self.signed.signature}) };
    }
    pub fn fetchLatestIndices(self: *@This(), set: []const Address, output: []?u32, _: *usize, cancel: ?Cancel) !void {
        _ = self.latest_calls.fetchAdd(1, .acq_rel);
        if (cancel == null or cancel.? != self.stop) self.wrong_latest_token.store(true, .release);
        if (cancel) |flag| if (flag.load(.acquire)) {
            _ = self.latest_cancelled.fetchAdd(1, .acq_rel);
            return error.RequestCancelled;
        };
        try std.testing.expectEqualSlices(Address, &validators, set);
        try std.testing.expectEqual(@as(usize, 3), output.len);
        if (!self.latest_ready.load(.acquire)) return error.PendingReadIo;
        @memcpy(output, &[_]?u32{ 7, 9, null });
        _ = self.latest_successes.fetchAdd(1, .acq_rel);
    }
};
fn now(_: *anyopaque) u64 {
    return 0;
}
fn name(_: *anyopaque, domain: u32) ![]const u8 {
    return switch (domain) {
        1 => "origin",
        2 => "svm",
        else => error.UnknownDomain,
    };
}
fn waitFor(condition: *std.atomic.Value(usize), minimum: usize) !void {
    var timer = try std.time.Timer.start();
    while (condition.load(.acquire) < minimum) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.CompositeObservationTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}
fn sum(wire: []const u8, metric: []const u8) !f64 {
    var result: f64 = 0;
    var lines = std.mem.splitScalar(u8, wire, '\n');
    while (lines.next()) |line| if (std.mem.startsWith(u8, line, metric) and line.len > metric.len and line[metric.len] == '{') {
        result += try std.fmt.parseFloat(f64, line[std.mem.lastIndexOfScalar(u8, line, ' ').? + 1 ..]);
    };
    return result;
}
const Scenario = enum { complete, cancel_observation, cancel_build };
const BuildTask = struct {
    native: *source.Source(History),
    executor: *parallel.Executor,
    cancelled: Cancel,
    message: protocol.Message,
    failure: ?anyerror = null,
    fn run(self: *@This()) void {
        self.build() catch |err| {
            self.failure = err;
            return;
        };
        self.failure = error.UnexpectedCompositeBuildSuccess;
    }
    fn build(self: *@This()) !void {
        var builder: metadata.Builder(source.Source(History)) = .{ .allocator = std.testing.allocator, .source = self.native, .executor = self.executor, .cancel = self.cancelled };
        while (true) {
            try self.native.beginPass(self.cancelled);
            const output = builder.build(module, self.message) catch |err| {
                self.native.endPass(err);
                if (err != error.PendingReadIo) return err;
                std.Thread.sleep(std.time.ns_per_ms);
                continue;
            };
            self.native.endPass(null);
            std.testing.allocator.free(output);
            return;
        }
    }
};
fn exercise(scenario: Scenario) !void {
    const cancel_observation = scenario == .cancel_observation;
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behavior = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = ProductionCompositeSpec.reply }};
    var server = try fixture.Fixture.init(8, &behavior);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chain = @import("../chain_source_testing.zig").chainFor(&.{url});
    chain.protocol = .sealevel;
    chain.name = "svm";
    chain.domain = 2;
    chain.connection = .{ .sealevel = .{ .max_supported_transaction_version = 0, .transaction_submitter = .rpc, .transaction_submitter_urls = &.{}, .priority_fee = 0, .priority_fee_oracle = .{ .constant = 0 }, .mailbox_process_alts = &.{}, .process_alt_overrides = &.{}, .ur_reveal = null, .native_token_decimals = 9 } };
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var budget: resources.ReadReplay.ByteBudget = .{ .maximum = 1024 * 1024 };
    const readers = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .cooperative_reads = true, .read_budget = &budget, .rpc_parallelism = 8, .rpc_max_response_bytes = 32768, .request_timeout_ms = 8000 });
    defer readers.deinit();
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var clock_context: u8 = 0;
    var manager = observe.Manager.init(a, registry, .{ .context = &clock_context, .now_ms_fn = now });
    defer manager.deinit();
    manager.max_contexts = 1;
    manager.max_validators = 3;
    var active: observe.Active = .{ .manager = &manager, .resolver = .{ .context = &clock_context, .name_fn = name } };
    const executor = try parallel.Root.start(a, .{ .workers = 2, .max_retained_jobs = 32, .max_output_bytes = 4096 });
    var executor_live = true;
    defer if (executor_live) executor.deinit();
    const message: protocol.Message = .{ .origin = 1, .destination = 2, .nonce = 7, .body = "public SVM metadata fixture" };
    const checkpoint: protocol.Checkpoint = .{ .merkle_tree_hook_address = @splat(1), .mailbox_domain = 1, .root = @splat(2), .index = 7, .message_id = message.id() };
    var history: History = .{ .signed = try objects.SignedCheckpoint.sign(checkpoint, @splat(0x11), null), .stop = executor.executor.stopToken() };
    try std.testing.expectEqual(signer, try history.signed.recover());
    const unix_ns = try @import("../scraper/receipts_evm.zig").nowNs();
    var cancelled = std.atomic.Value(bool).init(false);
    var native = source.Source(History).init(a, readers, &history, .{ .deadline_ns = unix_ns + 8 * std.time.ns_per_s, .cancel = &cancelled, .svm_payer = @splat(3), .executor = &executor.executor, .observation = active.observation(), .app_context = app_context });
    if (scenario == .cancel_build) {
        history.quorum_ready.store(false, .release);
        var task: BuildTask = .{ .native = &native, .executor = &executor.executor, .cancelled = &cancelled, .message = message };
        const thread = try std.Thread.spawn(.{}, BuildTask.run, .{&task});
        var joined = false;
        defer if (!joined) {
            cancelled.store(true, .release);
            thread.join();
        };
        try waitFor(&history.quorum_calls, 20);
        var stop_timer = try std.time.Timer.start();
        cancelled.store(true, .release);
        thread.join();
        joined = true;
        try std.testing.expectEqual(error.RequestCancelled, task.failure.?);
        if (stop_timer.read() >= 2 * std.time.ns_per_s) return error.CompositeCancellationTooSlow;
        executor.deinit();
        executor_live = false;
        try std.testing.expectEqual(@as(usize, 0), history.quorum_successes.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), history.latest_successes.load(.acquire));
        try std.testing.expect(!history.wrong_latest_token.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), budget.used);
        const cancelled_wire = try registry.render(a);
        defer a.free(cancelled_wire);
        try std.testing.expectEqual(@as(f64, 0), try sum(cancelled_wire, observe.ism_metric_name));
        try std.testing.expectEqual(@as(f64, 0), try sum(cancelled_wire, observe.metric_name));
        try server.check();
        return;
    }
    var builder: metadata.Builder(@TypeOf(native)) = .{ .allocator = a, .source = &native, .executor = &executor.executor, .cancel = &cancelled, .app_context = "wrong-stack-context" };
    var timer = try std.time.Timer.start();
    const output = while (true) {
        try native.beginPass(&cancelled);
        const bytes = builder.build(module, message) catch |err| {
            native.endPass(err);
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.CompositeBuildTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        native.endPass(null);
        break bytes;
    };
    defer a.free(output);
    const aggregation = try protocol.metadata.Aggregation.decode(output, 3);
    try std.testing.expect((try aggregation.metadataAt(0)) != null);
    const nested = try protocol.metadata.Aggregation.decode((try aggregation.metadataAt(1)).?, 2);
    try std.testing.expect((try nested.metadataAt(0)) != null);
    try std.testing.expect((try nested.metadataAt(1)) == null);
    try std.testing.expect((try aggregation.metadataAt(2)) == null);
    try std.testing.expectEqual(@as(usize, 2), history.quorum_successes.load(.acquire));
    try std.testing.expect(history.quorum_calls.load(.acquire) >= 22);
    try waitFor(&history.latest_calls, 20);
    // Completed build cancellation cannot poison the detached full-set read.
    cancelled.store(true, .release);
    try std.testing.expect(!history.stop.load(.acquire));
    if (cancel_observation) {
        executor.deinit();
        executor_live = false;
        try std.testing.expectEqual(@as(usize, 0), history.latest_successes.load(.acquire));
        try std.testing.expect(history.latest_cancelled.load(.acquire) <= 2);
    } else {
        history.latest_ready.store(true, .release);
        try waitFor(&history.latest_successes, 2);
        var drain = try std.time.Timer.start();
        while (executor.executor.retainedJobs() != 0) {
            if (drain.read() > 2 * std.time.ns_per_s) return error.CompositeObservationRetirementTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        try std.testing.expectEqual(@as(usize, 2), history.latest_successes.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), executor.executor.retainedOutputBytes());
    }
    try std.testing.expect(!history.wrong_latest_token.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    const wire = try registry.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 2), try sum(wire, observe.ism_metric_name));
    try std.testing.expect(std.mem.indexOf(u8, wire, "app_context=\"root-classified-app\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, wire, "wrong-stack-context") == null);
    if (cancel_observation) {
        try std.testing.expectEqual(@as(f64, 0), try sum(wire, observe.metric_name));
    } else {
        try std.testing.expectEqual(@as(f64, 15), try sum(wire, observe.metric_name));
        var found_missing = false;
        var lines = std.mem.splitScalar(u8, wire, '\n');
        while (lines.next()) |line| if (std.mem.startsWith(u8, line, observe.metric_name) and std.mem.indexOf(u8, line, "validator=\"0x0303030303030303030303030303030303030303\",app_context=\"root-classified-app\"") != null) {
            try std.testing.expect(std.mem.endsWith(u8, line, "} -1"));
            found_missing = true;
        };
        try std.testing.expect(found_missing);
        try std.testing.expectEqual(@as(usize, 1), manager.contexts.items.len);
        try std.testing.expectEqual(@as(usize, 3), manager.contexts.items[0].validators.count());
    }
    try std.testing.expectEqual(@as(usize, 0), manager.failures.load(.acquire));
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    try server.check();
}
test "SVM native ProductionCompositeSpec nested leaves publish one ISM result and full latest set per leaf under resolved root context" {
    try exercise(.complete);
}
test "SVM native ProductionCompositeSpec detached latest observes global shutdown after operation cancellation" {
    try exercise(.cancel_observation);
}

test "SVM native ProductionCompositeSpec cancellation during suspended quorum drains nested leaf forks without publishing completion" {
    try exercise(.cancel_build);
}

const CountedLink = struct {
    references: std.atomic.Value(usize) = .init(0),
    fn interface(self: *@This()) parallel.CancelLink {
        return .{ .context = self, .poll_fn = poll, .retain_fn = retain, .release_fn = release };
    }
    fn poll(_: *anyopaque) bool {
        return false;
    }
    fn retain(context: *anyopaque) void {
        const self: *@This() = @ptrCast(@alignCast(context));
        _ = self.references.fetchAdd(1, .acq_rel);
    }
    fn release(context: *anyopaque) void {
        const self: *@This() = @ptrCast(@alignCast(context));
        std.debug.assert(self.references.fetchSub(1, .acq_rel) > 0);
    }
};
fn forkAllocation(a: A, native: *source.Source(History)) !void {
    const counted: *CountedLink = @ptrCast(@alignCast(native.metadata_parent.?.context));
    // Runs after the child destructor on success, and after all constructor
    // errdefers on each injected failure, before the next sweep invocation.
    defer std.debug.assert(counted.references.load(.acquire) == 1);
    var cancelled = std.atomic.Value(bool).init(false);
    const fork = try native.fork(a, &cancelled);
    defer fork.deinitFork();
    try std.testing.expect(fork.owns_svm_inline_members);
    try std.testing.expect(fork.svm_inline_members.?.validators.ptr != native.svm_inline_members.?.validators.ptr);
    try std.testing.expectEqualSlices(Address, &validators, fork.svm_inline_members.?.validators);
    try std.testing.expect(fork.readers.rpc_pool == native.readers.rpc_pool and !fork.readers.rpc_pool_owned);
}
test "SVM native inline validator fork owns decoded spec state and releases every partial allocation" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var chain = @import("../chain_source_testing.zig").chainFor(&.{"http://127.0.0.1:1"});
    chain.protocol = .sealevel;
    chain.connection = .{ .sealevel = .{ .max_supported_transaction_version = 0, .transaction_submitter = .rpc, .transaction_submitter_urls = &.{}, .priority_fee = 0, .priority_fee_oracle = .{ .constant = 0 }, .mailbox_process_alts = &.{}, .process_alt_overrides = &.{}, .ur_reveal = null, .native_token_decimals = 9 } };
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const readers = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .cooperative_reads = true, .rpc_parallelism = 1 });
    defer readers.deinit();
    var stop = std.atomic.Value(bool).init(false);
    const checkpoint: protocol.Checkpoint = .{ .merkle_tree_hook_address = @splat(1), .mailbox_domain = 1, .root = @splat(2), .index = 7, .message_id = @splat(3) };
    var history: History = .{ .signed = try objects.SignedCheckpoint.sign(checkpoint, @splat(0x11), null), .stop = &stop };
    var native = source.Source(History).init(a, readers, &history, .{ .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + 30 * std.time.ns_per_s });
    native.svm_inline_members = .{ .validators = &validators, .threshold = 1 };
    var counted: CountedLink = .{};
    native.setMetadataParent(counted.interface());
    defer native.setMetadataParent(null);
    try std.testing.checkAllAllocationFailures(a, forkAllocation, .{&native});
    try std.testing.expectEqual(@as(usize, 1), counted.references.load(.acquire));
    native.setMetadataParent(null);
    try std.testing.expectEqual(@as(usize, 0), counted.references.load(.acquire));
}
