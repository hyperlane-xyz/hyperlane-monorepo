//! Source Sealevel inline aggregation uses join_all, then scans ALL results for
//! refusals before selecting threshold. Views own independent read continuations.
const std = @import("std");
const parallel = @import("../relayer/metadata_parallel.zig");
const metadata = @import("../relayer/metadata.zig");
const protocol = @import("../protocol/root.zig");
const Spec = @import("instructions.zig").MetadataSpec;
const A = std.mem.Allocator;
pub const InlineView = struct {
    context: *anyopaque,
    build_fn: *const fn (*anyopaque, A, [32]u8, protocol.Message, Spec, usize) anyerror![]u8,
    begin_fn: *const fn (*anyopaque, *const std.atomic.Value(bool)) anyerror!void,
    end_fn: *const fn (*anyopaque, ?anyerror) void,
    deinit_fn: *const fn (*anyopaque) void,
};
pub const Results = struct {
    allocator: A,
    executor: *parallel.Executor,
    values: []?[]u8,
    pub fn deinit(self: *Results) void {
        for (self.values) |value| if (value) |bytes| {
            self.executor.releaseOutput(bytes.len);
            self.allocator.free(bytes);
        };
        self.allocator.free(self.values);
        self.* = undefined;
    }
};
pub const InlineExecutor = struct {
    executor: *parallel.Executor,
    context: *anyopaque,
    fork_fn: *const fn (*anyopaque, A, *const std.atomic.Value(bool)) anyerror!InlineView,
    pub fn buildAll(self: InlineExecutor, a: A, address: [32]u8, message: protocol.Message, children: []const Spec, depth: usize, external_cancel: ?*const std.atomic.Value(bool)) !Results {
        if (children.len > 100) return error.IsmCountExceeded;
        const jobs = try a.alloc(Job, children.len);
        defer a.free(jobs);
        var cancel = std.atomic.Value(bool).init(false);
        for (jobs, children) |*job, spec| job.* = .{ .allocator = a, .executor = self.executor, .address = address, .message = message, .spec = spec, .depth = depth, .cancel = &cancel };
        var scheduled: usize = 0;
        var failure: ?anyerror = null;
        for (jobs) |*job| {
            job.view = self.fork_fn(self.context, a, &cancel) catch |err| {
                failure = err;
                break;
            };
            self.executor.submit(&job.job) catch |err| {
                job.view.?.deinit_fn(job.view.?.context);
                job.view = null;
                failure = err;
                break;
            };
            scheduled += 1;
        }
        if (failure != null) cancel.store(true, .release);
        while (true) {
            if (external_cancel) |flag| if (flag.load(.acquire)) {
                cancel.store(true, .release);
                failure = error.RequestCancelled;
            };
            var finished: usize = 0;
            for (jobs[0..scheduled]) |*job| if (job.done.load(.acquire)) {
                finished += 1;
            };
            if (finished == scheduled) break;
            if (!self.executor.assist()) std.Thread.sleep(std.time.ns_per_ms);
        }
        // Every child has retired its view before publishing done. Even when a
        // refusal arrives early, source join_all keeps all other child results.
        defer for (jobs[0..scheduled]) |*job| if (job.bytes) |bytes| {
            self.executor.releaseOutput(bytes.len);
            a.free(bytes);
        };
        for (jobs[0..scheduled]) |*job| if (job.failure) |err| if (metadata.hardFailure(err) or err == error.IsmDepthExceeded or err == error.IsmCountExceeded or err == error.MetadataOutputBudgetExceeded) {
            failure = err;
        };
        if (failure) |err| return err;
        const values = try a.alloc(?[]u8, children.len);
        for (jobs, values) |*job, *value| {
            value.* = job.bytes;
            job.bytes = null;
        }
        return .{ .allocator = a, .executor = self.executor, .values = values };
    }
};
const Job = struct {
    job: parallel.Job = .{ .run_fn = run },
    allocator: A,
    executor: *parallel.Executor,
    address: [32]u8,
    message: protocol.Message,
    spec: Spec,
    depth: usize,
    cancel: *std.atomic.Value(bool),
    view: ?InlineView = null,
    done: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    bytes: ?[]u8 = null,
    fn retire(self: *Job, failure: ?anyerror) parallel.RunResult {
        self.failure = failure;
        if (self.view) |view| view.deinit_fn(view.context);
        self.view = null;
        // Executor.run reads no Job fields on .done. No access after this store:
        // the joining caller may release job storage immediately.
        self.done.store(true, .release);
        return .done;
    }
    fn run(raw: *parallel.Job) parallel.RunResult {
        const self: *Job = @alignCast(@fieldParentPtr("job", raw));
        const view = self.view.?;
        if (self.cancel.load(.acquire)) {
            view.end_fn(view.context, error.RequestCancelled);
            return self.retire(error.RequestCancelled);
        }
        view.begin_fn(view.context, self.cancel) catch |err| return self.retire(err);
        const result = view.build_fn(view.context, self.allocator, self.address, self.message, self.spec, self.depth);
        const failure: ?anyerror = if (result) |_| null else |err| err;
        view.end_fn(view.context, failure);
        if (result) |bytes| {
            if (!self.executor.reserveOutput(bytes.len)) {
                self.allocator.free(bytes);
                return self.retire(error.MetadataOutputBudgetExceeded);
            }
            self.bytes = bytes;
            return self.retire(null);
        } else |err| {
            if (err == error.PendingReadIo) return .suspended;
            return self.retire(err);
        }
    }
};

const Fake = struct {
    allocator: A,
    calls: *std.atomic.Value(usize),
    closed: *std.atomic.Value(usize),
    passes: usize = 0,
    fn fork(ctx: *anyopaque, a: A, _: *const std.atomic.Value(bool)) !InlineView {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        const child = try a.create(Fake);
        child.* = self.*;
        child.allocator = a;
        return .{ .context = child, .build_fn = build, .begin_fn = begin, .end_fn = end, .deinit_fn = deinit };
    }
    fn begin(_: *anyopaque, _: *const std.atomic.Value(bool)) !void {}
    fn end(_: *anyopaque, _: ?anyerror) void {}
    fn deinit(ctx: *anyopaque) void {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        _ = self.closed.fetchAdd(1, .monotonic);
        self.allocator.destroy(self);
    }
    fn build(ctx: *anyopaque, a: A, _: [32]u8, _: protocol.Message, spec: Spec, _: usize) ![]u8 {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        self.passes += 1;
        _ = self.calls.fetchAdd(1, .monotonic);
        if (spec == .cannot_verify) {
            if (self.passes < 4) return error.PendingReadIo;
            return error.MessageMetadataRefused;
        }
        if (self.passes < 2) return error.PendingReadIo;
        return a.dupe(u8, "inline-result");
    }
};
test "SVM inline executor joins all independent continuations and late refusal beats early threshold" {
    const a = std.testing.allocator;
    const root = try parallel.Root.start(a, .{});
    defer root.deinit();
    var calls = std.atomic.Value(usize).init(0);
    var closed = std.atomic.Value(usize).init(0);
    var fake: Fake = .{ .allocator = a, .calls = &calls, .closed = &closed };
    const executor: InlineExecutor = .{ .executor = &root.executor, .context = &fake, .fork_fn = Fake.fork };
    const children = [_]Spec{ .null_metadata, .null_metadata, .null_metadata, .null_metadata, .null_metadata, .null_metadata, .null_metadata, .null_metadata, .cannot_verify };
    try std.testing.expectError(error.MessageMetadataRefused, executor.buildAll(a, @splat(1), .{}, &children, 1, null));
    try std.testing.expectEqual(@as(usize, 9), closed.load(.acquire));
    try std.testing.expectEqual(@as(usize, 20), calls.load(.acquire));
    var result = try executor.buildAll(a, @splat(1), .{}, children[0..8], 1, null);
    try std.testing.expectEqual(@as(usize, 8), result.values.len);
    for (result.values) |bytes| try std.testing.expectEqualStrings("inline-result", bytes.?);
    result.deinit();
    try std.testing.expectEqual(@as(usize, 0), root.executor.retainedOutputBytes());
}
