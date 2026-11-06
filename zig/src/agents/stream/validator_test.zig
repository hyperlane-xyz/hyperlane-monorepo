const std = @import("std");
const stream = @import("validator.zig");
const wire = @import("protocol.zig");
const protocol = @import("../../protocol/root.zig");
const Mock = struct {
    votes: [7]?u32 = .{ 5, 4, 3, 2, null, null, null },
    failed_slot: ?usize = null,
    bad_slot: ?usize = null,
    calls: usize = 0,
    fn checkpoint(index: u32) protocol.Checkpoint {
        return .{ .mailbox_domain = 1, .merkle_tree_hook_address = @splat(2), .index = index, .root = @splat(@intCast(index)), .message_id = @splat(@intCast(index + 1)) };
    }
    fn origin(self: *Mock) stream.Origin {
        return .{ .context = self, .accept_fn = accept, .proof_fn = proof, .persist_cursor_fn = persist };
    }
    fn canonical(self: *Mock) stream.Canonical {
        return .{ .context = self, .count_fn = count, .vote_fn = vote };
    }
    fn accept(_: *anyopaque, _: u64, _: wire.MerkleInsertion, _: u64) !stream.Acceptance {
        return error.UnexpectedInsertion;
    }
    fn persist(_: *anyopaque, _: u64, _: u32) !void {
        return error.UnexpectedCursor;
    }
    fn proof(_: *anyopaque, _: u64, index: u32) !?protocol.Checkpoint {
        return checkpoint(index);
    }
    fn count(_: *anyopaque, _: u64, _: u32, _: u64) !u32 {
        return error.UnexpectedProbe;
    }
    fn vote(ctx: *anyopaque, _: u64, slot: usize, _: u64) !?protocol.Checkpoint {
        const self: *Mock = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        if (self.failed_slot == slot) return error.UnavailableEndpoint;
        var value = checkpoint(self.votes[slot] orelse return null);
        if (self.bad_slot == slot) value.root = @splat(0xff);
        return value;
    }
    fn controller(self: *Mock, a: std.mem.Allocator, endpoints: usize) !stream.Controller {
        var value = try stream.Controller.init(a, .{ .domain = 1, .hook = @splat(2), .mode = .lightweight, .endpoint_count = endpoints }, self.origin(), self.canonical());
        try value.beginGeneration(1);
        value.activated = true;
        return value;
    }
};
test "lightweight thresholds round up exactly like production Rust for every small endpoint denominator" {
    var mock: Mock = .{};
    for ([_]usize{ 1, 2, 3, 4, 5, 6, 7 }, [_]usize{ 1, 2, 2, 3, 4, 4, 5 }) |n, required| {
        var controller = try mock.controller(std.testing.allocator, n);
        defer controller.deinit();
        try std.testing.expectEqual(required, controller.requiredVotes());
    }
    mock.votes[1] = null;
    var two = try mock.controller(std.testing.allocator, 2);
    defer two.deinit();
    try std.testing.expectError(error.CheckpointAgreementUnavailable, two.authenticate(1, 0));
}
test "mixed locally matching heights authorize required-th prefix while failures and wrong roots retain slots" {
    var mock: Mock = .{};
    var controller = try mock.controller(std.testing.allocator, 5);
    defer controller.deinit();
    const value = (try controller.authenticate(1, 0)).?.authenticated;
    try std.testing.expectEqual(@as(u32, 2), value.index);
    try std.testing.expectEqual(Mock.checkpoint(2).message_id, value.message_id);
    try std.testing.expectEqual(@as(usize, 5), mock.calls);
    mock.bad_slot = 0;
    try std.testing.expectError(error.CheckpointAgreementUnavailable, controller.authenticate(1, 0));
    mock.bad_slot = null;
    mock.failed_slot = 1;
    try std.testing.expectError(error.CheckpointAgreementUnavailable, controller.authenticate(1, 0));
}
test "late frames ready and probe completions cannot rewind or revive a retired stream generation" {
    var mock: Mock = .{};
    var controller = try mock.controller(std.testing.allocator, 3);
    defer controller.deinit();
    try controller.beginGeneration(10);
    try std.testing.expect((try controller.handle(9, .{ .ready = .{} }, 0)) == null);
    try std.testing.expect((try controller.tick(9, 0)) == null);
    try std.testing.expect((try controller.completeProbe(9, 0, 0, 0)) == null);
    try std.testing.expectEqual(@as(u64, 10), controller.generation);
    _ = controller.close(false);
    try std.testing.expect((try controller.handle(10, .{ .ready = .{} }, 0)) == null);
    try std.testing.expect((try controller.authenticate(10, 0)) == null);
    try std.testing.expectError(error.StreamGenerationNotReady, controller.handle(11, .{ .other = {} }, 0));
    try std.testing.expectEqual(@as(u64, 10), controller.generation);
    try controller.beginGeneration(11);
    try std.testing.expectError(error.StaleStreamGeneration, controller.beginGeneration(10));
    try std.testing.expect((try controller.handle(10, .{ .ready = .{} }, 0)) == null);
    try std.testing.expectEqual(@as(usize, 0), mock.calls);
}
test "checkpoint authentication allocations free on every failure" {
    const Fixture = struct {
        fn run(a: std.mem.Allocator) !void {
            var mock: Mock = .{};
            var controller = try mock.controller(a, 5);
            defer controller.deinit();
            _ = try controller.authenticate(1, 0);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Fixture.run, .{});
}
