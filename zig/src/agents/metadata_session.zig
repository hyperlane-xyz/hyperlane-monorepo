//! Per-fork cooperative checkpoint reads. Exact arguments plus occurrence retain
//! one Engine request/result across PendingReadIo replays; no caller stack lives here.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const objects = @import("../storage/objects.zig");
const remote = @import("../relayer/remote_checkpoints.zig");
const quorum = @import("../relayer/quorum.zig");
const budget = @import("../net/byte_budget.zig");
const A = std.mem.Allocator;
const Address = [20]u8;

pub fn Session(comptime Origin: type) type {
    return struct {
        const Self = @This();
        const Kind = enum(u8) { quorum, latest };
        const Entry = struct {
            key: [32]u8,
            occurrence: u32,
            kind: Kind,
            request: ?*remote.ReadRequest = null,
            discovery_done: bool = false,
            done: bool = false,
            quorum: ?quorum.Quorum = null,
            latest: ?[]?u32 = null,
            storage_errors: usize = 0,
            bytes: usize = 0,

            fn deinit(self: *Entry, session: *Self) void {
                if (self.request) |request| request.deinit();
                if (self.quorum) |*found| found.deinit();
                if (self.latest) |latest| session.allocator.free(latest);
                session.releaseBytes(self.bytes);
                self.* = undefined;
            }
        };

        allocator: A,
        origin: *Origin,
        cancel: *const std.atomic.Value(bool),
        shared_budget: ?*budget.Budget = null,
        max_entries: usize = 512,
        max_cached_bytes: usize = 8 * 1024 * 1024,
        cached_bytes: usize = 0,
        entries: std.ArrayList(Entry) = .empty,
        occurrences: std.AutoHashMapUnmanaged([32]u8, u32) = .empty,
        in_pass: bool = false,

        pub fn init(allocator: A, origin: *Origin, cancel: *const std.atomic.Value(bool)) Self {
            return .{ .allocator = allocator, .origin = origin, .cancel = cancel };
        }

        pub fn deinit(self: *Self) void {
            self.clear();
            self.entries.deinit(self.allocator);
            self.occurrences.deinit(self.allocator);
            self.* = undefined;
        }

        pub fn beginPass(self: *Self, cancel: ?*const std.atomic.Value(bool)) !void {
            if (self.in_pass) return error.MetadataSessionPassAlreadyActive;
            if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            self.occurrences.clearRetainingCapacity();
            self.in_pass = true;
        }

        pub fn endPass(self: *Self, failure: ?anyerror) void {
            self.in_pass = false;
            if (failure) |err| if (err == error.PendingReadIo) return;
            self.clear();
        }

        fn clear(self: *Self) void {
            for (self.entries.items) |*entry| entry.deinit(self);
            self.entries.clearRetainingCapacity();
            self.occurrences.clearRetainingCapacity();
            self.cached_bytes = 0;
        }

        fn reserveBytes(self: *Self, bytes: usize) !void {
            if (bytes > self.max_cached_bytes -| self.cached_bytes) return error.MetadataSessionByteBudgetExceeded;
            if (self.shared_budget) |shared| try shared.reserve(bytes);
            self.cached_bytes += bytes;
        }

        fn retainBytes(self: *Self, entry: *Entry, bytes: usize) !void {
            try self.reserveBytes(bytes);
            entry.bytes = bytes;
        }

        fn releaseBytes(self: *Self, bytes: usize) void {
            std.debug.assert(bytes <= self.cached_bytes);
            if (self.shared_budget) |shared| shared.release(bytes);
            self.cached_bytes -= bytes;
        }

        fn key(self: *Self, kind: Kind, validators: []const Address, threshold: usize, index: u32) [32]u8 {
            var hash = std.crypto.hash.sha2.Sha256.init(.{});
            hash.update(&.{@intFromEnum(kind)});
            var number: [8]u8 = undefined;
            std.mem.writeInt(u64, &number, self.origin.domain, .big);
            hash.update(&number);
            std.mem.writeInt(u64, &number, threshold, .big);
            hash.update(&number);
            std.mem.writeInt(u32, number[0..4], index, .big);
            hash.update(number[0..4]);
            for (validators) |validator| hash.update(&validator);
            return hash.finalResult();
        }

        fn findEntry(self: *Self, kind: Kind, validators: []const Address, threshold: usize, index: u32) !*Entry {
            if (!self.in_pass) return error.MetadataSessionPassNotActive;
            if (self.cancel.load(.acquire)) return error.RequestCancelled;
            const identity = self.key(kind, validators, threshold, index);
            const occurrence = try self.occurrences.getOrPut(self.allocator, identity);
            if (!occurrence.found_existing) occurrence.value_ptr.* = 0;
            const current = occurrence.value_ptr.*;
            occurrence.value_ptr.* = std.math.add(u32, current, 1) catch return error.MetadataSessionOccurrenceLimit;
            for (self.entries.items) |*candidate| {
                if (candidate.kind == kind and candidate.occurrence == current and std.mem.eql(u8, &candidate.key, &identity)) return candidate;
            }
            if (self.entries.items.len >= self.max_entries) return error.MetadataSessionEntryLimit;
            try self.entries.ensureUnusedCapacity(self.allocator, 1);
            self.entries.appendAssumeCapacity(.{ .key = identity, .occurrence = current, .kind = kind });
            return &self.entries.items[self.entries.items.len - 1];
        }

        fn discover(self: *Self, entry: *Entry, validators: []const Address) !void {
            if (entry.discovery_done) return;
            if (self.origin.discovery) |discovery| try discovery.ensure(discovery.context, validators, self.cancel);
            entry.discovery_done = true;
        }

        pub fn fetchQuorum(self: *Self, allocator: A, validators: []const Address, threshold: usize, index: u32, errors: *usize) !?quorum.Quorum {
            const entry = try self.findEntry(.quorum, validators, threshold, index);
            try self.discover(entry, validators);
            if (!entry.done) {
                if (self.origin.checkpoint_pool) |engine| {
                    if (entry.request == null) {
                        entry.request = engine.submitQuorum(self.origin.domain, self.allocator, validators, threshold, index) catch |err| switch (err) {
                            error.RemoteCheckpointSessionsFull => return error.PendingReadIo,
                            else => return err,
                        };
                    }
                    switch (try entry.request.?.poll(self.cancel)) {
                        .pending => return error.PendingReadIo,
                        .latest => return error.WrongRemoteReadKind,
                        .quorum => |found| {
                            entry.quorum = found;
                            entry.storage_errors = entry.request.?.storage_errors;
                            const bytes = if (found) |value| value.signatures.len * 65 else 0;
                            entry.request.?.deinit();
                            entry.request = null;
                            try self.retainBytes(entry, bytes);
                            entry.done = true;
                        },
                    }
                } else entry.done = true;
            }
            errors.* += entry.storage_errors;
            const found = entry.quorum orelse return null;
            return @as(?quorum.Quorum, try cloneQuorum(allocator, found));
        }

        pub fn fetchLatestIndices(self: *Self, validators: []const Address, output: []?u32, errors: *usize) !void {
            if (output.len != validators.len) return error.InvalidLatestIndicesLength;
            const entry = try self.findEntry(.latest, validators, 0, 0);
            try self.discover(entry, validators);
            if (!entry.done) {
                if (self.origin.checkpoint_pool) |engine| {
                    if (entry.request == null) {
                        entry.request = engine.submitLatest(self.origin.domain, validators) catch |err| switch (err) {
                            error.RemoteCheckpointSessionsFull => return error.PendingReadIo,
                            else => return err,
                        };
                    }
                    switch (try entry.request.?.poll(self.cancel)) {
                        .pending => return error.PendingReadIo,
                        .quorum => return error.WrongRemoteReadKind,
                        .latest => |latest| {
                            const owned = try self.allocator.dupe(?u32, latest);
                            entry.latest = owned;
                            entry.storage_errors = entry.request.?.storage_errors;
                            const bytes = owned.len * @sizeOf(?u32);
                            entry.request.?.deinit();
                            entry.request = null;
                            try self.retainBytes(entry, bytes);
                            entry.done = true;
                        },
                    }
                } else {
                    entry.latest = try self.allocator.alloc(?u32, validators.len);
                    @memset(entry.latest.?, null);
                    try self.retainBytes(entry, validators.len * @sizeOf(?u32));
                    entry.done = true;
                }
            }
            errors.* += entry.storage_errors;
            @memcpy(output, entry.latest orelse return error.MetadataSessionResultMissing);
        }

        pub fn fetchCheckpoint(self: *Self, validator: Address, index: u32) !?objects.SignedCheckpoint {
            var errors: usize = 0;
            var found = (try self.fetchQuorum(self.allocator, &.{validator}, 1, index, &errors)) orelse return null;
            defer found.deinit();
            return .{ .value = found.checkpoint, .signature = found.signatures[0] };
        }

        pub fn latestIndex(self: *Self, validator: Address) !?u32 {
            var output: [1]?u32 = undefined;
            var errors: usize = 0;
            try self.fetchLatestIndices(&.{validator}, &output, &errors);
            return output[0];
        }

        pub fn proof(self: *Self, index: u32, checkpoint: protocol.Checkpoint) !protocol.Proof {
            return self.origin.proof(index, checkpoint);
        }

        pub fn leafIndex(self: *Self, id: [32]u8) !?u32 {
            return self.origin.leafIndex(id);
        }

        pub fn highestKnownLeafIndex(self: *Self) !?u32 {
            return self.origin.highestKnownLeafIndex();
        }
    };
}

fn cloneQuorum(allocator: A, found: quorum.Quorum) !quorum.Quorum {
    return .{
        .checkpoint = found.checkpoint,
        .signatures = try allocator.dupe(objects.Signature, found.signatures),
        .allocator = allocator,
    };
}

test "rejected checkpoint cache reservation never releases another session's quota" {
    const Fake = struct { domain: u32 = 1 };
    const S = Session(Fake);
    var origin: Fake = .{};
    var cancel = std.atomic.Value(bool).init(false);
    var shared: budget.Budget = .{ .maximum = 4 };
    var session = S.init(std.testing.allocator, &origin, &cancel);
    defer session.deinit();
    session.shared_budget = &shared;
    try shared.reserve(3);
    var entry: S.Entry = .{ .key = @splat(0), .occurrence = 0, .kind = .latest };
    entry.latest = try std.testing.allocator.alloc(?u32, 1);
    try std.testing.expectError(error.ReadReplayGlobalByteBudgetExceeded, session.retainBytes(&entry, 2));
    try std.testing.expectEqual(@as(usize, 0), entry.bytes);
    entry.deinit(&session);
    try std.testing.expectEqual(@as(usize, 3), shared.used);
    try std.testing.expectEqual(@as(usize, 0), session.cached_bytes);
    shared.release(3);
    session.max_cached_bytes = 1;
    var local: S.Entry = .{ .key = @splat(0), .occurrence = 0, .kind = .quorum };
    try std.testing.expectError(error.MetadataSessionByteBudgetExceeded, session.retainBytes(&local, 2));
    local.deinit(&session);
    try std.testing.expectEqual(@as(usize, 0), shared.used);
}
