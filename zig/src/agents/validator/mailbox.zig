//! One bounded durable request slot between independent checkpoint/announcement
//! jobs. Callbacks copy public bytes only. No mutable transaction owner is shared.
const std = @import("std");
const native = @import("../store.zig");
const DatabaseOwner = @import("../origin_tasks.zig").DatabaseOwner;
const objects = @import("../../storage/objects.zig");
const abi = @import("../../evm/codecs.zig");
const A = std.mem.Allocator;
const prefix = "zig_validator_announcement_mailbox_v1/";
const max_bytes = 2 * 1024 * 1024;
const Wire = struct { version: u8 = 1, revision: u64 = 0, kind: enum { ethereum, native }, digest: []const u8, target: ?[]const u8 = null, calldata: ?[]const u8 = null, signed_announcement: ?[]const u8 = null, complete: bool = false };
pub const Request = struct {
    arena: std.heap.ArenaAllocator,
    digest: [32]u8,
    wire: Wire,
    target: ?[20]u8,
    calldata: ?[]const u8,
    signed: ?objects.Decoded(objects.SignedAnnouncement),
    pub fn deinit(self: *Request) void {
        if (self.signed) |*signed| signed.deinit();
        self.arena.deinit();
    }
};
pub const Mailbox = struct {
    allocator: A,
    database: *DatabaseOwner,
    chain_name: []const u8,
    mutex: std.Thread.Mutex = .{},
    pending: std.atomic.Value(bool) = .init(true),
    pub fn read(self: *Mailbox, cancel: *const std.atomic.Value(bool)) !?Request {
        const database = try self.database.get(cancel);
        var storage = native.Store.init(self.allocator, database, self.chain_name);
        const bytes = try storage.typed.get(self.allocator, prefix, "request") orelse return null;
        defer self.allocator.free(bytes);
        return try self.decode(bytes);
    }
    fn decode(self: *Mailbox, bytes: []const u8) !Request {
        if (bytes.len == 0 or bytes.len > max_bytes) return error.InvalidAnnouncementMailbox;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        errdefer arena.deinit();
        const a = arena.allocator();
        const wire = (try std.json.parseFromSlice(Wire, a, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error" })).value;
        if (wire.version != 1) return error.InvalidAnnouncementMailbox;
        const digest = try abi.fixedHex(32, wire.digest);
        var signed: ?objects.Decoded(objects.SignedAnnouncement) = null;
        errdefer if (signed) |*value| value.deinit();
        var target: ?[20]u8 = null;
        var calldata: ?[]const u8 = null;
        switch (wire.kind) {
            .ethereum => {
                if (wire.target == null or wire.calldata == null or wire.signed_announcement != null) return error.InvalidAnnouncementMailbox;
                target = try abi.fixedHex(20, wire.target.?);
                const text = wire.calldata.?;
                if (!std.mem.startsWith(u8, text, "0x") or text.len < 10 or text.len % 2 != 0) return error.InvalidAnnouncementMailbox;
                calldata = try abi.decodeHex(try a.alloc(u8, (text.len - 2) / 2), text);
                _ = @import("../../evm/announce.zig").decodeAnnouncementCall(calldata.?) catch return error.InvalidAnnouncementMailbox;
            },
            .native => {
                if (wire.target != null or wire.calldata != null or wire.signed_announcement == null) return error.InvalidAnnouncementMailbox;
                signed = try objects.SignedAnnouncement.parse(self.allocator, wire.signed_announcement.?);
                if (!std.mem.eql(u8, &signed.?.value.value.digest(), &digest) or !std.mem.eql(u8, &try signed.?.value.recover(), &signed.?.value.value.validator)) return error.InvalidAnnouncementMailbox;
            },
        }
        return .{ .arena = arena, .digest = digest, .wire = wire, .target = target, .calldata = calldata, .signed = signed };
    }
    pub fn ethereum(self: *Mailbox, digest: [32]u8, target: [20]u8, calldata: []const u8, cancel: *const std.atomic.Value(bool)) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        try self.write(.{ .kind = .ethereum, .digest = try abi.hexAlloc(a, &digest), .target = try abi.hexAlloc(a, &target), .calldata = try abi.hexAlloc(a, calldata) }, cancel);
    }
    pub fn nativeAnnouncement(self: *Mailbox, announcement: objects.SignedAnnouncement, cancel: *const std.atomic.Value(bool)) !void {
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        try self.write(.{ .kind = .native, .digest = try abi.hexAlloc(a, &announcement.value.digest()), .signed_announcement = try announcement.toJson(a) }, cancel);
    }
    fn write(self: *Mailbox, wire: Wire, cancel: *const std.atomic.Value(bool)) !void {
        const bytes = try std.json.Stringify.valueAlloc(self.allocator, wire, .{});
        defer self.allocator.free(bytes);
        var validated = try self.decode(bytes);
        defer validated.deinit();
        self.mutex.lock();
        defer self.mutex.unlock();
        if (try self.read(cancel)) |value| {
            var previous = value;
            defer previous.deinit();
            if (std.mem.eql(u8, &previous.digest, &validated.digest)) {
                if (previous.wire.kind != wire.kind or !std.meta.eql(previous.target, validated.target)) return error.AnnouncementMailboxConflict;
                // Duplicate pending callbacks keep their first signature and
                // never wake a failed worker around its retry interval. A fresh
                // missing-location gate may reopen a previously completed goal.
                if (previous.wire.complete) {
                    previous.wire.revision = try std.math.add(u64, previous.wire.revision, 1);
                    previous.wire.complete = false;
                    const reopened = try std.json.Stringify.valueAlloc(self.allocator, previous.wire, .{});
                    defer self.allocator.free(reopened);
                    try self.store(reopened, cancel);
                    self.pending.store(true, .release);
                }
                return;
            }
            if (!previous.wire.complete) return error.AnnouncementMailboxFull;
        }
        try self.store(bytes, cancel);
        self.pending.store(true, .release);
    }
    fn store(self: *Mailbox, bytes: []const u8, cancel: *const std.atomic.Value(bool)) !void {
        const database = try self.database.get(cancel);
        var value = native.Store.init(self.allocator, database, self.chain_name);
        var batch = try value.typed.batch(self.allocator);
        defer batch.deinit();
        try batch.put(prefix, "request", bytes);
        try batch.commitSync();
    }
    pub fn completed(self: *Mailbox, digest: [32]u8, cancel: *const std.atomic.Value(bool)) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        var request = try self.read(cancel) orelse return;
        defer request.deinit();
        if (!std.mem.eql(u8, &request.digest, &digest) or request.wire.complete) return;
        request.wire.complete = true;
        const bytes = try std.json.Stringify.valueAlloc(self.allocator, request.wire, .{});
        defer self.allocator.free(bytes);
        try self.store(bytes, cancel);
        self.pending.store(true, .release);
    }
};

test "announcement mailbox rejects unknown shape selectors and oversized requests" {
    const a = std.testing.allocator;
    var mailbox: Mailbox = .{ .allocator = a, .database = undefined, .chain_name = "public" };
    const digest = try abi.hexAlloc(a, &@as([32]u8, @splat(1)));
    defer a.free(digest);
    const target = try abi.hexAlloc(a, &@as([20]u8, @splat(2)));
    defer a.free(target);
    const encoded = try @import("../../evm/announce.zig").announceCalldata(a, @splat(2), "public-location", @splat(1));
    defer a.free(encoded);
    const correct = try abi.hexAlloc(a, encoded);
    defer a.free(correct);
    const bytes = try std.json.Stringify.valueAlloc(a, Wire{ .kind = .ethereum, .digest = digest, .target = target, .calldata = correct }, .{});
    defer a.free(bytes);
    var request = try mailbox.decode(bytes);
    defer request.deinit();
    try std.testing.expectEqualSlices(u8, encoded, request.calldata.?);
    const wrong = try std.json.Stringify.valueAlloc(a, Wire{ .kind = .ethereum, .digest = digest, .target = target, .calldata = "0x00000000" }, .{});
    defer a.free(wrong);
    try std.testing.expectError(error.InvalidAnnouncementMailbox, mailbox.decode(wrong));
    const large = try a.alloc(u8, max_bytes + 1);
    defer a.free(large);
    try std.testing.expectError(error.InvalidAnnouncementMailbox, mailbox.decode(large));
}
test "native mailbox validates signature and allocation failures unwind decoded arenas" {
    const a = std.testing.allocator;
    const value: objects.Announcement = .{ .validator = .{ 0x19, 0xe7, 0xe3, 0x76, 0xe7, 0xc2, 0x13, 0xb7, 0xe7, 0xe7, 0xe4, 0x6c, 0xc7, 0x0a, 0x5d, 0xd0, 0x86, 0xda, 0xff, 0x2a }, .mailbox_address = @splat(1), .mailbox_domain = 3999999999, .storage_location = "file:///tmp/public-fixture" };
    const signed = try objects.SignedAnnouncement.sign(value, @splat(0x11), @splat(0));
    const json = try signed.toJson(a);
    defer a.free(json);
    const digest = try abi.hexAlloc(a, &value.digest());
    defer a.free(digest);
    const bytes = try std.json.Stringify.valueAlloc(a, Wire{ .kind = .native, .digest = digest, .signed_announcement = json }, .{});
    defer a.free(bytes);
    const S = struct {
        fn run(allocator: A, text: []const u8) !void {
            var mailbox: Mailbox = .{ .allocator = allocator, .database = undefined, .chain_name = "public" };
            var request = try mailbox.decode(text);
            defer request.deinit();
            try std.testing.expect(request.signed != null);
        }
    };
    try std.testing.checkAllAllocationFailures(a, S.run, .{bytes});
}
