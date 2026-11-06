//! Native SVM metadata source and inline composite-spec interpreter. Composite
//! children are inline trees, not truncated EVM contract addresses. Every branch
//! is evaluated before threshold selection so a late reorg refusal is decisive.
const std = @import("std");
const native = @import("ism.zig");
const ix = @import("instructions.zig");
const protocol = @import("../protocol/root.zig");
const metadata = @import("../relayer/metadata.zig");
const quorum = @import("../relayer/quorum.zig");
const storage = @import("../storage/root.zig");
const A = std.mem.Allocator;
const inline_metadata = @import("inline_metadata.zig");
pub const InlineExecutor = inline_metadata.InlineExecutor;
pub const InlineView = inline_metadata.InlineView;
const Key = [32]u8;
const Address = [20]u8;
pub const InlineMembers = struct { validators: []const Address, threshold: usize };
/// Native production leaves use the same forkable metadata builder as their
/// root, including its observer, resolved application context and executor.
pub const LeafBuilder = struct {
    context: *anyopaque,
    build_fn: *const fn (*anyopaque, A, Key, protocol.Message, InlineMembers) anyerror![]u8,
};
pub fn Source(comptime Origin: type) type {
    return struct {
        const Self = @This();
        pub const ModuleAddress = Key;
        pub const parallel_quorum = @hasDecl(Origin, "fetchQuorum");
        pub const parallel_latest = @hasDecl(Origin, "fetchLatestIndices");
        allocator: A,
        ism: native.Client,
        origin: *Origin,
        cancel: ?*const std.atomic.Value(bool) = null,
        max_depth: usize = 13,
        max_count: usize = 100,
        inline_members: ?InlineMembers = null,
        inline_executor: ?InlineExecutor = null,
        leaf_builder: ?LeafBuilder = null,
        fn check(self: *Self) !void {
            if (self.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        }
        pub fn moduleType(self: *Self, address: Key) !metadata.ModuleType {
            try self.check();
            if (self.inline_members != null) return .message_id_multisig;
            return std.meta.intToEnum(metadata.ModuleType, try self.ism.moduleType(address)) catch error.UnsupportedIsmType;
        }
        pub fn members(self: *Self, address: Key, message: protocol.Message, comptime validators: bool) !metadata.ModuleMembers(if (validators) Address else Key) {
            try self.check();
            if (!validators) return error.UnsupportedSvmExternalAggregation;
            if (self.inline_members) |set| return .{ .addresses = try self.allocator.dupe(Address, set.validators), .threshold = set.threshold };
            const result = try self.ism.validatorsAndThreshold(self.allocator, address, message);
            return .{ .addresses = result.addresses, .threshold = result.threshold };
        }
        pub fn route(_: *Self, _: Key, _: protocol.Message) !Key {
            return error.UnsupportedSvmExternalRouting;
        }
        pub fn verifyCandidate(self: *Self, address: Key, message: protocol.Message, bytes: []const u8) !metadata.Verification {
            try self.check();
            return .{ .valid = try self.ism.verify(address, message, bytes) };
        }
        pub fn leafIndex(self: *Self, id: Key) !?u32 {
            try self.check();
            return self.origin.leafIndex(id);
        }
        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            try self.check();
            return self.origin.highestKnownLeafIndex();
        }
        pub fn fetchCheckpoint(self: *Self, v: Address, index: u32) !?storage.SignedCheckpoint {
            try self.check();
            return self.origin.fetchCheckpoint(v, index);
        }
        pub fn latestIndex(self: *Self, v: Address) !?u32 {
            try self.check();
            return self.origin.latestIndex(v);
        }
        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            try self.check();
            return self.origin.proof(index, checkpoint);
        }
        pub fn fetchQuorum(self: *Self, a: A, validators: []const Address, threshold: usize, index: u32, errors: *usize) !?quorum.Quorum {
            try self.check();
            return self.origin.fetchQuorum(a, validators, threshold, index, errors, self.cancel);
        }
        pub fn fetchLatestIndices(self: *Self, validators: []const Address, output: []?u32, errors: *usize) !void {
            try self.check();
            if (validators.len != output.len) return error.InvalidLatestIndicesLength;
            if (@hasDecl(Origin, "fetchLatestIndices")) return self.origin.fetchLatestIndices(validators, output, errors, self.cancel);
            for (validators, output) |validator, *latest| latest.* = self.origin.latestIndex(validator) catch |err| {
                if (metadata.hardFailure(err)) return err;
                errors.* += 1;
                latest.* = null;
                continue;
            };
        }
        pub fn compositeMetadata(self: *Self, address: Key, message: protocol.Message) ![]u8 {
            try self.check();
            var result = try self.ism.metadataSpec(self.allocator, address, message);
            defer result.deinit();
            return self.buildSpec(address, message, result.spec orelse return error.MetadataSpecDidNotConverge);
        }
        pub fn buildSpec(self: *Self, address: Key, message: protocol.Message, spec: ix.MetadataSpec) ![]u8 {
            return self.buildSpecDepth(address, message, spec, 0);
        }
        pub fn buildSpecDepth(self: *Self, address: Key, message: protocol.Message, spec: ix.MetadataSpec, depth: usize) ![]u8 {
            var visited: usize = 0;
            try self.validateSpec(spec, depth, &visited);
            visited = 0;
            return self.specNode(address, message, spec, depth, &visited);
        }
        fn validateSpec(self: *Self, spec: ix.MetadataSpec, depth: usize, visited: *usize) anyerror!void {
            if (depth > self.max_depth) return error.IsmDepthExceeded;
            if (visited.* >= self.max_count) return error.IsmCountExceeded;
            visited.* += 1;
            if (spec == .aggregation) for (spec.aggregation.children) |child| try self.validateSpec(child, depth + 1, visited);
        }
        fn specNode(self: *Self, address: Key, message: protocol.Message, spec: ix.MetadataSpec, depth: usize, visited: *usize) anyerror![]u8 {
            try self.check();
            if (depth > self.max_depth) return error.IsmDepthExceeded;
            if (visited.* >= self.max_count) return error.IsmCountExceeded;
            visited.* += 1;
            return switch (spec) {
                .null_metadata => self.allocator.alloc(u8, 0),
                .cannot_verify => error.CompositeCannotVerify,
                .trusted_relayer => |key| blk: {
                    const identity = self.ism.identity orelse return error.CompositeTrustedRelayerMismatch;
                    const payer = self.ism.mailbox.payer orelse return error.MissingSimulationPayer;
                    if (std.mem.eql(u8, &identity, &payer) or !std.mem.eql(u8, &key, &identity)) return error.CompositeTrustedRelayerMismatch;
                    break :blk self.allocator.alloc(u8, 0);
                },
                .multisig_message_id => |set| blk: {
                    const members_: InlineMembers = .{ .validators = set.validators, .threshold = set.threshold };
                    if (self.leaf_builder) |leaf_builder| break :blk leaf_builder.build_fn(leaf_builder.context, self.allocator, address, message, members_);
                    var leaf = self.*;
                    leaf.inline_members = members_;
                    var builder: metadata.Builder(Self) = .{ .allocator = self.allocator, .source = &leaf, .max_depth = self.max_depth, .max_count = self.max_count };
                    break :blk builder.build(address, message);
                },
                .aggregation => |aggregation| blk: {
                    const children = aggregation.children;
                    if (aggregation.threshold == 0 or aggregation.threshold > children.len) return error.InvalidIsmThreshold;
                    if (children.len > self.max_count) return error.IsmCountExceeded;
                    var parallel_results: ?inline_metadata.Results = if (self.inline_executor) |executor| try executor.buildAll(self.allocator, address, message, children, depth + 1, self.cancel) else null;
                    const results = if (parallel_results) |result| result.values else try self.allocator.alloc(?[]u8, children.len);
                    if (parallel_results == null) @memset(results, null);
                    defer {
                        if (parallel_results) |*result| result.deinit() else {
                            for (results) |bytes| if (bytes) |owned| self.allocator.free(owned);
                            self.allocator.free(results);
                        }
                    }
                    // Continue through all buildable branches. An actual reorg flag
                    // is never hidden by a successful earlier threshold.
                    if (parallel_results == null) {
                        for (children, 0..) |child, i| results[i] = self.specNode(address, message, child, depth + 1, visited) catch |err| switch (err) {
                            error.IsmDepthExceeded, error.IsmCountExceeded => return err,
                            else => if (metadata.hardFailure(err)) return err else null,
                        };
                    }
                    const parts = try self.allocator.alloc(?[]const u8, children.len);
                    defer self.allocator.free(parts);
                    @memset(parts, null);
                    var selected: usize = 0;
                    // Actual Rust prioritizes non-Null successes, then fills any
                    // remaining slots with Null. Empty non-Null bytes still count.
                    for ([_]bool{ false, true }) |want_null| {
                        for (children, results, 0..) |child, result, i| {
                            if (selected == aggregation.threshold) break;
                            if ((child == .null_metadata) != want_null) continue;
                            if (result) |bytes| {
                                parts[i] = bytes;
                                selected += 1;
                            }
                        }
                    }
                    if (selected < aggregation.threshold) return error.AggregationThresholdNotMet;
                    var len = try std.math.mul(usize, children.len, 8);
                    for (parts) |part| if (part) |bytes| {
                        len = try std.math.add(usize, len, bytes.len);
                    };
                    const out = try self.allocator.alloc(u8, len);
                    errdefer self.allocator.free(out);
                    _ = try protocol.metadata.encodeAggregation(parts, out);
                    break :blk out;
                },
            };
        }
    };
}

test "SVM composite inline selection prioritizes non-Null and checks identity" {
    const a = std.testing.allocator;
    const LocalOrigin = @import("../relayer/evm_source.zig").LocalOrigin;
    var origin: LocalOrigin = .{ .allocator = a, .leaves = &.{}, .stores = &.{} };
    var rpc = try @import("provider.zig").Client.init(a, "http://127.0.0.1:1", .{});
    defer rpc.deinit();
    var mailbox: @import("mailbox.zig").Mailbox = .{ .client = &rpc, .program = .{1} ** 32, .domain = 2, .payer = .{3} ** 32 };
    var source: Source(LocalOrigin) = .{ .allocator = a, .ism = .{ .mailbox = &mailbox, .identity = .{4} ** 32 }, .origin = &origin };
    const spec: ix.MetadataSpec = .{ .aggregation = .{ .threshold = 1, .children = &.{ .null_metadata, .{ .trusted_relayer = .{4} ** 32 }, .cannot_verify } } };
    const encoded = try source.buildSpec(.{1} ** 32, .{}, spec);
    defer a.free(encoded);
    const decoded = try protocol.metadata.Aggregation.decode(encoded, 3);
    try std.testing.expect((try decoded.metadataAt(0)) == null);
    try std.testing.expectEqual(@as(usize, 0), (try decoded.metadataAt(1)).?.len);
    try std.testing.expect((try decoded.metadataAt(2)) == null);
    source.ism.identity = mailbox.payer;
    try std.testing.expectError(error.CompositeTrustedRelayerMismatch, source.buildSpec(.{1} ** 32, .{}, .{ .trusted_relayer = .{3} ** 32 }));
    source.max_count = 1;
    try std.testing.expectError(error.IsmCountExceeded, source.buildSpec(.{1} ** 32, .{}, spec));
}

const RefusalOrigin = struct {
    calls: usize = 0,
    pub fn leafIndex(_: *@This(), _: Key) !?u32 {
        return 0;
    }
    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return 0;
    }
    pub fn fetchCheckpoint(_: *@This(), _: Address, _: u32) !?storage.SignedCheckpoint {
        return error.ValidatorReorg;
    }
    pub fn latestIndex(_: *@This(), _: Address) !?u32 {
        return 0;
    }
    pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.UnexpectedProof;
    }
    pub fn fetchQuorum(self: *@This(), _: A, _: []const Address, _: usize, _: u32, _: *usize, _: ?*const std.atomic.Value(bool)) anyerror!?quorum.Quorum {
        self.calls += 1;
        return error.ValidatorReorg;
    }
};
test "SVM inline composite late reorg refusal overrides an already satisfied threshold" {
    const a = std.testing.allocator;
    var origin: RefusalOrigin = .{};
    var provider = try @import("provider.zig").Client.init(a, "http://127.0.0.1:1", .{});
    defer provider.deinit();
    var mailbox: @import("mailbox.zig").Mailbox = .{ .client = &provider, .program = .{1} ** 32, .domain = 2, .payer = .{3} ** 32 };
    var source: Source(RefusalOrigin) = .{ .allocator = a, .ism = .{ .mailbox = &mailbox, .identity = .{4} ** 32 }, .origin = &origin };
    const spec: ix.MetadataSpec = .{ .aggregation = .{ .threshold = 1, .children = &.{ .{ .trusted_relayer = .{4} ** 32 }, .null_metadata, .{ .multisig_message_id = .{ .validators = &.{.{5} ** 20}, .threshold = 1 } } } } };
    try std.testing.expectError(error.ValidatorReorg, source.buildSpec(.{1} ** 32, .{}, spec));
    try std.testing.expectEqual(@as(usize, 1), origin.calls);
}
fn allocationScenario(a: A) !void {
    const LocalOrigin = @import("../relayer/evm_source.zig").LocalOrigin;
    var origin: LocalOrigin = .{ .allocator = a, .leaves = &.{}, .stores = &.{} };
    var provider = try @import("provider.zig").Client.init(a, "http://127.0.0.1:1", .{});
    defer provider.deinit();
    var mailbox: @import("mailbox.zig").Mailbox = .{ .client = &provider, .program = .{1} ** 32, .domain = 2, .payer = .{3} ** 32 };
    var source: Source(LocalOrigin) = .{ .allocator = a, .ism = .{ .mailbox = &mailbox, .identity = .{4} ** 32 }, .origin = &origin };
    const spec: ix.MetadataSpec = .{ .aggregation = .{ .threshold = 2, .children = &.{ .null_metadata, .{ .trusted_relayer = .{4} ** 32 }, .{ .aggregation = .{ .threshold = 1, .children = &.{ .null_metadata, .cannot_verify } } } } } };
    const bytes = try source.buildSpec(.{1} ** 32, .{}, spec);
    defer a.free(bytes);
    const decoded = try protocol.metadata.Aggregation.decode(bytes, 3);
    if ((try decoded.metadataAt(0)) != null or (try decoded.metadataAt(1)) == null or (try decoded.metadataAt(2)) == null) return error.UnexpectedSpecSelection;
}
test "SVM inline composite allocator ownership on every allocation failure" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationScenario, .{});
}
